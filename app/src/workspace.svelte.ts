// The state of the whole work session and what can be done with it. Components only
// show it and call its methods. The `.svelte.ts` ending lets this file use runes
// (`$state`) outside of a component: everything declared with `$state` here updates
// whatever shows it, wherever that is.

import { addFile, readField, removeFile, setField, ulid, validateObjectYaml, type FileEntry } from '@archive/core'
import type { Agent, ToolCall } from './agent.js'
import * as db from './db.js'
import { FIELD_NAMES, objectLabel } from './labels.js'
import { prepareFile } from './prepare.js'
import { newObjectText } from './template.js'
import type { FileStore } from './uploader.js'

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
}

/** A file that is still being hashed, or could not be read. */
export interface Pending {
  name: string
  state: 'hashing' | 'error'
  progress: number
  message?: string
}

export interface ChatMessage {
  /** `status` is what the app reports (uploads, objects created); the others are the conversation. */
  role: 'user' | 'assistant' | 'status'
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
}

const show = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(show).join(', ')
  if (typeof value === 'object' && value !== null) {
    const { name, location } = value as { name?: unknown; location?: unknown }
    return [name, location].filter((x) => typeof x === 'string' && x).join(', ') || JSON.stringify(value)
  }
  return String(value ?? '')
}
/** "Datei „a.jpg“" or "3 Dateien". */
const count = (list: string[]): string => (list.length === 1 ? `Datei „${list[0]}“` : `${list.length} Dateien`)
const names = (list: string[]): string => `(${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''})`

