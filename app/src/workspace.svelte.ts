// The state of the whole work session and what can be done with it. Components only
// show it and call its methods. The `.svelte.ts` ending lets this file use runes
// (`$state`) outside of a component: everything declared with `$state` here updates
// whatever shows it, wherever that is.

import { addFile, readField, readValue, removeFile, setField, ulid, validateObjectYaml, type FileEntry } from '@tamandua/core'
import type { Agent, ToolCall } from './agent.js'
import * as db from './db.js'
import { FIELD_NAMES, objectLabel } from './labels.js'
import { prepareFile } from './prepare.js'
import { newObjectText } from './template.js'
import type { FileStore } from './uploader.js'
import { SignedOut } from './api.js'
import type { Backend, User } from './backend.js'

/** A file that was dropped and hashed. It is identified by its SHA-256. */
export interface FileRecord {
  sha256: string
  name: string
  bytes: number
  /** The entry that goes into `files` of an object's YAML. */
  entry: FileEntry
  preview?: Blob
  status: 'uploading' | 'uploaded' | 'conflict' | 'error'
  /** What to tell the user for a conflict or an error. */
  message?: string
  /** 0 to 1 while uploading; not stored. */
  progress?: number
  /** The object this file belongs to, if there is one. */
  objectId?: string
  addedAt: number
}

export interface ObjectRecord {
  id: string
  /** Running number, shown on the tiles together with the object's color. */
  number: number
  text: string
  updatedAt: number
  /** The text as it is on the person's branch in the data repository; none if it never got there. */
  synced?: string
  /** What happened to the saved text since: it waits on the branch, is in a pull request, or was accepted. */
  stage?: 'saved' | 'submitted' | 'merged'
  /** The pull request it is part of, while `stage` is `submitted`. */
  pull?: number
}

/** Where an object stands, for the badge on its row. */
export type Standing = 'local' | 'changed' | 'saved' | 'submitted' | 'merged'

export type Session =
  | { state: 'loading' }
  | { state: 'anonymous'; notice?: string }
  | { state: 'user'; user: User }
  | { state: 'error'; message: string }

/**
 * When objects are saved to GitHub: a second after the last change the app itself made (an object was
 * created, the agent set fields, files were moved; one commit per answer of the agent), 30 seconds after
 * the last change the person typed in the editor, and a minute after a failure.
 */
const APP_DELAY = 1_000
const TYPING_DELAY = 30_000
const SYNC_RETRY = 60_000

/** A file that is still being hashed, or could not be read. */
export interface Pending {
  name: string
  state: 'hashing' | 'error'
  progress: number
  message?: string
}

export interface ChatMessage {
  /**
   * `user` and `assistant` are the conversation. `status` is a notice to the user (something was
   * refused, a field was not changed). `log` is the record of what the app did (uploads, objects
   * created, fields set); it is kept but not shown in the chat.
   */
  role: 'user' | 'assistant' | 'status' | 'log'
  text: string
}

/** One drop of files. One status message in the chat reports on all of them. */
interface Batch {
  total: number
  uploaded: number
  conflicts: string[]
  failed: string[]
  duplicates: string[]
  message: ChatMessage
  /** The files of this drop that exist now; they get selected when the drop is done. */
  shas: string[]
  /** Files that are hashed (or could not be read). */
  processed: number
  /** Files that could not be read at all. */
  unreadable: string[]
  /** Why uploads failed, for the message to the user. */
  reasons: string[]
  listedTold?: boolean
  doneTold?: boolean
  /** Files dropped onto an object also go into it. */
  objectId?: string
}

const show = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(show).join(', ')
  if (typeof value === 'object' && value !== null) {
    const { name, location } = value as { name?: unknown; location?: unknown }
    return [name, location].filter((x) => typeof x === 'string' && x).join(', ') || JSON.stringify(value)
  }
  return String(value ?? '')
}
/** What happened to one object while tool calls were carried out. */
interface Change {
  created?: string
  set: string[]
  kept: string[]
  /** Points that were set, in words for the user. */
  points: string[]
}
/** The result of carrying out tool calls: `log` is what was done, `changes` is what the user is told. */
interface Out {
  log: string[]
  changes: Map<ObjectRecord, Change>
  notes: string[]
}

/** "Datei „a.jpg“" or "3 Dateien" (for the log). */
const count = (list: string[]): string => (list.length === 1 ? `Datei „${list[0]}“` : `${list.length} Dateien`)
/** "die Datei „a.jpg“" or "3 Dateien" (for the conversation). */
const them = (list: string[]): string => (list.length === 1 ? `die Datei „${list[0]}“` : `${list.length} Dateien`)
const names = (list: string[]): string => `(${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''})`

/** How the app speaks of an object: by its title if it has one, else by its number. */
function refer(object: ObjectRecord): string {
  const title = readField(object.text, 'title')
  return typeof title === 'string' && title ? `Objekt „${title}“` : `Objekt ${object.number}`
}

/** What is still missing in an object, in words for the user. */
function missing(text: string): string[] {
  const found = validateObjectYaml(text).map((issue) => /missing field "(\w+)"/.exec(issue.message)?.[1] ?? issue.path.split('/')[1] ?? '')
  return [...new Set(found.filter(Boolean))].map((field) => FIELD_NAMES[field] ?? field)
}

