// The state of the whole work session and what can be done with it. Components only
// show it and call its methods. The `.svelte.ts` ending lets this file use runes
// (`$state`) outside of a component: everything declared with `$state` here updates
// whatever shows it, wherever that is.

import { addFile, readField, readValue, removeFile, setField, ulid, validateObjectYaml, type FileEntry } from '@tamandua/core'
import type { Agent, ToolCall } from './agent.js'
import { withoutBlobs } from './blobs.js'
import * as db from './db.js'
import { FIELD_NAMES, objectLabel } from './labels.js'
import { prepareFile } from './prepare.js'
import { newEmptyText, newObjectText } from './template.js'
import { validityOf } from './validity.js'
import type { FileStore } from './uploader.js'
import { SignedOut } from './api.js'
import { Locked, type Backend, type Removed, type RemoteContent, type RemoteErfassung, type SessionRef, type User } from './backend.js'

/** A file that was dropped and hashed. It is identified by its SHA-256. */
export interface FileRecord {
  sha256: string
  name: string
  bytes: number
  /** The entry that goes into `files` of an object's YAML. */
  entry: FileEntry
  preview?: Blob
  /** The picture for the detail view, kept until it is in the bucket (the detail view reads it from there afterwards). */
  web?: Blob
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
  /** Running number within its session, shown on the tiles together with the object's color. */
  number: number
  text: string
  updatedAt: number
  /** The session (work unit) the object belongs to; one session is one branch and one pull request. */
  sessionId: string
  /** The text as it is on the session's branch in the data repository; none if it never got there. */
  synced?: string
}

/**
 * A named unit of work: one branch and one pull request in the data repository. `id` is the slug that the
 * branch is named after. Open sessions take changes; a submitted session is frozen (its pull request is
 * under review); a merged one is part of the archive.
 */
export interface Session {
  id: string
  name: string
  state: 'open' | 'submitted' | 'merged'
  /** The pull request, once there is one. */
  pull?: number
  url?: string
  createdAt: number
  /** Objects deleted here that may still be on the branch: removed from it with the next save. */
  deleted: Removed[]
  /** Made by the app on its own and not named by the person: goes away again while it is empty (see `#begin`). */
  auto?: true
}

/** Where an object stands, for the badge on its row. */
export type Standing = 'local' | 'changed' | 'saving' | 'failed' | 'saved' | 'submitted' | 'merged'

export type Login =
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
/** How long a save is shown at least. */
const MIN_SAVING = 500

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
  /** Duplicates that belong to a session other than the shown one: file name and session name. */
  elsewhere: { name: string; session: string }[]
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

/** True for an object whose content lives somewhere else (storage: external): it has no files of its own. */
const isExternal = (text: string): boolean => readField(text, 'storage') === 'external'

/** The only fields of a place that are kept from what the model sent. */
const PLACE_KEYS = ['uri', 'site', 'type', 'reference', 'note', 'retrieved'] as const

/** What is still missing in an object, in words for the user. */
function missing(text: string): string[] {
  const found = validateObjectYaml(text).map((issue) => /missing field "(\w+)"/.exec(issue.message)?.[1] ?? issue.path.split('/')[1] ?? '')
  return [...new Set(found.filter(Boolean))].map((field) => FIELD_NAMES[field] ?? field)
}

/** Six decimals are about ten centimeters: plenty. */
const round = (x: number): number => Math.round(x * 1e6) / 1e6

const PRECISION_NAMES: Record<string, string> = { exact: 'genau', street: 'auf die Straße genau', town: 'auf den Ort genau', region: 'nur ungefähr' }

/** "Dachbodenfund Postkarten" → "dachbodenfund-postkarten-4k2x": the part of the branch name that identifies a session. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => (b % 36).toString(36)).join('')
  return `${base || 'erfassung'}-${random}`
}

/** The name of the session that is made on its own, when the first object is created. */
export const defaultName = (): string =>
  `Erfassung vom ${new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })}`

const cleanName = (name: string): string => name.replace(/\s+/g, ' ').trim().slice(0, 100)

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true })

export class Workspace {
  files = $state<FileRecord[]>([])
  objects = $state<ObjectRecord[]>([])
  pending = $state<Pending[]>([])
  /** How far the files that were just dropped are (stored and uploaded); none when nothing is going on. */
  progress = $state<{ done: number; total: number } | undefined>()
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
  /** The open object when it has no file to click on (it lives elsewhere). Only counts while no file is active. */
  activeObjectId = $state<string>()
  saveState = $state<'saved' | 'saving' | 'failed'>('saved')
  /** False once the browser refused to store the pictures (the rest is stored): they are gone after a reload. */
  picturesKept = $state(true)
  /** SHA-256 of the files being dragged to an object or out of one; empty when nothing is dragged. */
  dragging = $state<string[]>([])
  /** The object whose row is under the dragged tiles, if any. */
  dragTarget = $state<string>()
  /** The object the pointer rests on, or that belongs to the file it rests on; its counterpart in the other list is tinted. */
  hover = $state<string>()

  /** The work sessions, and the one that is shown. */
  sessions = $state<Session[]>([])
  currentId = $state<string>()

