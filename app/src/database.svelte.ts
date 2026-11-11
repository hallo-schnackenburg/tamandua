// The database tab: the objects that are in the archive. They come from the copy in the browser
// (archive-mirror.ts), which is kept equal to main of the data repository; the list and the title search
// work on that copy.

import { checkParents, readObject } from '@tamandua/core'
import { Mirror, type Derive, type MirrorBackend, type MirrorRecord, type Progress } from './archive-mirror.js'
import { loadArchive, saveArchive } from './db.js'
import { Live } from './live.js'
import { placeOf } from './labels.js'

export interface Entry {
  id: string
  /** The hash of the file this was made from. */
  sha: string
  /** The object as plain data (what the YAML says). */
  data: Record<string, unknown>
  type?: string
  subtype?: string
  title: string
  date?: string
  /** The groups this object is in (ids). */
  parents: string[]
  external: boolean
  /** Where an external object is, in a word. */
  place: string
  /** The title without capitals and accents, for searching. */
  folded: string
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** The version of what is made of the text; raise it when `entryOf` or the detail view needs something the old `data` lacks. */
export const DATA_VERSION = 1
export const DERIVE: Derive = { version: DATA_VERSION, run: readObject }

const word = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** The list entry of a record. Reads `data` (the text is only parsed here for a record that has none, which happens in tests). */
export function entryOf(record: MirrorRecord): Entry {
  const data = record.data ?? readObject(record.text) ?? {}
  const title = word(data.title) ?? ''
  const date = data.date
  const external = word(data.storage) === 'external'
  return {
    id: record.id,
    sha: record.sha,
    data,
    type: word(data.type),
    subtype: word(data.subtype),
    title,
    date: typeof date === 'string' || typeof date === 'number' ? String(date) : undefined,
    parents: Array.isArray(data.parents) ? data.parents.filter((p): p is string => typeof p === 'string') : [],
    external,
    place: external ? placeOf(data.external) : '',
    folded: fold(title),
  }
}

/** The progress is shown from this many objects to read on (for fewer it is over before anyone could look at it). */
const SHOW_PROGRESS_FROM = 50
/** How often the repository is asked whether something changed (while the page is visible), as long as the live connection is not there. */
const POLL_MS = 60_000
/** With the live connection open, it is asked anyway at this distance, in case a message got lost. */
const SAFETY_MS = 10 * 60_000
/** How long "connecting" is shown before the connection counts as lost. */
const LIVE_WAIT_MS = 8_000
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
  /**
   * The live connection: `live` (open: changes arrive at once, the repository is asked only now and then), `connecting`
   * (just started or just lost), `lost` (it does not come back: the repository is asked every minute), `none` (no Worker, no connection).
   */
  liveState = $state<'none' | 'connecting' | 'live' | 'lost'>('none')
  /** How far a long reading is (the first one, or a big change); none for a short one. */
  progress = $state.raw<Progress>()
  entries = $state.raw<Entry[]>([])
  query = $state('')
  selectedId = $state<string>()
  #mirror: Mirror
  #cache = new Map<string, Entry>()
  #timer: ReturnType<typeof setInterval> | undefined
  #lastVerified = 0
  #lastSync = 0
  #started = false
  #channel: Live | undefined
  #giveUp: ReturnType<typeof setTimeout> | undefined