/** Six decimals are about ten centimeters: plenty. */
const round = (x: number): number => Math.round(x * 1e6) / 1e6

const PRECISION_NAMES: Record<string, string> = { exact: 'genau', street: 'auf die Straße genau', town: 'auf den Ort genau', region: 'nur ungefähr' }

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true })

export class Workspace {
  files = $state<FileRecord[]>([])
  objects = $state<ObjectRecord[]>([])
  pending = $state<Pending[]>([])
  chat = $state<ChatMessage[]>([])
  /** True while the agent is working on a message. */
  busy = $state(false)
  /** Counts up when the chat input should take the keyboard focus. */
  focusTick = $state(0)
  /** SHA-256 of the selected files. */
  selection = $state<string[]>([])
  /** True when the user picked several files by hand (shift or cmd click); only then are they dragged together. */
  picked = $state(false)
  /** The last file clicked; its object is shown in the editor. */
  active = $state<string>()
  saveState = $state<'saved' | 'saving' | 'failed'>('saved')
  /** SHA-256 of the files being dragged to an object or out of one; empty when nothing is dragged. */
  dragging = $state<string[]>([])
  /** The object whose row is under the dragged tiles, if any. */
  dragTarget = $state<string>()

  session = $state<Session>({ state: 'loading' })
  /** Saving to GitHub: `failed` is shown to the person, with the reason in `syncError`. */
  syncState = $state<'idle' | 'saving' | 'failed'>('idle')
  syncError = $state<string>()
  /** True while the pull request is being opened. */
  submitting = $state(false)

