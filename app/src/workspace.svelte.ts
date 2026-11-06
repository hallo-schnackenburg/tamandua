// The state of the whole work session and what can be done with it. Components only
// show it and call its methods. The `.svelte.ts` ending lets this file use runes
// (`$state`) outside of a component: everything declared with `$state` here updates
// whatever shows it, wherever that is.

import { addFile, ulid, type FileEntry } from '@archive/core'
import * as db from './db.js'
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

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true })

export class Workspace {
  files = $state<FileRecord[]>([])
  objects = $state<ObjectRecord[]>([])
  pending = $state<Pending[]>([])
  notices = $state<string[]>([])
  /** SHA-256 of the selected files. */
  selection = $state<string[]>([])
  /** The last file clicked; its object is shown in the editor. */
  active = $state<string>()
  saveState = $state<'saved' | 'saving' | 'failed'>('saved')

  #store: FileStore
  #anchor: string | undefined
  #queue: File[] = []
  #busy = false
  #dirtyFiles = new Set<string>()
  #dirtyObjects = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(store: FileStore) {
    this.#store = store
  }

  /** The object of the active file, if it has one. */
  get activeObject(): ObjectRecord | undefined {
    const file = this.files.find((f) => f.sha256 === this.active)
    return file?.objectId ? this.objects.find((o) => o.id === file.objectId) : undefined
  }

  async load() {
    try {
      const [files, objects] = await Promise.all([db.loadFiles(), db.loadObjects()])
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
    this.#queue.push(...[...list].sort(byName)) // scans are usually numbered: natural order by name
    void this.#run()
  }

  async #run() {
    if (this.#busy) return
    this.#busy = true
    for (let file = this.#queue.shift(); file; file = this.#queue.shift()) await this.#ingest(file)
    this.#busy = false
  }

  async #ingest(file: File) {
    this.pending.push({ name: file.name, state: 'hashing', progress: 0 })
    const item = this.pending[this.pending.length - 1] // the reactive version
    try {
      const { entry, preview } = await prepareFile(file, (fraction) => (item.progress = fraction))
      const sha256 = entry.sha256 as string
      const existing = this.files.find((f) => f.sha256 === sha256)
      if (existing && existing.status !== 'error') {
        this.notices.push(`„${file.name}“ ist schon in der Liste (als „${existing.name}“).`)
      } else if (existing) {
        void this.#upload(existing, file) // try again after an error
      } else {
        this.files.push({ sha256, name: file.name, bytes: file.size, entry, preview, status: 'uploading', addedAt: Date.now() })
        void this.#upload(this.files[this.files.length - 1], file)
      }
      this.pending = this.pending.filter((p) => p !== item)
    } catch (error) {
      item.state = 'error'
      item.message = (error as Error).message
    }
  }

  async #upload(record: FileRecord, file: File) {
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
  }

  dismissPending(item: Pending) {
    this.pending = this.pending.filter((p) => p !== item)
  }

  dismissNotice(index: number) {
    this.notices.splice(index, 1)
  }

  // --- selecting ---

  select(sha256: string, { range = false, toggle = false } = {}) {
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
  }

  // --- objects ---

  /**
   * Makes objects out of the selected files that do not belong to one yet.
   * A photo has one file, so every file becomes its own object. A document gets
   * all files as pages, in the order of their names.
   */
  createObjects(type: 'photo' | 'document', subtype?: string) {
    const chosen = this.files.filter((f) => this.selection.includes(f.sha256) && !f.objectId)
    const skipped = this.selection.length - chosen.length
    if (skipped > 0) this.notices.push(`${skipped} ausgewählte Datei(en) gehören schon zu einem Object und wurden übersprungen.`)
    if (chosen.length === 0) return

    const groups = type === 'photo' ? chosen.map((f) => [f]) : [[...chosen].sort(byName)]
    for (const group of groups) {
      const id = ulid()
      const number = Math.max(0, ...this.objects.map((o) => o.number)) + 1
      let text = newObjectText(id, type, type === 'document' ? subtype : undefined)
      for (const file of group) text = addFile(text, $state.snapshot(file.entry))

      this.objects.push({ id, number, text, updatedAt: Date.now() })
      this.#markObject(id)
      for (const file of group) {
        file.objectId = id
        this.#mark(file.sha256)
      }
    }
    this.active = groups[0][0].sha256
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
    if (files.length === 0 && objects.length === 0) return

    this.saveState = 'saving'
    try {
      // A plain copy is needed: reactive objects cannot be stored. Progress is not kept.
      const plainFiles = files.map((f) => ({ ...$state.snapshot(f), progress: undefined }))
      await db.save(plainFiles, objects.map((o) => $state.snapshot(o)))
      this.saveState = 'saved'
    } catch {
      this.saveState = 'failed'
    }
  }
}