  /** `liveAddress`: the WebSocket on which the Worker tells that main moved; without it the repository is only polled. */
  constructor(backend: MirrorBackend, liveAddress?: string) {
    if (liveAddress) {
      this.liveState = 'connecting'
      this.#channel = new Live(liveAddress, () => void this.refresh(), (open) => this.#liveChanged(open))
    }
    this.#mirror = new Mirror(
      {
        load: loadArchive,
        apply: (synced, put, remove) => saveArchive(synced, put, remove),
      },
      backend,
      () => this.#publish(),
      DERIVE,
    )
    this.#mirror.onProgress = (progress) => (this.progress = progress && progress.total >= SHOW_PROGRESS_FROM ? progress : undefined)
  }

  /** The entries that match the search words (all of them must be in the title), by title. */
  get shown(): Entry[] {
    const words = fold(this.query).split(/\s+/).filter(Boolean)
    return this.entries.filter((e) => words.every((w) => e.folded.includes(w)))
  }

  /** Group id → the objects that name it as a parent (in the order of the list). Only the objects name their groups; this is the other way round. */
  members = $derived.by(() => {
    const map = new Map<string, Entry[]>()
    for (const entry of this.entries) {
      for (const parent of entry.parents) {
        const list = map.get(parent)
        if (list) list.push(entry)
        else map.set(parent, [entry])
      }
    }
    return map
  })

  /** Object id → what is wrong with its parents (a group that is not there, is none, or leads back to itself). */
  problems = $derived.by(() => {
    const map = new Map<string, string[]>()
    for (const issue of checkParents(this.entries)) {
      const list = map.get(issue.id)
      if (list) list.push(issue.message)
      else map.set(issue.id, [issue.message])
    }
    return map
  })

  get selected(): Entry | undefined {
    return this.entries.find((e) => e.id === this.selectedId)
  }

  /** Shows what the browser kept, then keeps the copy up to date for as long as the page is open (until `stop`). */
  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    if (this.state !== 'ready') this.state = 'loading'
    try {
      // What the browser kept is shown at once; the news come in behind it.
      if (await this.#mirror.open()) this.state = 'ready'
    } catch {
      // the browser's storage does not work: start from nothing
    }
    this.#channel?.start() // (it brings the copy up to date as soon as it is open)
    this.#waitForLive()
    window.addEventListener('online', this.#online)
    window.addEventListener('offline', this.#offline)
    await this.refresh()
    this.#timer = setInterval(() => {
      if (document.hidden) return
      if (this.liveState === 'live' && Date.now() - this.#lastSync < SAFETY_MS) return
      void this.refresh()
    }, POLL_MS)
    document.addEventListener('visibilitychange', this.#visible)
  }

  stop(): void {
    this.#started = false
    this.#channel?.stop()
    clearTimeout(this.#giveUp)
    if (this.#channel) this.liveState = 'connecting'
    clearInterval(this.#timer)
    window.removeEventListener('online', this.#online)
    window.removeEventListener('offline', this.#offline)
    document.removeEventListener('visibilitychange', this.#visible)
  }

  #visible = () => {
    if (document.hidden) return
    this.#channel?.nudge()
    void this.refresh()
  }

  /** The network is back: connect at once, do not wait for the next try. */
  #online = () => {
    this.#channel?.nudge()
    void this.refresh()
  }

  #offline = () => {
    if (this.#channel) this.liveState = 'lost'
  }

  #liveChanged(open: boolean): void {
    if (open) {
      clearTimeout(this.#giveUp)
      this.liveState = 'live'
    } else {
      this.#waitForLive()
    }
  }

  /** "Connecting" is shown for a moment; if it does not work then, it is "lost". */
  #waitForLive(): void {
    if (!this.#channel || this.liveState === 'live') return
    this.liveState = 'connecting'
    clearTimeout(this.#giveUp)
    this.#giveUp = setTimeout(() => {
      if (this.liveState === 'connecting') this.liveState = 'lost'
    }, LIVE_WAIT_MS)
  }

  /** Brings the copy up to date (all of it from time to time, or when asked to). */
  async refresh(full = false): Promise<void> {
    this.syncing = true
    try {
      const verify = full || !this.#mirror.synced || Date.now() - this.#lastVerified > VERIFY_MS
      await this.#mirror.sync(verify)
      if (verify) this.#lastVerified = Date.now()
      this.#lastSync = Date.now()
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
    if (this.state === 'loading' && next.size > 0) this.state = 'ready' // the snapshot is shown before the comparison with main is done
    this.entries = [...next.values()].sort((a, b) => a.title.localeCompare(b.title, 'de'))
  }
}