/** What is still missing in an object, in words for the user. */
function missing(text: string): string[] {
  const found = validateObjectYaml(text).map((issue) => /missing field "(\w+)"/.exec(issue.message)?.[1] ?? issue.path.split('/')[1] ?? '')
  return [...new Set(found.filter(Boolean))].map((field) => FIELD_NAMES[field] ?? field)
}

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

  #store: FileStore
  #agent: Agent
  #anchor: string | undefined
  #queue: { file: File; batch: Batch }[] = []
  #busy = false
  #dirtyFiles = new Set<string>()
  #dirtyObjects = new Set<string>()
  #removedObjects = new Set<string>()
  #dirtyChat = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(store: FileStore, agent: Agent) {
    this.#store = store
    this.#agent = agent
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
      const [files, objects, chat] = await Promise.all([db.loadFiles(), db.loadObjects(), db.loadChat()])
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
      this.#schedule()
    } catch {
      this.saveState = 'failed'
    }
  }

  // --- dropping files: hash one after the other, upload in the background ---

  addDropped(list: Iterable<File>) {
    const files = [...list].sort(byName) // scans are usually numbered: natural order by name
    if (files.length === 0) return
    const message = this.#say('status', '')
    const batch: Batch = { total: files.length, uploaded: 0, conflicts: [], failed: [], duplicates: [], message }
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
      if (existing && existing.status !== 'error') {
        batch.duplicates.push(file.name)
      } else if (existing) {
        void this.#upload(existing, file, batch) // try again after an error
      } else {
        this.files.push({ sha256, name: file.name, bytes: file.size, entry, preview, status: 'uploading', addedAt: Date.now() })
        void this.#upload(this.files[this.files.length - 1], file, batch)
      }
      this.pending = this.pending.filter((p) => p !== item)
    } catch (error) {
      item.state = 'error'
      item.message = (error as Error).message
      batch.failed.push(file.name)
    }
    this.#report(batch)
  }

  async #upload(record: FileRecord, file: File, batch: Batch) {
    record.status = 'uploading'
    record.message = undefined
    record.progress = 0
    this.#mark(record.sha256)
    try {
      const result = await this.#store.upload(file, $state.snapshot(record.entry), (fraction) => (record.progress = fraction))
      record.status = result.status
      record.message = result.message
    } catch (error) {
      record.status = 'error'
      record.message = (error as Error).message
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
    this.focusTick++
  }

  /** Closes the open object. The selection stays. */
  collapse() {
    this.active = undefined
  }

  // --- rearranging: files go into an object, or come out of it ---

  /** Puts files into an object. A file that belongs to another object is moved. */
  attach(shas: string[], objectId: string) {
    const target = this.objects.find((o) => o.id === objectId)
    const files = this.files.filter((f) => shas.includes(f.sha256) && f.objectId !== objectId).sort(byName)
    if (!target || files.length === 0) return
    if (readField(target.text, 'type') === 'image' && this.files.some((f) => f.objectId === objectId)) {
      this.#say('status', `Object ${target.number} ist ein Bild und hat schon eine Datei.`)
      return
    }

    const lines: string[] = []
    const added: string[] = []
    const moved = new Map<number, string[]>()
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
        if (from) moved.set(from.number, [...(moved.get(from.number) ?? []), file.name])
        else added.push(file.name)
      } catch (error) {
        lines.push(`Object ${target.number}: ${(error as Error).message}`)
      }
    }

    if (added.length) lines.unshift(`${count(added)} zu Object ${target.number} hinzugefügt.`)
    for (const [number, list] of moved) lines.push(`${count(list)} von Object ${number} nach Object ${target.number} verschoben.`)
    this.#discard(emptied, lines)
    this.#say('status', lines.join('\n'))
    this.activate(objectId)
  }

  /** Takes files out of their objects. An object without files is deleted. */
  detach(shas: string[]) {
    const files = this.files.filter((f) => shas.includes(f.sha256) && f.objectId)
    if (files.length === 0) return
    const lines: string[] = []
    const emptied = new Set<ObjectRecord>()
    const freed: FileRecord[] = []
    const from = new Map<number, string[]>()
    for (const file of files) {
      const object = this.objects.find((o) => o.id === file.objectId)
      if (!object) continue
      try {
        this.#leave(file, object, removeFile(object.text, file.sha256), emptied)
        freed.push(file)
        from.set(object.number, [...(from.get(object.number) ?? []), file.name])
      } catch (error) {
        lines.push(`Object ${object.number}: ${(error as Error).message}`)
      }
    }
    for (const [number, list] of from) lines.unshift(`${count(list)} aus Object ${number} herausgenommen.`)
    this.#discard(emptied, lines)
    if (lines.length) this.#say('status', lines.join('\n'))
    if (freed.length) {
      this.picked = false
      this.selection = freed.map((f) => f.sha256)
      this.#anchor = freed[0].sha256
      this.active = freed[0].sha256
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

  #discard(emptied: Set<ObjectRecord>, lines: string[]) {
    for (const object of emptied) {
      this.objects = this.objects.filter((o) => o.id !== object.id)
      this.#dirtyObjects.delete(object.id)
      this.#removedObjects.add(object.id)
      lines.push(`Object ${object.number} hat keine Dateien mehr und wurde gelöscht.`)
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
    // The conversation so far, before this message (status messages count as the app's side).
    const history = this.chat
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
    let lines: string[] = []
    const flush = () => {
      if (lines.length > 0) this.#say('status', lines.join('\n'))
      lines = []
    }
    const touched: ObjectRecord[] = []

    for (const call of calls) {
      try {
        if (call.tool === 'say') {
          flush()
          this.#say('assistant', call.text)
        } else if (call.tool === 'create_object') {
          touched.push(...this.#create(call, target, lines))
        } else {
          const object = this.#patch(call, lines)
          if (object) touched.push(object)
        }
      } catch (error) {
        lines.push((error as Error).message)
      }
    }
    flush()
    if (touched.length > 0) this.#settle([...new Set(touched)])
  }

  #create(call: Extract<ToolCall, { tool: 'create_object' }>, target: FileRecord[], lines: string[]): ObjectRecord[] {
    const free = target.filter((f) => !f.objectId)
    if (free.length === 0) {
      lines.push(target.length === 0 ? 'Wähle zuerst eine oder mehrere Dateien aus.' : 'Die Dateien gehören schon zu einem Object.')
      return []
    }
    const together = call.type === 'document' && call.together !== false
    const groups = together ? [[...free].sort(byName)] : free.map((f) => [f])
    const created: ObjectRecord[] = []

    for (const group of groups) {
      const id = ulid()
      const number = Math.max(0, ...this.objects.map((o) => o.number)) + 1
      let text = newObjectText(id, call.type, call.subtype)
      for (const file of group) text = addFile(text, $state.snapshot(file.entry))
      for (const [field, value] of Object.entries(call.fields ?? {})) {
        const result = setField(text, field, value, undefined)
        if (result.ok) text = result.text
      }

      this.objects.push({ id, number, text, updatedAt: Date.now() })
      this.#markObject(id)
      for (const file of group) {
        file.objectId = id
        this.#mark(file.sha256)
      }
      created.push(this.objects[this.objects.length - 1])
    }

    const label = objectLabel(call.type, call.subtype)
    for (const object of created) {
      const pages = this.files.filter((f) => f.objectId === object.id).length
      const what = call.type === 'document' && pages > 1 ? `${label}, ${pages} Seiten` : label
      const open = missing(object.text)
      lines.push(`Object ${object.number} angelegt: ${what}.${open.length ? ` Es fehlt noch: ${open.join(', ')}.` : ''}`)
    }
    return created
  }

  #patch(call: Extract<ToolCall, { tool: 'patch' }>, lines: string[]): ObjectRecord | undefined {
    const object = this.objects.find((o) => o.number === call.object)
    if (!object) {
      lines.push(`Object ${call.object} gibt es nicht.`)
      return undefined
    }
    const name = FIELD_NAMES[call.field] ?? call.field
    const result = setField(object.text, call.field, call.value, call.old)
    if (result.ok) {
      object.text = result.text
      object.updatedAt = Date.now()
      this.#markObject(object.id)
      lines.push(`Object ${object.number}: ${name} gesetzt auf „${show(call.value)}“.`)
    } else {
      lines.push(`Object ${object.number}: ${name} nicht geändert, du hast es selbst geändert (jetzt: „${show(result.current)}“).`)
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
  }

  /** The user changed the text in the editor. */
  updateText(text: string) {
    const object = this.activeObject
    if (!object) return
    object.text = text
    object.updatedAt = Date.now()
    this.#markObject(object.id)
  }

  // --- saving: shortly after the last change, and at once when the tab is left ---

  #mark(sha256: string) {
    this.#dirtyFiles.add(sha256)
    this.#schedule()
  }

  #markChat() {
    this.#dirtyChat = true
    this.#schedule()
  }

  #markObject(id: string) {
    this.#dirtyObjects.add(id)
    this.#schedule()
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
    const chat = this.#dirtyChat
    this.#dirtyChat = false
    if (files.length === 0 && objects.length === 0 && removed.length === 0 && !chat) return

    this.saveState = 'saving'
    try {
      // A plain copy is needed: reactive objects cannot be stored. Progress is not kept.
      const plainFiles = files.map((f) => ({ ...$state.snapshot(f), progress: undefined }))
      await db.save(plainFiles, objects.map((o) => $state.snapshot(o)), chat ? $state.snapshot(this.chat.slice(-200)) : undefined, removed)
      this.saveState = 'saved'
    } catch {
      this.saveState = 'failed'
    }
  }
}