  /** Who is signed in. */
  login = $state<Login>({ state: 'loading' })
  /** Saving to GitHub: `failed` is shown to the person, with the reason in `syncError`. */
  syncState = $state<'idle' | 'saving' | 'failed'>('idle')
  syncError = $state<string>()
  /** The sessions and objects a save is running for right now, and the sessions whose last save failed. */
  savingSessions = $state<string[]>([])
  savingObjects = $state<string[]>([])
  failedSessions = $state<string[]>([])
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
  #batches = new Set<Batch>()
  #busy = false
  #dirtyFiles = new Set<string>()
  #dirtyObjects = new Set<string>()
  #removedObjects = new Set<string>()
  #dirtySessions = new Set<string>()
  #removedSessions = new Set<string>()
  #dirtyChat = false
  #dirtyUi = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(store: FileStore, agent: Agent, backend: Backend) {
    this.#store = store
    this.#agent = agent
    this.#backend = backend
  }

  /**
   * The objects a chat message is about: those of the selected files, and the open object if it has no files
   * (a new empty one, or one that lives elsewhere): it has nothing to select, so it is what the person is looking at.
   */
  get chatObjects(): ObjectRecord[] {
    const ids = new Set(this.target.map((f) => f.objectId).filter((id): id is string => !!id))
    const found = this.objects.filter((o) => ids.has(o.id))
    const open = this.activeObject
    if (open && !found.includes(open) && !this.files.some((f) => f.objectId === open.id)) found.push(open)
    return found
  }

  /** The files a chat message is about: the selected ones. Only the user selects. */
  get target(): FileRecord[] {
    return this.files.filter((f) => this.selection.includes(f.sha256))
  }

  /** The open object: that of the active file, or one without files that was opened itself. */
  get activeObject(): ObjectRecord | undefined {
    const file = this.files.find((f) => f.sha256 === this.active)
    if (file) return file.objectId ? this.objects.find((o) => o.id === file.objectId) : undefined
    return this.activeObjectId ? this.objects.find((o) => o.id === this.activeObjectId) : undefined
  }

  /** The session that is shown. */
  get current(): Session | undefined {
    return this.sessions.find((s) => s.id === this.currentId)
  }

  /** The objects of the shown session. */
  get shown(): ObjectRecord[] {
    return this.objects.filter((o) => o.sessionId === this.currentId)
  }

  /** Objects of the shown session that are not valid yet: as long as there are any, the session cannot be submitted. */
  get notReady(): ObjectRecord[] {
    return this.shown.filter((o) => validityOf(o.text).state !== 'valid')
  }

  /** Objects that are not saved to GitHub yet (frozen sessions do not count: they are not saved any more). */
  get unsaved(): ObjectRecord[] {
    const open = new Set(this.sessions.filter((s) => s.state === 'open').map((s) => s.id))
    return this.objects.filter((o) => open.has(o.sessionId) && o.text !== o.synced)
  }

  /** True if the object may be changed: it is in the shown session and that one is open. */
  writable(object: ObjectRecord): boolean {
    return object.sessionId === this.currentId && this.current?.state === 'open'
  }

  /** The files of the Dateien pane: those of the shown session and the free ones. Files of other sessions are hidden. */
  get visibleFiles(): FileRecord[] {
    return this.files.filter((f) => !this.foreign(f))
  }

  /** A file that is part of an object of another session: it can neither be selected nor moved here. */
  foreign(file: FileRecord): boolean {
    if (!file.objectId) return false
    const owner = this.objects.find((o) => o.id === file.objectId)
    return !!owner && owner.sessionId !== this.currentId
  }

  #sessionOf(object: ObjectRecord): Session | undefined {
    return this.sessions.find((s) => s.id === object.sessionId)
  }

  #ref(session: Session): SessionRef {
    return { slug: session.id, name: session.name }
  }

  /** Why a change to the object is refused, in words for the user. */
  #refuse(object: ObjectRecord): string {
    const session = this.#sessionOf(object)
    const name = session ? `„${session.name}“` : 'einer anderen Erfassung'
    if (session && session.id === this.currentId) {
      return `${refer(object)} gehört zur Erfassung ${name}, die schon ${session.state === 'merged' ? 'übernommen' : 'eingereicht'} ist. Ändern kannst du es dort nicht mehr.`
    }
    return `${refer(object)} gehört zur Erfassung ${name}. Wechsle dorthin, um es zu ändern.`
  }

  async load() {
    try {
      const [files, objects, chat, ui, sessions] = await Promise.all([db.loadFiles(), db.loadObjects(), db.loadChat(), db.loadUi(), db.loadSessions()])
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
      // Deletions saved before titles were remembered are plain ids.
      for (const session of sessions) session.deleted = (session.deleted as (string | Removed)[]).map((d) => (typeof d === 'string' ? { id: d } : d))
      this.sessions = sessions.sort((a, b) => a.createdAt - b.createdAt)
      this.objects = objects
      this.#adopt()
      this.#repairLinks()
      this.currentId = this.sessions.find((s) => s.id === ui?.session)?.id ?? (this.sessions.find((s) => s.state === 'open') ?? this.sessions[0])?.id
      if (ui) {
        // Selection and open object as the user left them, as far as the files still exist.
        const known = new Set(files.map((f) => f.sha256))
        this.selection = ui.selection.filter((sha) => known.has(sha))
        this.active = ui.active && known.has(ui.active) ? ui.active : undefined
        this.activeObjectId = ui.object && objects.some((o) => o.id === ui.object) ? ui.object : undefined
        this.#anchor = this.selection[0]
      }
      this.#schedule()
    } catch (error) {
      console.error('Loading from the browser storage failed', error)
      this.saveState = 'failed'
    } finally {
      this.#loaded = true
      void this.#begin()
    }
  }

  /**
   * A file that is linked to an object whose YAML does not list it any more (changed by hand, or an older bug) is
   * free again. Only a YAML that can be read and has a list of files counts, so that a half-typed text never matters.
   */
  #repairLinks() {
    for (const file of this.files) {
      const object = file.objectId ? this.objects.find((o) => o.id === file.objectId) : undefined
      const listed = object ? readValue(object.text, 'files') : undefined
      if (!object || !Array.isArray(listed)) continue
      if (!listed.some((entry) => (entry as { sha256?: unknown } | null)?.sha256 === file.sha256)) {
        file.objectId = undefined
        this.#dirtyFiles.add(file.sha256)
      }
    }
  }

  /** Objects from before there were sessions are put into one: an open one, or, if they were accepted, a merged one. */
  #adopt() {
    type Legacy = ObjectRecord & { stage?: string; pull?: number }
    const orphans = (this.objects as Legacy[]).filter((o) => !o.sessionId)
    if (orphans.length === 0) return
    const accepted = orphans.filter((o) => o.stage === 'merged')
    const rest = orphans.filter((o) => o.stage !== 'merged')
    const make = (name: string, state: Session['state'], list: Legacy[]) => {
      if (list.length === 0) return
      const session = this.#add(name, state)
      for (const object of list) {
        object.sessionId = session.id
        // What was saved before went to a branch that is not this session's: save it again.
        if (state === 'open') object.synced = undefined
        object.stage = undefined
        object.pull = undefined
        this.#dirtyObjects.add(object.id)
      }
    }
    make(defaultName(), 'open', rest)
    make('Übernommen', 'merged', accepted)
  }

  #add(name: string, state: Session['state'] = 'open', auto = false): Session {
    name = cleanName(name) || defaultName()
    this.sessions.push({ id: slugify(name), name, state, createdAt: Date.now(), deleted: [], ...(auto ? { auto: true as const } : {}) })
    const session = this.sessions[this.sessions.length - 1]
    this.#dirtySessions.add(session.id)
    this.#schedule()
    return session
  }

  // --- sessions: a named unit of work, one branch, one pull request ---

  /** Makes a new, open session and shows it. */
  createSession(name: string): Session {
    const session = this.#add(name)
    this.selectSession(session.id)
    return session
  }

  selectSession(id: string) {
    if (!this.sessions.some((s) => s.id === id)) return
    this.leave()
    this.currentId = id
    this.selection = []
    this.active = undefined
    this.activeObjectId = undefined
    this.#anchor = undefined
    this.picked = false
    this.#markUi()
  }

  renameSession(id: string, name: string) {
    const session = this.sessions.find((s) => s.id === id)
    name = cleanName(name)
    if (!session || !name || name === session.name) return
    session.name = name
    session.auto = undefined // the person named it: it stays
    this.#dirtySessions.add(id)
    this.#schedule()
    // The pull request carries the name too (it is how the session is found again). Best effort: it is renamed with the next try.
    if (this.login.state === 'user' && session.state !== 'merged' && (session.pull || this.objects.some((o) => o.sessionId === id && o.synced !== undefined))) {
      void this.#backend.rename(this.#ref(session)).catch(() => undefined)
    }
  }

  /** The session new objects go into: the shown one if it is open, a new one if there is none. Undefined if the shown one is frozen. */
  #openSession(): Session | undefined {
    const current = this.current
    if (current) return current.state === 'open' ? current : undefined
    const open = this.sessions.find((s) => s.state === 'open')
    const session = open ?? this.#add(defaultName())
    this.currentId = session.id
    this.#markUi()
    return session
  }

  /** Takes a accepted session with its objects and files out of this view. They stay in the repository and the bucket. */
  /** Open and nothing belongs to it, nothing was deleted from it, nothing was saved for it. */
  #empty(session: Session): boolean {
    return session.state === 'open' && session.deleted.length === 0 && !session.pull && !this.objects.some((o) => o.sessionId === session.id)
  }

  /**
   * Merged sessions can be taken out of the view; an open one only while it is empty, and never the last open one:
   * there is always one to start in.
   */
  removable(session: Session): boolean {
    if (session.state === 'merged') return true
    return this.#empty(session) && this.sessions.some((s) => s.state === 'open' && s.id !== session.id)
  }

  removeSession(id: string) {
    const session = this.sessions.find((s) => s.id === id)
    if (session && this.removable(session)) this.#remove(session, false)
  }

  #remove(session: Session, quiet: boolean) {
    const id = session.id
    const gone = this.objects.filter((o) => o.sessionId === id)
    const ids = new Set(gone.map((o) => o.id))
    const shas = new Set(this.files.filter((f) => f.objectId && ids.has(f.objectId)).map((f) => f.sha256))
    this.objects = this.objects.filter((o) => !ids.has(o.id))
    this.files = this.files.filter((f) => !shas.has(f.sha256))
    for (const objectId of ids) {
      this.#dirtyObjects.delete(objectId)
      this.#removedObjects.add(objectId)
    }
    for (const sha of shas) {
      this.#dirtyFiles.delete(sha)
      this.#removedFiles.add(sha)
    }
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.#dirtySessions.delete(id)
    this.#removedSessions.add(id)
    this.selection = this.selection.filter((sha) => !shas.has(sha))
    if (this.active && shas.has(this.active)) this.active = undefined
    if (this.activeObjectId && gone.some((o) => o.id === this.activeObjectId)) this.activeObjectId = undefined
    if (this.currentId === id) this.currentId = (this.sessions.find((s) => s.state === 'open') ?? this.sessions[0])?.id
    this.#markUi()
    this.#schedule()
    if (!quiet) this.#say('log', `Die Erfassung „${session.name}“ wurde aus der Ansicht entfernt.`)
  }

  #loaded = false
  #started = false

  /**
   * Once the browser's data is read and somebody is signed in: sessions that the app made on its own and that
   * stayed empty go away, and if nothing open is left, a fresh one is made, so that the person can start at once.
   * It exists only here, in the browser; the branch and the pull request come with the first saved object.
   */
  async #begin() {
    if (this.#started || !this.#loaded || this.login.state !== 'user') return
    this.#started = true
    // First what is on GitHub (on a new device that is all there is), then decide if a fresh session is needed.
    await this.#restore()
    this.#dropAuto()
    this.#ensureOpen(false)
    if (!this.current) this.currentId = [...this.sessions].reverse().find((s) => s.state === 'open')?.id ?? this.sessions[this.sessions.length - 1]?.id
    this.#markUi()
  }

  /**
   * The sessions of this person that are on GitHub (open or submitted) and not in this browser: made here again,
   * with their objects and the files' previews. What is in the browser already is left alone, it is the working copy.
   * Sessions of other people, accepted ones and closed ones (deleted here) are not fetched. Nothing happens if GitHub cannot be reached.
   */
  async #restore() {
    if (this.login.state !== 'user') return
    const me = this.login.user.login.replace(/[^A-Za-z0-9-]/g, '-') // as the branch name has it
    let list
    try {
      list = await this.#backend.erfassungen()
    } catch {
      return
    }
    let restored = 0
    for (const remote of list.filter((e) => e.login === me && e.state !== 'merged' && !e.closed && !this.sessions.some((s) => s.id === e.slug))) {
      try {
        const content = await this.#backend.erfassung(remote.number)
        // Somebody may have made it here while we waited.
        if (this.sessions.some((s) => s.id === remote.slug)) continue
        this.#bringBack(remote, content)
        restored++
      } catch (error) {
        if (error instanceof SignedOut) break
        this.#say('status', `Die Erfassung „${remote.name}“ konnte nicht aus GitHub geladen werden: ${(error as Error).message}`)
      }
    }
    // One message for all of them.
    if (restored > 0) this.#say('status', restored === 1 ? 'Eine Erfassung wurde aus GitHub geladen.' : `${restored} Erfassungen wurden aus GitHub geladen.`)
  }

  #bringBack(remote: RemoteErfassung, content: RemoteContent) {
    const session: Session = { id: remote.slug, name: remote.name, state: remote.state, createdAt: Date.parse(remote.createdAt) || Date.now(), deleted: [] }
    if (!remote.closed) {
      session.pull = remote.number
      session.url = remote.url
    }
    this.sessions.push(session)
    this.sessions.sort((a, b) => a.createdAt - b.createdAt)
    this.#dirtySessions.add(session.id)

    let number = 0
    for (const { id, text } of content.objects) {
      this.objects.push({ id, number: ++number, text, updatedAt: Date.now(), sessionId: session.id, synced: text })
      this.#dirtyObjects.add(id)
      const entries = readValue(text, 'files')
      for (const entry of Array.isArray(entries) ? (entries as FileEntry[]) : []) {
        const sha256 = entry?.sha256
        if (typeof sha256 !== 'string' || this.files.some((f) => f.sha256 === sha256)) continue
        const name = typeof entry.original_name === 'string' ? entry.original_name : sha256.slice(0, 12)
        this.files.push({ sha256, name, bytes: typeof entry.bytes === 'number' ? entry.bytes : 0, entry, status: 'uploaded', objectId: id, addedAt: Date.now() })
        this.#dirtyFiles.add(sha256)
        if (content.files) void this.#loadPreview(sha256, content.files, entry)
      }
    }
    this.#schedule()
  }

  /** The preview of a restored file, from the bucket: its preview variant, or the file itself if it is an image that small. */
  async #loadPreview(sha256: string, base: string, entry: FileEntry) {
    const variants = Array.isArray(entry.variants) ? (entry.variants as { kind?: string; path?: string }[]) : []
    const path = variants.find((v) => v.kind === 'preview')?.path ?? (typeof entry.mime === 'string' && entry.mime.startsWith('image/') ? entry.path : undefined)
    if (typeof path !== 'string') return
    const blob = await this.#backend.fetchFile(base, path)
    const file = this.files.find((f) => f.sha256 === sha256)
    if (!blob || !file) return
    file.preview = blob
    this.#dirtyFiles.add(sha256)
    this.#schedule()
  }

  #dropAuto() {
    for (const session of [...this.sessions]) if (session.auto && this.#empty(session)) this.#remove(session, true)
  }

  /** Makes a fresh session if none is open, and shows it (`show`) or, at the start, only where nothing is shown yet. */
  #ensureOpen(show: boolean) {
    if (this.sessions.some((s) => s.state === 'open')) return
    const session = this.#add(defaultName(), 'open', true)
    if (show) this.selectSession(session.id)
    else {
      this.currentId = session.id
      this.#markUi()
    }
  }

  // --- dropping files: hash one after the other, upload in the background ---

  /** Files from outside. Dropped onto an object (`objectId`), they are also put into it. */
  addDropped(list: Iterable<File>, objectId?: string) {
    const files = [...list].sort(byName) // scans are usually numbered: natural order by name
    if (files.length === 0) return
    const message = this.#say('log', '')
    const batch: Batch = { total: files.length, uploaded: 0, conflicts: [], failed: [], duplicates: [], message, objectId, shas: [], processed: 0, unreadable: [], reasons: [], elsewhere: [] }
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
    if (done >= batch.total) this.#batches.delete(batch)
    else this.#batches.add(batch)
    let total = 0
    let finished = 0
    for (const open of this.#batches) {
      total += open.total
      finished += open.uploaded + open.conflicts.length + open.failed.length + open.duplicates.length
    }
    this.progress = total > 1 ? { done: finished, total } : undefined // one file shows its own tile
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
    const here = batch.duplicates.filter((name) => !batch.elsewhere.some((e) => e.name === name))
    const fresh = batch.shas.length - here.length
    // The question is asked once: more drops while it is still the last thing said do not repeat it.
    const last = [...this.chat].reverse().find((m) => m.role !== 'log' && m !== undefined)
    const asked = !!last && last.role === 'assistant' && last.text.endsWith('Möchtest du sie jetzt beschreiben?')
    if (fresh > 0 && !batch.objectId && !asked) {
      sentences.push(`Du hast ${fresh === 1 ? 'eine Datei' : `${fresh} Dateien`} abgelegt, ${fresh === 1 ? 'sie wird' : 'sie werden'} gerade hochgeladen.`)
    }
    if (here.length) {
      sentences.push(here.length === 1 ? `Die Datei „${here[0]}“ war schon vorhanden.` : `${here.length} Dateien waren schon vorhanden.`)
    }
    for (const { name, session } of batch.elsewhere.slice(0, 3)) sentences.push(`Die Datei „${name}“ gehört schon zur Erfassung „${session}“.`)
    if (batch.elsewhere.length > 3) sentences.push(`${batch.elsewhere.length - 3} weitere Dateien gehören schon zu anderen Erfassungen.`)
    if (batch.unreadable.length) sentences.push(`${them(batch.unreadable)} ${batch.unreadable.length === 1 ? 'konnte' : 'konnten'} nicht gelesen werden ${names(batch.unreadable)}.`)
    if (fresh > 0 && !batch.objectId && !asked) sentences.push('Möchtest du sie jetzt beschreiben?')
    if (sentences.length) this.#say('assistant', sentences.join(' '))
    if (!batch.objectId && batch.shas.length > 0) {
      // Dropping is a deliberate act: the dropped files become the selection, whatever was selected before.
      this.picked = false
      this.selection = [...batch.shas]
      this.#anchor = batch.shas[0]
      this.active = batch.shas[0]
      this.activeObjectId = undefined
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
      const { entry, preview, web } = await prepareFile(file, (fraction) => (item.progress = fraction))
      const sha256 = entry.sha256 as string
      const existing = this.files.find((f) => f.sha256 === sha256)
      let record: FileRecord
      if (existing && existing.status !== 'error') {
        batch.duplicates.push(file.name)
        record = existing
        if (this.foreign(existing)) {
          const owner = this.objects.find((o) => o.id === existing.objectId)
          batch.elsewhere.push({ name: file.name, session: (owner && this.#sessionOf(owner)?.name) || 'einer anderen Erfassung' })
        }
      } else if (existing) {
        existing.web = web
        void this.#upload(existing, file, batch) // try again after an error
        record = existing
      } else {
        this.files.push({ sha256, name: file.name, bytes: file.size, entry, preview, web, status: 'uploading', addedAt: Date.now() })
        record = this.files[this.files.length - 1]
        void this.#upload(record, file, batch)
      }
      if (!this.foreign(record)) batch.shas.push(record.sha256) // a file of another session is not shown here, so it is not selected
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

  /** Where the bucket's files can be read from (they are public), if the Worker knows. */
  get filesBase(): string | undefined {
    return this.login.state === 'user' ? this.login.user.files : undefined
  }

  async #upload(record: FileRecord, file: File, batch: Batch) {
    record.status = 'uploading'
    record.message = undefined
    record.progress = 0
    this.#mark(record.sha256)
    try {
      const result = await this.#store.upload(file, $state.snapshot(record.entry), (fraction) => (record.progress = fraction), { preview: record.preview, web: record.web })
      record.status = result.status
      record.message = result.message
      record.web = undefined // it is in the bucket now (or belongs to somebody else's file there)
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
    const clicked = this.files.find((f) => f.sha256 === sha256)
    if (!clicked || this.foreign(clicked)) return
    this.picked = range || toggle
    if (range && this.#anchor) {
      const from = this.files.findIndex((f) => f.sha256 === this.#anchor)
      const to = this.files.findIndex((f) => f.sha256 === sha256)
      const [low, high] = from < to ? [from, to] : [to, from]
      this.selection = this.files.slice(low, high + 1).filter((f) => !this.foreign(f)).map((f) => f.sha256)
    } else if (toggle) {
      this.selection = this.selection.includes(sha256) ? this.selection.filter((s) => s !== sha256) : [...this.selection, sha256]
      this.#anchor = sha256
    } else {
      this.selection = [sha256]
      this.#anchor = sha256
    }
    this.leave()
    this.active = sha256
    this.activeObjectId = undefined
    this.#markUi()
    this.focusTick++ // typing goes to the chat from here on
  }

  /** Selects all files of an object and shows it. This is what a click on the object's row does. */
  activate(objectId: string) {
    const files = this.files.filter((f) => f.objectId === objectId)
    if (files.length === 0) {
      // An object without files (it lives elsewhere): nothing to select, the object itself is open.
      if (!this.objects.some((o) => o.id === objectId)) return
      this.leave()
      this.selection = []
      this.picked = false
      this.#anchor = undefined
      this.active = undefined
      this.activeObjectId = objectId
      this.#markUi()
      this.focusTick++
      return
    }
    this.leave()
    this.selection = files.map((f) => f.sha256)
    this.picked = false // the object's files are selected, but dragging one tile moves only that one
    this.#anchor = files[0].sha256
    this.active = files[0].sha256
    this.activeObjectId = undefined
    this.#markUi()
    this.focusTick++
  }

  /** Closes the open object. The selection stays. */
  /** A click on empty space: nothing is selected any more and no object is open. */
  clearSelection() {
    this.leave()
    this.selection = []
    this.active = undefined
    this.activeObjectId = undefined
    this.#anchor = undefined
    this.picked = false
    this.#markUi()
    this.focusTick++
  }

  collapse() {
    this.leave()
    this.active = undefined
    this.activeObjectId = undefined
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
    const candidates = this.files.filter((f) => shas.includes(f.sha256) && f.objectId !== objectId).sort(byName)
    if (!target || candidates.length === 0) return
    if (!this.writable(target)) {
      this.#say('assistant', this.#refuse(target))
      return
    }
    // A file of another session stays there; a file of a frozen object cannot be taken out.
    const files = candidates.filter((f) => {
      const owner = f.objectId ? this.objects.find((o) => o.id === f.objectId) : undefined
      return !owner || this.writable(owner)
    })
    if (files.length < candidates.length) {
      const stuck = candidates.find((f) => !files.includes(f))
      const owner = stuck && this.objects.find((o) => o.id === stuck.objectId)
      if (owner) this.#say('assistant', `Die Datei „${stuck.name}“ lässt sich nicht verschieben. ${this.#refuse(owner)}`)
    }
    if (files.length === 0) return
    if (readField(target.text, 'type') === 'image' && this.files.some((f) => f.objectId === objectId)) {
      this.#say('assistant', `${refer(target)} ist ein Bild und kann nur eine Datei haben. Die zweite Datei braucht ein eigenes Objekt, oder der Typ muss „Dokument“ sein.`)
      return
    }

    const log: string[] = []
    const notes: string[] = []
    const added: string[] = []
    const moved = new Map<ObjectRecord, string[]>()
    for (const file of files) {
      const from = this.objects.find((o) => o.id === file.objectId)
      try {
        // Compute both new texts first, so that nothing is half done if one of them fails.
        const text = addFile(target.text, $state.snapshot(file.entry))
        const fromText = from ? removeFile(from.text, file.sha256) : undefined
        if (from && fromText !== undefined) this.#leave(file, from, fromText)
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
    if (log.length) this.#say('log', log.join('\n'))
    if (told.length || notes.length) this.#say('assistant', [...told, ...notes].join(' '))
    this.activate(objectId)
  }

  /** Deletes an object: its files are taken out and stay in the file list, free to go into another object. */
  removeObject(id: string) {
    const object = this.objects.find((o) => o.id === id)
    if (!object || !this.writable(object)) return
    const freed = this.files.filter((f) => f.objectId === id)
    for (const file of freed) {
      file.objectId = undefined
      this.#mark(file.sha256)
    }
    if (this.activeObjectId === id) this.activeObjectId = undefined
    if (freed.length > 0) this.#deselect()
    this.#discard(object)
    this.#say('assistant', `${refer(object)} wurde gelöscht.${freed.length > 0 ? ' Die Dateien sind wieder frei.' : ''}`)
  }

  /** Takes files out of their objects. An object that has no file left stays; it can be deleted. */
  detach(shas: string[]) {
    const files = this.files.filter((f) => {
      const owner = shas.includes(f.sha256) && f.objectId ? this.objects.find((o) => o.id === f.objectId) : undefined
      return !!owner && this.writable(owner)
    })
    if (files.length === 0) return
    const log: string[] = []
    const notes: string[] = []
    const freed: FileRecord[] = []
    const from = new Map<ObjectRecord, string[]>()
    for (const file of files) {
      const object = this.objects.find((o) => o.id === file.objectId)
      if (!object) continue
      try {
        // If the YAML does not list the file (any more), only the link is cut.
        const listed = readValue(object.text, 'files')
        const inYaml = Array.isArray(listed) && listed.some((entry) => (entry as { sha256?: unknown } | null)?.sha256 === file.sha256)
        this.#leave(file, object, inYaml ? removeFile(object.text, file.sha256) : object.text)
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
    if (log.length) this.#say('log', log.join('\n'))
    if (told.length || notes.length) this.#say('assistant', [...told, ...notes].join(' '))
    if (freed.length) this.#deselect()
  }

  /** Nothing is selected and no object is open: what was just taken out of an object must not look picked. */
  #deselect() {
    this.picked = false
    this.selection = []
    this.#anchor = undefined
    this.active = undefined
    this.activeObjectId = undefined
    this.#markUi()
    this.focusTick++
  }

  /** The file leaves its object; `text` is the object's new YAML. */
  #leave(file: FileRecord, from: ObjectRecord, text: string) {
    from.text = text
    from.updatedAt = Date.now()
    this.#markObject(from.id)
    file.objectId = undefined
    this.#mark(file.sha256)
  }

  /** Takes an object out of the session. If it is on the branch (or on its way there), the next save removes it from there. */
  #discard(object: ObjectRecord) {
    this.objects = this.objects.filter((o) => o.id !== object.id)
    this.#dirtyObjects.delete(object.id)
    this.#removedObjects.add(object.id)
    const session = this.#sessionOf(object)
    if (session && (object.synced !== undefined || this.#syncing)) {
      const title = readField(object.text, 'title')
      session.deleted.push({ id: object.id, title: typeof title === 'string' ? title : undefined })
      this.#dirtySessions.add(session.id)
    }
    this.#say('log', `Objekt ${object.number} gelöscht.`)
    this.#schedule()
    this.#syncAfterApp()
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
    const selected = this.chatObjects
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
    const object = this.shown.find((o) => o.number === call.object)
    if (!object) {
      out.notes.push(`Objekt ${call.object} gibt es nicht.`)
      return undefined
    }
    if (!this.writable(object)) {
      out.notes.push(this.#refuse(object))
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
    } else if (call.for === 'holder') {
      // The holder is part of the original: original.holder.
      field = 'original'
      const original = readValue(object.text, 'original')
      const holder = typeof original === 'object' && original !== null && !Array.isArray(original) ? (original as { holder?: unknown }).holder : undefined
      if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) {
        out.notes.push(`${refer(object)}: ${FIELD_NAMES.holder} ist nicht angegeben, deshalb habe ich keine Koordinaten gesetzt.`)
        return undefined
      }
      old = original
      value = { ...(original as object), holder: { ...holder, geocode: point } }
      where = FIELD_NAMES.holder
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
    // Without files (none selected) or with external places: an object of its own, no files.
    if ((call.external && call.external.length > 0) || target.length === 0) return this.#createFileless(call, out)
    if (!call.type) {
      out.notes.push('Ich weiß nicht, ob das ein Bild oder ein Dokument ist.')
      return []
    }
    if (free.length === 0) {
      out.notes.push('Die Dateien gehören schon zu einem Objekt.')
      return []
    }
    const session = this.#openSession()
    if (!session) {
      out.notes.push(`Die Erfassung „${this.current?.name}“ ist ${this.current?.state === 'merged' ? 'übernommen' : 'eingereicht'}. Wähle oben eine andere Erfassung oder lege eine neue an.`)
      return []
    }
    const together = call.type === 'document' && call.together !== false
    const groups = together ? [[...free].sort(byName)] : free.map((f) => [f])
    const created: ObjectRecord[] = []
    const appliedBy = new Map<string, string[]>()

    for (const group of groups) {
      const id = ulid()
      // Numbers (and with them the colors) start again in every session.
      const number = Math.max(0, ...this.objects.filter((o) => o.sessionId === session.id).map((o) => o.number)) + 1
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

      this.objects.push({ id, number, text, updatedAt: Date.now(), sessionId: session.id })
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

  /** An object that lives elsewhere: no files, only the places where it can be found. */
  #createFileless(call: Extract<ToolCall, { tool: 'create_object' }>, out: Out): ObjectRecord[] {
    const session = this.#openSession()
    if (!session) {
      out.notes.push(this.#frozen())
      return []
    }
    const places = (call.external ?? [])
      .map((place) => Object.fromEntries(PLACE_KEYS.flatMap((key) => (typeof place?.[key] === 'string' && place[key] ? [[key, place[key]]] : []))))
      .filter((place) => Object.keys(place).length > 0)
    const external = places.length > 0

    const id = ulid()
    const number = Math.max(0, ...this.objects.filter((o) => o.sessionId === session.id).map((o) => o.number)) + 1
    let text = newObjectText(id, call.type, call.subtype)
    const applied: string[] = []
    const fields: Record<string, unknown> = { ...(call.fields ?? {}), ...(external ? { storage: 'external', external: places } : {}) }
    for (const [field, value] of Object.entries(fields)) {
      const result = setField(text, field, value, undefined)
      if (result.ok) {
        text = result.text
        if (field !== 'storage') applied.push(FIELD_NAMES[field] ?? field)
      }
    }
    this.objects.push({ id, number, text, updatedAt: Date.now(), sessionId: session.id })
    this.#markObject(id)
    const object = this.objects[this.objects.length - 1]

    const what = external ? `${objectLabel(call.type, call.subtype)}, extern` : call.type ? objectLabel(call.type, call.subtype) : 'leer'
    const open = missing(object.text)
    out.log.push(`Objekt ${number} angelegt: ${what}.${open.length ? ` Es fehlt noch: ${open.join(', ')}.` : ''}`)
    const change = this.#change(out, object)
    change.created = what
    change.set.push(...applied)
    return [object]
  }

  /** The "+" above the objects: an empty object, opened and ready to be described (with or without files). */
  addObject() {
    const session = this.#openSession()
    if (!session) {
      this.#say('assistant', this.#frozen())
      return
    }
    const id = ulid()
    const number = Math.max(0, ...this.objects.filter((o) => o.sessionId === session.id).map((o) => o.number)) + 1
    this.objects.push({ id, number, text: newEmptyText(id), updatedAt: Date.now(), sessionId: session.id })
    this.#markObject(id)
    this.#say('log', `Objekt ${number} angelegt.`)
    this.activate(id)
  }

  /** Why nothing can be added to the shown session. */
  #frozen(): string {
    return `Die Erfassung „${this.current?.name}“ ist ${this.current?.state === 'merged' ? 'übernommen' : 'eingereicht'}. Wähle oben eine andere Erfassung oder lege eine neue an.`
  }

  #patch(call: Extract<ToolCall, { tool: 'patch' }>, out: Out): ObjectRecord | undefined {
    const object = this.shown.find((o) => o.number === call.object)
    if (!object) {
      out.notes.push(`Objekt ${call.object} gibt es nicht.`)
      return undefined
    }
    if (!this.writable(object)) {
      out.notes.push(this.#refuse(object))
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
    if (files.length === 0) {
      // Objects that live elsewhere have no files: the first of them is shown.
      const first = objects.find((o) => isExternal(o.text))
      if (!first) return
      this.selection = []
      this.active = undefined
      this.activeObjectId = first.id
      this.#anchor = undefined
      this.#markUi()
      return
    }
    this.activeObjectId = undefined
    this.active = files[0].sha256
    this.selection = files.map((f) => f.sha256)
    this.#anchor = files[0].sha256
    this.#markUi()
  }

  /** The user changed the text in the editor. */
  updateText(text: string) {
    const object = this.activeObject
    if (!object || !this.writable(object)) return
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
    const sessions = [...this.#dirtySessions].flatMap((id) => this.sessions.filter((s) => s.id === id))
    this.#dirtySessions.clear()
    const removedSessions = [...this.#removedSessions]
    this.#removedSessions.clear()
    const chat = this.#dirtyChat
    this.#dirtyChat = false
    const ui = this.#dirtyUi
    this.#dirtyUi = false
    if (files.length === 0 && objects.length === 0 && removed.length === 0 && removedFiles.length === 0 && sessions.length === 0 && removedSessions.length === 0 && !chat && !ui) return

    this.saveState = 'saving'
    try {
      // A plain copy is needed: reactive objects cannot be stored. Progress is not kept.
      const plainFiles = files.map((f) => ({ ...$state.snapshot(f), progress: undefined }))
      await db.save(plainFiles, objects.map((o) => $state.snapshot(o)), chat ? $state.snapshot(this.chat.slice(-200)) : undefined,
        removed,
        ui ? { selection: $state.snapshot(this.selection), active: this.active, object: this.activeObjectId, session: this.currentId } : undefined,
        removedFiles,
        sessions.map((s) => $state.snapshot(s)),
        removedSessions,
      )
      this.saveState = 'saved'
    } catch (error) {
      console.error('Saving to the browser storage failed', error)
      // Some browsers refuse the pictures (Safari in a private window): then at least the rest is kept.
      try {
        const plainFiles = files.map((f) => withoutBlobs({ ...$state.snapshot(f), progress: undefined }))
        await db.save(plainFiles, objects.map((o) => $state.snapshot(o)), chat ? $state.snapshot(this.chat.slice(-200)) : undefined,
          removed,
          ui ? { selection: $state.snapshot(this.selection), active: this.active, object: this.activeObjectId, session: this.currentId } : undefined,
          removedFiles,
          sessions.map((s) => $state.snapshot(s)),
          removedSessions,
        )
        this.picturesKept = false
        this.saveState = 'saved'
      } catch (again) {
        console.error('Saving without the pictures failed too', again)
        this.saveState = 'failed'
      }
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
      this.login = user ? { state: 'user', user } : { state: 'anonymous', notice }
      if (user) {
        void this.#begin()
        this.#syncAfterApp()
        void this.checkPulls()
      }
    } catch (error) {
      this.login = { state: 'error', message: (error as Error).message }
    }
  }

  /** The server says the session is over. What is in the browser stays. */
  signedOut() {
    if (this.login.state === 'anonymous') return
    this.#stopTimers()
    this.#started = false
    this.login = { state: 'anonymous', notice: 'Deine Sitzung ist abgelaufen. Bitte melde dich neu an.' }
  }

  async logout() {
    await this.#backend.logout()
    this.#stopTimers()
    this.#dropAuto()
    this.#started = false
    this.login = { state: 'anonymous' }
  }

  /** Where an object stands: it follows its session once it is saved. */
  standing(object: ObjectRecord): Standing {
    const session = this.#sessionOf(object)
    if (session && session.state !== 'open') return session.state
    if (this.savingObjects.includes(object.id)) return 'saving'
    if (session && this.failedSessions.includes(session.id) && object.text !== object.synced) return 'failed'
    if (object.synced === undefined) return 'local'
    if (object.text !== object.synced) return 'changed'
    return 'saved'
  }

  #typingPending = false

  #stopTimers() {
    clearTimeout(this.#appTimer)
    clearTimeout(this.#typingTimer)
    this.#typingPending = false
  }

  /**
   * The person turns to something else (another object, another session, another window): what was typed so far
   * is saved now and not after the quiet half minute.
   */
  leave() {
    if (this.#typingPending) void this.sync()
  }

  /** The app changed something: save in a second (the changes of one answer go into one commit). */
  #syncAfterApp() {
    if (this.login.state !== 'user') return
    clearTimeout(this.#appTimer)
    this.#appTimer = setTimeout(() => void this.sync(), APP_DELAY)
  }

  /** The person typed: save when it has been quiet for a while, or earlier if the app saves anyway. */
  #syncAfterTyping(delay = TYPING_DELAY) {
    if (this.login.state !== 'user') return
    clearTimeout(this.#typingTimer)
    this.#typingPending = delay === TYPING_DELAY
    this.#typingTimer = setTimeout(() => void this.sync(), delay)
  }

  /** Clears everything stored in the browser and starts again. What is on GitHub and in the bucket stays. */
  async resetAll() {
    this.#stopTimers()
    await db.reset()
    location.reload()
  }

  /**
   * Commands typed into the chat. `/clear!` starts again with an empty browser (it is not documented; the
   * exclamation mark is there so that nobody types it by accident). Returns whether the text was a command.
   */
  command(text: string): boolean {
    const word = text.trim()
    if (word === '/clear!') {
      void this.resetAll()
      return true
    }
    return false
  }

  /** Saves every open session: its changed objects in one commit on its branch, and removes what was deleted. Returns whether everything is saved. */
  async sync(): Promise<boolean> {
    this.#stopTimers()
    if (this.login.state !== 'user') return false
    if (this.#syncing) {
      this.#syncAgain = true
      return false
    }
    const work = this.sessions
      .filter((s) => s.state === 'open')
      .map((session) => ({
        session,
        todo: this.objects.filter((o) => o.sessionId === session.id && o.text !== o.synced).map((object) => ({ object, text: object.text })),
        deleted: [...session.deleted],
      }))
      .filter((w) => w.todo.length > 0 || w.deleted.length > 0)
    // A session with nothing left to save has nothing that failed (e.g. the change was undone).
    this.failedSessions = this.failedSessions.filter((id) => work.some((w) => w.session.id === id))
    if (work.length === 0) {
      if (this.syncState === 'failed') this.syncState = 'idle'
      this.syncError = undefined
      return true
    }

    this.#syncing = true
    this.syncState = 'saving'
    let ok = false
    let failure: Error | undefined
    let signedOut = false
    for (const { session, todo, deleted } of work) {
      const started = Date.now()
      this.savingSessions.push(session.id)
      this.savingObjects.push(...todo.map(({ object }) => object.id))
      try {
        const pull = await this.#backend.save(this.#ref(session), todo.map(({ object, text }) => ({ id: object.id, text, change: object.synced === undefined ? ('new' as const) : ('changed' as const) })), deleted)
        for (const { object, text } of todo) {
          object.synced = text
          this.#dirtyObjects.add(object.id)
        }
        session.deleted = session.deleted.filter((entry) => !deleted.some((d) => d.id === entry.id))
        if (pull) {
          session.pull = pull.number
          session.url = pull.url
        }
        this.#dirtySessions.add(session.id)
        this.failedSessions = this.failedSessions.filter((id) => id !== session.id)
      } catch (error) {
        if (error instanceof SignedOut) {
          signedOut = true
          break
        }
        if (error instanceof Locked) {
          // Submitted from somewhere else (or before this browser knew): what was changed here is not taken any more.
          session.state = 'submitted'
          this.#dirtySessions.add(session.id)
          this.#say('status', `Die Erfassung „${session.name}“ war leider schon eingereicht (vielleicht in einem anderen Browser oder Tab). Deine Änderungen konnten nicht mehr gesichert werden.`)
        } else {
          failure ??= error as Error
          if (!this.failedSessions.includes(session.id)) this.failedSessions.push(session.id)
        }
      } finally {
        // Even a quick save shows for a moment, so that it can be seen that something happened.
        const ids = todo.map(({ object }) => object.id)
        setTimeout(() => {
          this.savingSessions.splice(this.savingSessions.indexOf(session.id), 1)
          for (const id of ids) this.savingObjects.splice(this.savingObjects.indexOf(id), 1)
        }, Math.max(0, MIN_SAVING - (Date.now() - started)))
      }
    }
    this.#schedule()
    if (signedOut) {
      this.syncState = 'idle'
    } else if (failure) {
      this.syncState = 'failed'
      this.syncError = failure.message
      this.#syncAfterTyping(SYNC_RETRY)
    } else {
      this.syncState = 'idle'
      this.syncError = undefined
      ok = true
    }
    this.#syncing = false
    if (this.#syncAgain) {
      this.#syncAgain = false
      this.#syncAfterApp()
    }
    return ok && this.unsaved.length === 0 && !this.sessions.some((s) => s.state === 'open' && s.deleted.length > 0)
  }

  /** Saves what is open, then submits the shown session. Tells the person in the chat what came of it. */
  async submit() {
    const session = this.current
    if (this.submitting || this.login.state !== 'user' || !session || session.state !== 'open') return
    const objects = this.shown
    if (objects.length === 0) return
    this.submitting = true
    try {
      const open = objects.filter((o) => validateObjectYaml(o.text).length > 0)
      if (open.length > 0) {
        const list = open.slice(0, 3).map(refer).join(', ') + (open.length > 3 ? ', …' : '')
        this.#say('status', `Wir können erst einreichen, wenn alle Objekte vollständig sind. Noch offen: ${list}.`)
        return
      }
      // Not syncing in the middle of an edit: wait for a running save, then save the rest.
      while (this.#syncing) await new Promise((resolve) => setTimeout(resolve, 100))
      if (!(await this.sync())) {
        this.#say('status', `Das Einreichen ging nicht, weil das Speichern nicht geklappt hat${this.syncError ? `: ${this.syncError}` : '.'}`)
        return
      }
      if (session.state !== 'open') return // it turned out to be submitted already
      const pull = await this.#backend.submit(this.#ref(session))
      session.state = 'submitted'
      session.pull = pull.number
      session.url = pull.url
      this.#dirtySessions.add(session.id)
      this.#schedule()
      const n = objects.length
      this.#say('assistant', `Ich habe die Erfassung „${session.name}“ mit ${n === 1 ? 'einem Objekt' : `${n} Objekten`} eingereicht. Sie wird jetzt geprüft. Du kannst in einer anderen Erfassung weitermachen.`)
      this.#ensureOpen(true)
    } catch (error) {
      if (error instanceof Locked) {
        session.state = 'submitted'
        this.#dirtySessions.add(session.id)
        this.#schedule()
      } else if (!(error instanceof SignedOut)) {
        this.#say('status', `Das Einreichen ging nicht: ${(error as Error).message}`)
      }
    } finally {
      this.submitting = false
    }
  }

  /** Looks at the pull requests that wait for review: an accepted session is final, a closed one is open again. */
  async checkPulls() {
    if (this.login.state !== 'user') return
    for (const session of this.sessions.filter((s) => s.state === 'submitted' && s.pull)) {
      try {
        const pull = await this.#backend.pull(session.pull as number)
        if (pull.state === 'open') continue
        const n = this.objects.filter((o) => o.sessionId === session.id).length
        if (pull.merged) {
          session.state = 'merged'
          this.#say('assistant', `Die Erfassung „${session.name}“ wurde geprüft und übernommen (${n === 1 ? 'ein Objekt' : `${n} Objekte`}). Danke!`)
        } else {
          // Closed without being accepted: the branch is still there, the session can be revised and submitted again.
          session.state = 'open'
          session.pull = undefined
          session.url = undefined
          this.#say('status', `Die Einreichung der Erfassung „${session.name}“ wurde nicht übernommen. Du kannst sie überarbeiten und erneut einreichen.`)
        }
        this.#dirtySessions.add(session.id)
        this.#schedule()
      } catch {
        return // no connection or signed out: next time
      }
    }
  }
}
