// The database tab: the objects that are in the archive. They come from the copy in the browser
// (archive-mirror.ts), which is kept equal to main of the data repository; the list and the title search
// work on that copy.

import { readField, readValue } from '@tamandua/core'
import { Mirror, type MirrorBackend, type MirrorRecord } from './archive-mirror.js'
import { loadArchive, saveArchive } from './db.js'
import { placeOf } from './labels.js'

export interface Entry {
  id: string
  /** The hash of the file this was made from. */
  sha: string
  text: string
  type?: string
  subtype?: string
  title: string
  date?: string
  external: boolean
  /** Where an external object is, in a word. */
  place: string
  /** The title without capitals and accents, for searching. */
  folded: string
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function entryOf(record: MirrorRecord): Entry {
  const { text } = record
  const title = readField(text, 'title') ?? ''
  const date = readValue(text, 'date')
  const external = readField(text, 'storage') === 'external'
  return {
    id: record.id,
    sha: record.sha,
    text,
    type: readField(text, 'type'),
    subtype: readField(text, 'subtype'),
    title,
    date: typeof date === 'string' || typeof date === 'number' ? String(date) : undefined,
    external,
    place: external ? placeOf(readValue(text, 'external')) : '',
    folded: fold(title),
  }
}

/** How often the repository is asked whether something changed, as long as nobody tells us (and the page is visible). */
const POLL_MS = 60_000
/** How often the copy is compared with everything on main, to be sure. */
const VERIFY_MS = 30 * 60_000

export class ArchiveDb {
  /** `loading`: nothing to show yet; `ready`: there is a copy (maybe being brought up to date); `failed`: no copy and no way to get one. */
  state = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  error = $state('')
  /** Whether the copy is being brought up to date right now. */
  syncing = $state(false)
  /** The last attempt to bring it up to date failed (the copy that is there is shown anyway). */
  stale = $state(false)
  entries = $state.raw<Entry[]>([])
  query = $state('')
  selectedId = $state<string>()
  #mirror: Mirror
  #cache = new Map<string, Entry>()
  #timer: ReturnType<typeof setInterval> | undefined
  #lastVerified = 0
  #started = false

  constructor(backend: MirrorBackend) {
    this.#mirror = new Mirror(
      {
        load: loadArchive,
        replace: (synced, records) => saveArchive(synced, records, [], true),
        apply: (synced, put, remove) => saveArchive(synced, put, remove),
      },
      backend,
      () => this.#publish(),
    )
  }

  /** The entries that match the search words (all of them must be in the title), by title. */
  get shown(): Entry[] {
    const words = fold(this.query).split(/\s+/).filter(Boolean)
    return this.entries.filter((e) => words.every((w) => e.folded.includes(w)))
  }

  get selected(): Entry | undefined {
    return this.entries.find((e) => e.id === this.selectedId)
  }

  /** Shows what the browser kept, then keeps the copy up to date for as long as the page is open (until `stop`). */
  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    this.state = 'loading'
    try {
      await this.#mirror.open()
    } catch {
      // the browser's storage does not work: start from nothing
    }
    await this.refresh()
    this.#timer = setInterval(() => {
      if (!document.hidden) void this.refresh()
    }, POLL_MS)
    document.addEventListener('visibilitychange', this.#visible)
  }

  stop(): void {
    this.#started = false
    clearInterval(this.#timer)
    document.removeEventListener('visibilitychange', this.#visible)
  }

  #visible = () => {
    if (!document.hidden) void this.refresh()
  }

  /** Brings the copy up to date (all of it from time to time, or when asked to). */
  async refresh(full = false): Promise<void> {
    this.syncing = true
    try {
      const verify = full || !this.#mirror.synced || Date.now() - this.#lastVerified > VERIFY_MS
      await this.#mirror.sync(verify)
      if (verify) this.#lastVerified = Date.now()
      this.stale = false
      this.state = 'ready'
    } catch (error) {
      this.stale = true
      if (this.#mirror.synced) {
        this.state = 'ready' // there is a copy: show it
      } else {
        this.error = error instanceof Error ? error.message : 'Unbekannter Fehler.'
        this.state = 'failed'
      }
    } finally {
      this.syncing = false
    }
  }

  #publish(): void {
    const next = new Map<string, Entry>()
    for (const record of this.#mirror.records.values()) {
      // An object is only read again if its file changed.
      const kept = this.#cache.get(record.path)
      next.set(record.path, kept && kept.sha === record.sha ? kept : entryOf(record))
    }
    this.#cache = next
    this.entries = [...next.values()].sort((a, b) => a.title.localeCompare(b.title, 'de'))
    if (!this.entries.some((e) => e.id === this.selectedId)) this.selectedId = undefined
  }
}