  #store: FileStore
  #agent: Agent
  #backend: Backend
  #appTimer: ReturnType<typeof setTimeout> | undefined
  #typingTimer: ReturnType<typeof setTimeout> | undefined
  #removedFiles = new Set<string>()
  #syncing = false
  #syncAgain = false
  #anchor: string | undefined
  #queue: { file: File; batch: Batch }[] = []
  #busy = false
  #dirtyFiles = new Set<string>()
  #dirtyObjects = new Set<string>()
  #removedObjects = new Set<string>()
  #dirtyChat = false
  #dirtyUi = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(store: FileStore, agent: Agent, backend: Backend) {
    this.#store = store
    this.#agent = agent
    this.#backend = backend
  }

  /** The files a chat message is about: the selected ones. Only the user selects. */
  get target(): FileRecord[] {
    return this.files.filter((f) => this.selection.includes(f.sha256))
  }

  /** The object of the active file, if it has one. */
  get activeObject(): ObjectRecord | undefined {
    const file = this.files.find((f) => f.sha256 === this.active)
    return file?.objectId ? this.objects.find((o) => o.id === file.objectId) : undefined
  }

  async load() {
    try {
      const [files, objects, chat, ui] = await Promise.all([db.loadFiles(), db.loadObjects(), db.loadChat(), db.loadUi()])
      this.chat = chat
      for (const file of files) {
        if (file.status === 'uploading') {
          // The browser was closed during the upload; the file itself is gone.
          file.status = 'error'
          file.message = 'Upload unterbrochen. Datei bitte erneut hierher ziehen.'
          this.#dirtyFiles.add(file.sha256)
        }
      }
      this.files = files.sort((a, b) => a.addedAt - b.addedAt)
      this.objects = objects
      if (ui) {
        // Selection and open object as the user left them, as far as the files still exist.
        const known = new Set(files.map((f) => f.sha256))
        this.selection = ui.selection.filter((sha) => known.has(sha))
        this.active = ui.active && known.has(ui.active) ? ui.active : undefined
        this.#anchor = this.selection[0]
      }
      this.#schedule()
    } catch {
      this.saveState = 'failed'
    }
  }

  // --- dropping files: hash one after the other, upload in the background ---

  /** Files from outside. Dropped onto an object (`objectId`), they are also put into it. */
  addDropped(list: Iterable<File>, objectId?: string) {
    const files = [...list].sort(byName) // scans are usually numbered: natural order by name
    if (files.length === 0) return
    const message = this.#say('log', '')
    const batch: Batch = { total: files.length, uploaded: 0, conflicts: [], failed: [], duplicates: [], message, objectId, shas: [], processed: 0, unreadable: [], reasons: [] }
    this.#report(batch)
    this.#queue.push(...files.map((file) => ({ file, batch })))
    void this.#run()
  }

  /** Keeps the one status message of a drop up to date. */
  #report(batch: Batch) {
    const done = batch.uploaded + batch.conflicts.length + batch.failed.length + batch.duplicates.length
    const parts: string[] = []
    if (batch.uploaded) parts.push(`${batch.uploaded} hochgeladen`)
    if (batch.conflicts.length) parts.push(`${batch.conflicts.length} Konflikt ${names(batch.conflicts)}`)
    if (batch.failed.length) parts.push(`${batch.failed.length} fehlgeschlagen ${names(batch.failed)}`)
    if (batch.duplicates.length) parts.push(`${batch.duplicates.length} schon vorhanden ${names(batch.duplicates)}`)
    if (done < batch.total) parts.push(`${batch.total - done} in Arbeit`)
    batch.message.text = `${batch.total} ${batch.total === 1 ? 'Datei' : 'Dateien'} abgelegt: ${parts.join(', ')}`
    this.#markChat()
    if (batch.processed === batch.total && !batch.listedTold) this.#listed(batch)
    if (done === batch.total && !batch.doneTold) this.#uploaded(batch)
  }

  /**
   * Once every file of a drop is hashed (it is listed, selectable and has its `files` entry),
   * the user can start describing it; the uploads go on in the background.
   */
  #listed(batch: Batch) {
    batch.listedTold = true
    const sentences: string[] = []
    const fresh = batch.shas.length - batch.duplicates.length
    if (fresh > 0 && !batch.objectId) {
      sentences.push(`Du hast ${fresh === 1 ? 'eine Datei' : `${fresh} Dateien`} abgelegt, ${fresh === 1 ? 'sie wird' : 'sie werden'} gerade hochgeladen.`)
    }
    if (batch.duplicates.length) {
      const one = batch.duplicates.length === 1
      sentences.push(one ? `Die Datei „${batch.duplicates[0]}“ war schon vorhanden.` : `${batch.duplicates.length} Dateien waren schon vorhanden.`)
    }
    if (batch.unreadable.length) sentences.push(`${them(batch.unreadable)} ${batch.unreadable.length === 1 ? 'konnte' : 'konnten'} nicht gelesen werden ${names(batch.unreadable)}.`)
    if (fresh > 0 && !batch.objectId) sentences.push('Möchtest du sie jetzt beschreiben?')
    if (sentences.length) this.#say('assistant', sentences.join(' '))
    if (!batch.objectId && batch.shas.length > 0) {
      // Dropping is a deliberate act: the dropped files become the selection, whatever was selected before.
      this.picked = false
      this.selection = [...batch.shas]
      this.#anchor = batch.shas[0]
      this.active = batch.shas[0]
      this.#markUi()
      this.focusTick++
    }
  }

  /** When the last upload of a drop is done: only problems are worth a message. */
  #uploaded(batch: Batch) {
    batch.doneTold = true
    const failed = batch.failed.filter((name) => !batch.unreadable.includes(name))
    const sentences: string[] = []
    if (batch.conflicts.length) sentences.push(`Beim Hochladen gab es bei ${them(batch.conflicts)} einen Konflikt ${names(batch.conflicts)}.`)
    if (failed.length) sentences.push(`${them(failed)} ${failed.length === 1 ? 'konnte' : 'konnten'} nicht hochgeladen werden ${names(failed)}.`)
    // Why it failed (no server, refused, ...) is what the user needs to know or to pass on.
    if (failed.length && batch.reasons.length) sentences.push(`Grund: ${[...new Set(batch.reasons)].join(' ')}`)
    if (sentences.length) this.#say('assistant', sentences.join(' '))
  }

  async #run() {
    if (this.#busy) return
    this.#busy = true
    for (let next = this.#queue.shift(); next; next = this.#queue.shift()) await this.#ingest(next.file, next.batch)
    this.#busy = false
  }

  async #ingest(file: File, batch: Batch) {
    this.pending.push({ name: file.name, state: 'hashing', progress: 0 })
    const item = this.pending[this.pending.length - 1] // the reactive version
    try {
      const { entry, preview } = await prepareFile(file, (fraction) => (item.progress = fraction))
      const sha256 = entry.sha256 as string
      const existing = this.files.find((f) => f.sha256 === sha256)
      let record: FileRecord
      if (existing && existing.status !== 'error') {
        batch.duplicates.push(file.name)
        record = existing
      } else if (existing) {
        void this.#upload(existing, file, batch) // try again after an error
        record = existing
      } else {
        this.files.push({ sha256, name: file.name, bytes: file.size, entry, preview, status: 'uploading', addedAt: Date.now() })
        record = this.files[this.files.length - 1]
        void this.#upload(record, file, batch)
      }
      batch.shas.push(record.sha256)
      if (batch.objectId) this.#putInto(record, batch.objectId)
      this.pending = this.pending.filter((p) => p !== item)
    } catch (error) {
      item.state = 'error'
      item.message = (error as Error).message
      batch.failed.push(file.name)
      batch.unreadable.push(file.name)
    }
    batch.processed++
    this.#report(batch)
  }

  async #upload(record: FileRecord, file: File, batch: Batch) {
    record.status = 'uploading'
    record.message = undefined
    record.progress = 0
    this.#mark(record.sha256)
    try {
      const result = await this.#store.upload(file, $state.snapshot(record.entry), (fraction) => (record.progress = fraction), record.preview)
      record.status = result.status
      record.message = result.message
    } catch (error) {
      record.status = 'error'
      record.message = (error as Error).message
      batch.reasons.push(record.message)
    }
    record.progress = undefined
    this.#mark(record.sha256)
    if (record.status === 'uploaded') batch.uploaded++
    else if (record.status === 'conflict') batch.conflicts.push(record.name)
    else batch.failed.push(record.name)
    this.#report(batch)
  }

  dismissPending(item: Pending) {
    this.pending = this.pending.filter((p) => p !== item)
  }

  // --- selecting ---

  select(sha256: string, { range = false, toggle = false } = {}) {
    this.picked = range || toggle
    if (range && this.#anchor) {
      const from = this.files.findIndex((f) => f.sha256 === this.#anchor)
      const to = this.files.findIndex((f) => f.sha256 === sha256)
      const [low, high] = from < to ? [from, to] : [to, from]
      this.selection = this.files.slice(low, high + 1).map((f) => f.sha256)
    } else if (toggle) {
      this.selection = this.selection.includes(sha256) ? this.selection.filter((s) => s !== sha256) : [...this.selection, sha256]
      this.#anchor = sha256
    } else {
      this.selection = [sha256]
      this.#anchor = sha256
    }
    this.active = sha256
    this.#markUi()
    this.focusTick++ // typing goes to the chat from here on
  }

  /** Selects all files of an object and shows it. This is what a click on the object's row does. */
  activate(objectId: string) {
    const files = this.files.filter((f) => f.objectId === objectId)
    if (files.length === 0) return
    this.selection = files.map((f) => f.sha256)
    this.picked = false // the object's files are selected, but dragging one tile moves only that one
    this.#anchor = files[0].sha256
    this.active = files[0].sha256
    this.#markUi()
    this.focusTick++
  }

  /** Closes the open object. The selection stays. */
  collapse() {
    this.active = undefined
    this.#markUi()
    this.focusTick++
  }

  // --- rearranging: files go into an object, or come out of it ---

  /** A file dropped from outside onto an object: it goes in, unless it already belongs to an object. */
  #putInto(record: FileRecord, objectId: string) {
    if (record.objectId === objectId) return
    if (record.objectId) {
      const owner = this.objects.find((o) => o.id === record.objectId)
      if (owner) this.#say('assistant', `Die Datei „${record.name}“ gehört schon zu ${refer(owner)}. Zieh sie dort heraus, wenn du sie verschieben willst.`)
      return
    }
    this.attach([record.sha256], objectId)
  }

  /** Puts files into an object. A file that belongs to another object is moved. */
  attach(shas: string[], objectId: string) {
    const target = this.objects.find((o) => o.id === objectId)
    const files = this.files.filter((f) => shas.includes(f.sha256) && f.objectId !== objectId).sort(byName)
    if (!target || files.length === 0) return
    if (readField(target.text, 'type') === 'image' && this.files.some((f) => f.objectId === objectId)) {
      this.#say('log', `Objekt ${target.number} ist ein Bild und hat schon eine Datei.`)
      return
    }

    const log: string[] = []
    const notes: string[] = []
    const added: string[] = []
    const moved = new Map<ObjectRecord, string[]>()
    const emptied = new Set<ObjectRecord>()
    for (const file of files) {
      const from = this.objects.find((o) => o.id === file.objectId)
      try {
        // Compute both new texts first, so that nothing is half done if one of them fails.
        const text = addFile(target.text, $state.snapshot(file.entry))
        const fromText = from ? removeFile(from.text, file.sha256) : undefined
        if (from && fromText !== undefined) this.#leave(file, from, fromText, emptied)
        target.text = text
        target.updatedAt = Date.now()
        this.#markObject(target.id)
        file.objectId = objectId
        this.#mark(file.sha256)
        if (from) moved.set(from, [...(moved.get(from) ?? []), file.name])
        else added.push(file.name)
      } catch (error) {
        notes.push(`Objekt ${target.number}: ${(error as Error).message}`)
      }
    }

    const told: string[] = []
    if (added.length) {
      log.unshift(`${count(added)} zu Objekt ${target.number} hinzugefügt.`)
      told.push(`Du hast ${them(added)} zu ${refer(target)} hinzugefügt.`)
    }
    for (const [from, list] of moved) {
      log.push(`${count(list)} von Objekt ${from.number} nach Objekt ${target.number} verschoben.`)
      told.push(`Du hast ${them(list)} von ${refer(from)} nach ${refer(target)} verschoben.`)
    }
    this.#discard(emptied, log, told)
    if (log.length) this.#say('log', log.join('\n'))
    if (told.length || notes.length) this.#say('assistant', [...told, ...notes].join(' '))
    this.activate(objectId)
  }

  /** Takes files out of their objects. An object without files is deleted. */
  detach(shas: string[]) {
    const files = this.files.filter((f) => shas.includes(f.sha256) && f.objectId)
    if (files.length === 0) return
    const log: string[] = []
    const notes: string[] = []
    const emptied = new Set<ObjectRecord>()
    const freed: FileRecord[] = []
    const from = new Map<ObjectRecord, string[]>()
    for (const file of files) {
      const object = this.objects.find((o) => o.id === file.objectId)
      if (!object) continue
      try {
        this.#leave(file, object, removeFile(object.text, file.sha256), emptied)
        freed.push(file)
        from.set(object, [...(from.get(object) ?? []), file.name])
      } catch (error) {
        notes.push(`Objekt ${object.number}: ${(error as Error).message}`)
      }
    }
    const told: string[] = []
    for (const [object, list] of from) {
      log.unshift(`${count(list)} aus Objekt ${object.number} herausgenommen.`)
      told.push(`Du hast ${them(list)} aus dem ${refer(object)} herausgenommen.`)
    }
    this.#discard(emptied, log, told)
    if (log.length) this.#say('log', log.join('\n'))
    if (told.length || notes.length) this.#say('assistant', [...told, ...notes].join(' '))
    if (freed.length) {
      this.picked = false
      this.selection = freed.map((f) => f.sha256)
      this.#anchor = freed[0].sha256
      this.active = freed[0].sha256
      this.#markUi()
      this.focusTick++
    }
  }

  /** The file leaves its object; `text` is the object's new YAML. Notes the object if it has no file left. */
  #leave(file: FileRecord, from: ObjectRecord, text: string, emptied: Set<ObjectRecord>) {
    from.text = text
    from.updatedAt = Date.now()
    this.#markObject(from.id)
    file.objectId = undefined
    this.#mark(file.sha256)
    if (!this.files.some((f) => f.objectId === from.id)) emptied.add(from)
  }

  #discard(emptied: Set<ObjectRecord>, lines: string[], told: string[]) {
    for (const object of emptied) {
      told.push(`${refer(object)} hat keine Dateien mehr und wurde gelöscht.`)
      this.objects = this.objects.filter((o) => o.id !== object.id)
      this.#dirtyObjects.delete(object.id)
      this.#removedObjects.add(object.id)
      lines.push(`Objekt ${object.number} hat keine Dateien mehr und wurde gelöscht.`)
    }
    if (emptied.size > 0) this.#schedule()
  }

  // --- chat: the user writes, the agent answers with tool calls, the workspace carries them out ---

  #say(role: ChatMessage['role'], text: string): ChatMessage {
    this.chat.push({ role, text })
    this.#markChat()
    return this.chat[this.chat.length - 1] // the reactive version, so later changes show
  }

  async send(text: string) {
    text = text.trim()
    if (!text || this.busy) return
    // The conversation so far, before this message (notices count as the app's side; the log is left out).
    const history = this.chat
      .filter((m) => m.role !== 'log')
      .slice(-12)
      .filter((m) => m.text)
      .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), text: m.text }))
    this.#say('user', text)
    const target = this.target
    const selected = [...new Set(target.map((f) => f.objectId))].flatMap((id) => this.objects.filter((o) => o.id === id))
    const objects = selected.map((o) => ({
      number: o.number,
      text: o.text,
      issues: validateObjectYaml(o.text).map((i) => `${i.path} ${i.message}`),
    }))
    const numberOf = (id?: string) => this.objects.find((o) => o.id === id)?.number

    this.busy = true
    try {
      const calls = await this.#agent.respond({
        message: text,
        files: target.map((f) => ({ sha256: f.sha256, name: f.name, object: numberOf(f.objectId) })),
        objects,
        history,
      })
      this.#execute(calls, target)
    } catch (error) {
      this.#say('assistant', `Das hat nicht geklappt: ${(error as Error).message}`)
    }
    this.busy = false
    this.focusTick++
  }

  #execute(calls: ToolCall[], target: FileRecord[]) {
    // What happened goes to the log, what the user must know goes to the chat.
    // One answer per message: what the app did first, then what the model says.
    const out: Out = { log: [], changes: new Map(), notes: [] }
    const said: string[] = []
    const touched: ObjectRecord[] = []

    for (const call of calls) {
      try {
        if (call.tool === 'say') {
          said.push(call.text)
        } else if (call.tool === 'set_geocode') {
          const object = this.#geocode(call, out)
          if (object) touched.push(object)
        } else if (call.tool === 'create_object') {
          touched.push(...this.#create(call, target, out))
        } else {
          const object = this.#patch(call, out)
          if (object) touched.push(object)
        }
      } catch (error) {
        out.notes.push((error as Error).message)
      }
    }
    if (out.log.length > 0) this.#say('log', out.log.join('\n'))
    const told = [...this.#describe(out.changes), ...out.notes]
    const answer = [told.join(' '), ...said].filter(Boolean).join('\n\n')
    if (answer) this.#say('assistant', answer)
    if (touched.length > 0) this.#settle([...new Set(touched)])
  }

  /** A point from the map service goes onto the object's location, an entity of it, or one of its subjects. */
  #geocode(call: Extract<ToolCall, { tool: 'set_geocode' }>, out: Out): ObjectRecord | undefined {
    const object = this.objects.find((o) => o.number === call.object)
    if (!object) {
      out.notes.push(`Objekt ${call.object} gibt es nicht.`)
      return undefined
    }
    const point = { lat: round(call.lat), lon: round(call.lon), precision: call.precision, source: call.source }
    let field: string
    let value: unknown
    let old: unknown
    let where: string
    if (call.for === 'object') {
      field = 'geocode'
      old = readValue(object.text, 'geocode')
      value = point
      where = FIELD_NAMES.location
    } else if (call.for === 'subject') {
      field = 'subjects'
      const list = readValue(object.text, 'subjects')
      const wanted = (call.subject ?? '').trim().toLowerCase()
      const index = Array.isArray(list) ? list.findIndex((s) => String((s as { name?: unknown })?.name ?? '').trim().toLowerCase() === wanted) : -1
      if (!Array.isArray(list) || index < 0) {
        out.notes.push(`${refer(object)}: Einen Bezug „${call.subject}“ gibt es nicht, deshalb habe ich keine Koordinaten gesetzt.`)
        return undefined
      }
      old = list
      value = list.map((s, i) => (i === index ? { ...(s as object), geocode: point } : s))
      where = `Bezug „${(list[index] as { name: string }).name}“`
    } else {
      field = call.for
      const entity = readValue(object.text, call.for)
      if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) {
        out.notes.push(`${refer(object)}: ${FIELD_NAMES[call.for] ?? call.for} ist nicht angegeben, deshalb habe ich keine Koordinaten gesetzt.`)
        return undefined
      }
      old = entity
      value = { ...entity, geocode: point }
      where = FIELD_NAMES[call.for] ?? call.for
    }
    const result = setField(object.text, field, value, old)
    if (!result.ok) {
      out.notes.push(`${refer(object)}: Koordinaten nicht gesetzt, du hast ${where} inzwischen selbst geändert.`)
      return undefined
    }
    object.text = result.text
    object.updatedAt = Date.now()
    this.#markObject(object.id)
    out.log.push(`Objekt ${object.number}: Koordinaten für ${where} gesetzt: ${point.lat}, ${point.lon} (${call.precision}, ${call.source}, „${call.label}“).`)
    this.#change(out, object).points.push(`Koordinaten für ${where}: „${call.label}“, ${PRECISION_NAMES[call.precision]}.`)
    return object
  }

  #change(out: Out, object: ObjectRecord): Change {
    let change = out.changes.get(object)
    if (!change) out.changes.set(object, (change = { set: [], kept: [], points: [] }))
    return change
  }

  /** The sentences that tell the user what was done to which object, and what is still open. */
  #describe(changes: Map<ObjectRecord, Change>): string[] {
    const lines: string[] = []
    for (const [object, change] of changes) {
      const parts: string[] = []
      const set = [...new Set(change.set)]
      if (change.created) parts.push(`Ich habe ${refer(object)} angelegt (${change.created})${set.length ? ` und ausgefüllt: ${set.join(', ')}` : ''}.`)
      else if (set.length) parts.push(`${refer(object)}: ${set.join(', ')} gesetzt.`)
      for (const point of change.points) parts.push(point)
      if (change.kept.length) parts.push(`Nicht überschrieben, weil du es selbst geändert hast: ${change.kept.join('; ')}.`)
      const open = change.created || set.length ? missing(object.text) : []
      if (open.length) parts.push(`Es fehlt noch: ${open.join(', ')}.`)
      if (parts.length) lines.push(parts.join(' '))
    }
    return lines
  }

  #create(call: Extract<ToolCall, { tool: 'create_object' }>, target: FileRecord[], out: Out): ObjectRecord[] {
    const free = target.filter((f) => !f.objectId)
    if (free.length === 0) {
      out.notes.push(target.length === 0 ? 'Wähle zuerst eine oder mehrere Dateien aus.' : 'Die Dateien gehören schon zu einem Objekt.')
      return []
    }
    const together = call.type === 'document' && call.together !== false
    const groups = together ? [[...free].sort(byName)] : free.map((f) => [f])
    const created: ObjectRecord[] = []
    const appliedBy = new Map<string, string[]>()

    for (const group of groups) {
      const id = ulid()
      const number = Math.max(0, ...this.objects.map((o) => o.number)) + 1
      let text = newObjectText(id, call.type, call.subtype)
      const applied: string[] = []
      for (const file of group) text = addFile(text, $state.snapshot(file.entry))
      for (const [field, value] of Object.entries(call.fields ?? {})) {
        const result = setField(text, field, value, undefined)
        if (result.ok) {
          text = result.text
          applied.push(FIELD_NAMES[field] ?? field)
        }
      }

      this.objects.push({ id, number, text, updatedAt: Date.now() })
      this.#markObject(id)
      for (const file of group) {
        file.objectId = id
        this.#mark(file.sha256)
      }
      created.push(this.objects[this.objects.length - 1])
      appliedBy.set(id, applied)
    }

    const label = objectLabel(call.type, call.subtype)
    for (const object of created) {
      const pages = this.files.filter((f) => f.objectId === object.id).length
      const what = call.type === 'document' && pages > 1 ? `${label}, ${pages} Seiten` : label
      const open = missing(object.text)
      out.log.push(`Objekt ${object.number} angelegt: ${what}.${open.length ? ` Es fehlt noch: ${open.join(', ')}.` : ''}`)
      const change = this.#change(out, object)
      change.created = what
      change.set.push(...(appliedBy.get(object.id) ?? []))
    }
    return created
  }

  #patch(call: Extract<ToolCall, { tool: 'patch' }>, out: Out): ObjectRecord | undefined {
    const object = this.objects.find((o) => o.number === call.object)
    if (!object) {
      out.notes.push(`Objekt ${call.object} gibt es nicht.`)
      return undefined
    }
    const name = FIELD_NAMES[call.field] ?? call.field
    const result = setField(object.text, call.field, call.value, call.old)
    if (result.ok) {
      object.text = result.text
      object.updatedAt = Date.now()
      this.#markObject(object.id)
      out.log.push(`Objekt ${object.number}: ${name} gesetzt auf „${show(call.value)}“.`)
      this.#change(out, object).set.push(name)
    } else {
      out.log.push(`Objekt ${object.number}: ${name} nicht geändert, du hast es selbst geändert (jetzt: „${show(result.current)}“).`)
      this.#change(out, object).kept.push(`${name} (jetzt: „${show(result.current)}“)`)
    }
    return object
  }

  /**
   * After a change: show the first object in the editor. The selection is never moved
   * on its own, only the user selects. It is set to the files of the touched objects,
   * so that the next chat message refers to exactly these objects.
   */
  #settle(objects: ObjectRecord[]) {
    const files = this.files.filter((f) => objects.some((o) => o.id === f.objectId))
    if (files.length === 0) return
    this.active = files[0].sha256
    this.selection = files.map((f) => f.sha256)
    this.#anchor = files[0].sha256
    this.#markUi()
  }

  /** The user changed the text in the editor. */
  updateText(text: string) {
    const object = this.activeObject
    if (!object) return
    object.text = text
    object.updatedAt = Date.now()
    this.#dirtyObjects.add(object.id)
    this.#schedule()
    this.#syncAfterTyping()
  }

  // --- saving: shortly after the last change, and at once when the tab is left ---

  #mark(sha256: string) {
    this.#dirtyFiles.add(sha256)
    this.#schedule()
  }

  #markUi() {
    this.#dirtyUi = true
    this.#schedule()
  }

  #markChat() {
    this.#dirtyChat = true
    this.#schedule()
  }

  /** The app changed an object. */
  #markObject(id: string) {
    this.#dirtyObjects.add(id)
    this.#schedule()
    this.#syncAfterApp()
  }

  #schedule() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush(), 400)
  }

  async flush() {
    clearTimeout(this.#timer)
    const files = [...this.#dirtyFiles].flatMap((sha) => this.files.filter((f) => f.sha256 === sha))
    const objects = [...this.#dirtyObjects].flatMap((id) => this.objects.filter((o) => o.id === id))
    this.#dirtyFiles.clear()
    this.#dirtyObjects.clear()
    const removed = [...this.#removedObjects]
    this.#removedObjects.clear()
    const removedFiles = [...this.#removedFiles]
    this.#removedFiles.clear()
    const chat = this.#dirtyChat
    this.#dirtyChat = false
    const ui = this.#dirtyUi
    this.#dirtyUi = false
    if (files.length === 0 && objects.length === 0 && removed.length === 0 && removedFiles.length === 0 && !chat && !ui) return

    this.saveState = 'saving'
    try {
      // A plain copy is needed: reactive objects cannot be stored. Progress is not kept.
      const plainFiles = files.map((f) => ({ ...$state.snapshot(f), progress: undefined }))
      await db.save(plainFiles, objects.map((o) => $state.snapshot(o)), chat ? $state.snapshot(this.chat.slice(-200)) : undefined,
        removed,
        ui ? { selection: $state.snapshot(this.selection), active: this.active } : undefined,
        removedFiles,
      )
      this.saveState = 'saved'
    } catch {
      this.saveState = 'failed'
    }
  }

  // --- GitHub: who is signed in, saving to the person's branch, submitting, following the pull request ---

  get loginUrl(): string {
    return this.#backend.loginUrl
  }

  /** Asks who is signed in. `notice` is what the sign-in page says if nobody is (e.g. why a sign-in was refused). */
  async refreshSession(notice?: string) {
    try {
      const user = await this.#backend.me()
      this.session = user ? { state: 'user', user } : { state: 'anonymous', notice }
      if (user) {
        this.#syncAfterApp()
        void this.checkPulls()
      }
    } catch (error) {
      this.session = { state: 'error', message: (error as Error).message }
    }
  }

  /** The server says the session is over. What is in the browser stays. */
  signedOut() {
    if (this.session.state === 'anonymous') return
    this.#stopTimers()
    this.session = { state: 'anonymous', notice: 'Deine Sitzung ist abgelaufen. Bitte melde dich neu an.' }
  }

  async logout() {
    await this.#backend.logout()
    this.#stopTimers()
    this.session = { state: 'anonymous' }
  }

  /** Where an object stands. */
  standing(object: ObjectRecord): Standing {
    if (object.synced === undefined) return 'local'
    if (object.text !== object.synced) return 'changed'
    return object.stage ?? 'saved'
  }

  /** Objects that are in the archive now. */
  get merged(): ObjectRecord[] {
    return this.objects.filter((o) => this.standing(o) === 'merged')
  }

  /** Takes the accepted objects and their files out of this view. They stay in the repository and the bucket. */
  removeMerged() {
    const gone = this.merged
    if (gone.length === 0) return
    const ids = new Set(gone.map((o) => o.id))
    const files = this.files.filter((f) => f.objectId && ids.has(f.objectId))
    const shas = new Set(files.map((f) => f.sha256))
    this.objects = this.objects.filter((o) => !ids.has(o.id))
    this.files = this.files.filter((f) => !shas.has(f.sha256))
    for (const id of ids) {
      this.#dirtyObjects.delete(id)
      this.#removedObjects.add(id)
    }
    for (const sha of shas) {
      this.#dirtyFiles.delete(sha)
      this.#removedFiles.add(sha)
    }
    this.selection = this.selection.filter((sha) => !shas.has(sha))
    if (this.active && shas.has(this.active)) this.active = undefined
    this.#markUi()
    this.#schedule()
    this.#say('log', `${gone.length === 1 ? 'Ein übernommenes Objekt' : `${gone.length} übernommene Objekte`} aus der Ansicht entfernt.`)
  }

  /** The objects the next pull request would bring: everything that is not already part of one. */
  get outgoing(): ObjectRecord[] {
    return this.objects.filter((o) => {
      const standing = this.standing(o)
      return standing !== 'submitted' && standing !== 'merged'
    })
  }

  #stopTimers() {
    clearTimeout(this.#appTimer)
    clearTimeout(this.#typingTimer)
  }

  /** The app changed something: save in a second (the changes of one answer go into one commit). */
  #syncAfterApp() {
    if (this.session.state !== 'user') return
    clearTimeout(this.#appTimer)
    this.#appTimer = setTimeout(() => void this.sync(), APP_DELAY)
  }

  /** The person typed: save when it has been quiet for a while, or earlier if the app saves anyway. */
  #syncAfterTyping(delay = TYPING_DELAY) {
    if (this.session.state !== 'user') return
    clearTimeout(this.#typingTimer)
    this.#typingTimer = setTimeout(() => void this.sync(), delay)
  }

  /** Saves every changed object to the person's branch in one commit. Returns whether everything is saved. */
  async sync(): Promise<boolean> {
    this.#stopTimers()
    if (this.session.state !== 'user') return false
    if (this.#syncing) {
      this.#syncAgain = true
      return false
    }
    const todo = this.objects.filter((o) => o.text !== o.synced).map((object) => ({ object, text: object.text }))
    if (todo.length === 0) return true

    this.#syncing = true
    this.syncState = 'saving'
    let ok = false
    try {
      await this.#backend.save(todo.map(({ object, text }) => ({ id: object.id, text })))
      for (const { object, text } of todo) {
        object.synced = text
        // An object that was accepted before and is changed again starts a new round.
        if (object.stage !== 'submitted') object.stage = 'saved'
        this.#dirtyObjects.add(object.id)
      }
      this.#schedule()
      this.syncState = 'idle'
      this.syncError = undefined
      ok = true
    } catch (error) {
      if (error instanceof SignedOut) {
        this.syncState = 'idle'
      } else {
        this.syncState = 'failed'
        this.syncError = (error as Error).message
        this.#syncAfterTyping(SYNC_RETRY)
      }
    } finally {
      this.#syncing = false
    }
    if (this.#syncAgain) {
      this.#syncAgain = false
      this.#syncAfterApp()
    }
    return ok && !this.objects.some((o) => o.text !== o.synced)
  }

  /** Saves what is open, then opens the pull request. Tells the person in the chat what came of it. */
  async submit() {
    if (this.submitting || this.session.state !== 'user' || this.outgoing.length === 0) return
    this.submitting = true
    try {
      const open = this.outgoing.filter((o) => validateObjectYaml(o.text).length > 0)
      if (open.length > 0) {
        const list = open.slice(0, 3).map(refer).join(', ') + (open.length > 3 ? ', …' : '')
        this.#say('status', `Eingereicht wird erst, wenn alle Objekte vollständig sind. Es fehlt noch etwas bei: ${list}.`)
        return
      }
      // Not syncing in the middle of an edit: wait for a running save, then save the rest.
      while (this.#syncing) await new Promise((resolve) => setTimeout(resolve, 100))
      if (!(await this.sync())) {
        this.#say('status', `Das Einreichen ging nicht, weil das Speichern nicht geklappt hat${this.syncError ? `: ${this.syncError}` : '.'}`)
        return
      }
      const sent = this.objects.filter((o) => o.stage === 'saved')
      const pull = await this.#backend.submit()
      for (const object of sent) {
        object.stage = 'submitted'
        object.pull = pull.number
        this.#dirtyObjects.add(object.id)
      }
      this.#schedule()
      const n = sent.length
      this.#say('assistant', `Ich habe ${n === 1 ? 'ein Objekt' : `${n} Objekte`} eingereicht. Sie werden jetzt geprüft; du kannst in der Zwischenzeit weitermachen.`)
    } catch (error) {
      if (!(error instanceof SignedOut)) this.#say('status', `Das Einreichen ging nicht: ${(error as Error).message}`)
    } finally {
      this.submitting = false
    }
  }

  /** Looks at the pull requests that wait for review: accepted objects are marked, a closed one is open for revision. */
  async checkPulls() {
    if (this.session.state !== 'user') return
    const numbers = [...new Set(this.objects.filter((o) => o.stage === 'submitted' && o.pull).map((o) => o.pull as number))]
    for (const number of numbers) {
      try {
        const pull = await this.#backend.pull(number)
        if (pull.state === 'open') continue
        const parts = this.objects.filter((o) => o.stage === 'submitted' && o.pull === number)
        for (const object of parts) {
          object.stage = pull.merged ? 'merged' : 'saved'
          object.pull = undefined
          this.#dirtyObjects.add(object.id)
        }
        this.#schedule()
        const n = parts.length
        this.#say(
          pull.merged ? 'assistant' : 'status',
          pull.merged
            ? `${n === 1 ? 'Ein Objekt wurde' : `${n} Objekte wurden`} geprüft und übernommen. Danke!`
            : `Die Einreichung von ${n === 1 ? 'einem Objekt' : `${n} Objekten`} wurde nicht übernommen. Du kannst sie überarbeiten und erneut einreichen.`,
        )
      } catch {
        return // no connection or signed out: next time
      }
    }
  }
}
