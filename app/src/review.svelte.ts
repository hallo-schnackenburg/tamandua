// The review: the sessions (Erfassungen) of everybody as GitHub has them — a pull request each — and what a person who
// has write access to the data repository does with them: look at what a submitted session changes, accept it (merge) or
// close it. Everybody in the team may; there are no roles. The state is GitHub's; this only reads it and asks for the actions.

import { checkParents } from '@tamandua/core'
import { SignedOut } from './api.js'
import type { Backend, Comment, RemoteErfassung, Review } from './backend.js'
import { entryOf, type ArchiveDb, type Entry } from './database.svelte.js'
import type { News } from './live.js'
import { validityOf } from './validity.js'

export type Filter = 'waiting' | 'drafts' | 'done'
export type Change = 'added' | 'modified' | 'removed'
export type Action = 'merge' | 'close'

/** Where the review keeps what it saw, so that it can show it at once the next time (the browser's database; none in tests). */
export interface ReviewCache {
  load(): Promise<{ id: string; value: unknown }[]>
  save(put: { id: string; value: unknown }[], remove: string[]): Promise<void>
}

/** An object of the session that is looked at, and what the session does with it. */
export interface Item {
  entry: Entry
  change: Change
}

/** How often the list is asked for again while the page is visible (when the live connection is not there). */
const POLL_MS = 60_000
/** With the live connection open it is asked anyway at this distance, in case a message got lost. */
const SAFETY_MS = 10 * 60_000

export const isDone = (e: RemoteErfassung): boolean => e.state === 'merged' || e.closed
export const isWaiting = (e: RemoteErfassung): boolean => e.state === 'submitted' && !e.closed
export const isDraft = (e: RemoteErfassung): boolean => e.state === 'open' && !e.closed

/** What of a session decides how it is shown (submitted, draft, accepted, closed). */
const stateOf = (e: RemoteErfassung): string => `${e.state}${e.closed ? '/closed' : ''}`

export class ReviewDb {
  list = $state.raw<RemoteErfassung[]>([])
  state = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  error = $state('')
  filter = $state<Filter>('waiting')
  /** The pull request of the session that is looked at, and the object of it that is shown. */
  selectedPull = $state<number>()
  selectedId = $state<string>()
  detail = $state.raw<Review>()
  detailState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  detailError = $state('')
  /** The comments on the session that is looked at, oldest first. */
  comments = $state.raw<Comment[]>([])
  commentsState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  commentsError = $state('')
  /** The action that is being done right now. */
  acting = $state<Action>()
  actionError = $state('')

  #backend: Backend
  #archive: ArchiveDb
  #me: () => string | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #unsubscribe: (() => void) | undefined
  #last = 0
  #running = false
  #again = false
  /** Only the newest request of the detail counts (the person may click on while one is on its way). */
  #loading = 0
  #loadingComments = 0
  #loadedState: string | undefined
  #cache: ReviewCache | undefined
  /** What the cache holds (the list, `detail:<n>`, `comments:<n>`), read once at the start. */
  #kept = new Map<string, unknown>()
  #restored: Promise<void> = Promise.resolve()

  /** `me`: the login of the signed-in person as it is written in a branch name. */
  constructor(backend: Backend, archive: ArchiveDb, me: () => string | undefined, cache?: ReviewCache) {
    this.#backend = backend
    this.#cache = cache
    if (cache) this.#restored = this.#restore(cache)
    this.#archive = archive
    this.#me = me
  }

  /** Reads what the browser kept and shows the list at once (if the network was not faster). */
  async #restore(cache: ReviewCache): Promise<void> {
    try {
      for (const record of await cache.load()) this.#kept.set(record.id, record.value)
      const list = this.#kept.get('list')
      if (Array.isArray(list) && this.state === 'idle') {
        this.list = list as RemoteErfassung[]
        this.state = 'ready'
      }
    } catch {
      // A cache that cannot be read is no cache.
    }
  }

  /** Remembers a record in memory and in the browser; a failure to write is no failure of the review. */
  #keep(id: string, value: unknown, remove: string[] = []): void {
    this.#kept.set(id, value)
    for (const key of remove) this.#kept.delete(key)
    void this.#cache?.save([{ id, value }], remove).catch(() => undefined)
  }

  waiting = $derived(this.list.filter(isWaiting))
  drafts = $derived(this.list.filter(isDraft))
  done = $derived(this.list.filter(isDone))

  /** The sessions of the chosen filter. */
  shown = $derived(this.filter === 'waiting' ? this.waiting : this.filter === 'drafts' ? this.drafts : this.done)

  current = $derived(this.list.find((e) => e.number === this.selectedPull))

  /** The objects of the session: what it adds, changes and removes. A removed object is shown as the archive has it. */
  items = $derived.by((): Item[] => {
    const detail = this.detail
    if (!detail) return []
    const items = detail.objects.map((o): Item => {
      if (o.status === 'removed') {
        const known = this.#archive.byId.get(o.id)
        return { entry: known ?? entryOf({ path: '', id: o.id, sha: '', text: '', data: { id: o.id } }), change: 'removed' }
      }
      return { entry: entryOf({ path: '', id: o.id, sha: '', text: o.text ?? '' }), change: o.status }
    })
    return items.sort((a, b) => a.entry.title.localeCompare(b.entry.title, 'de'))
  })

  /** The objects of the session by id (without the removed ones). */
  byId = $derived(new Map(this.items.filter((i) => i.change !== 'removed').map((i) => [i.entry.id, i.entry])))

  get selectedItem(): Item | undefined {
    return this.items.find((i) => i.entry.id === this.selectedId)
  }

  /** An object by its id: the one of the session if it is in it, else the one of the archive. */
  lookup = (id: string): Entry | undefined => this.byId.get(id) ?? this.#archive.byId.get(id)

  /** The objects that name a group as a parent, as they would be if the session were accepted. */
  membersOf = (id: string): Entry[] => {
    const mine = this.byId
    const gone = new Set(this.items.filter((i) => i.change === 'removed').map((i) => i.entry.id))
    const fromArchive = (this.#archive.members.get(id) ?? []).filter((e) => !mine.has(e.id) && !gone.has(e.id))
    const fromSession = [...mine.values()].filter((e) => e.parents.includes(id))
    return [...fromArchive, ...fromSession]
  }

  /** Object id → what is wrong with it (not fit for the archive, or its groups are wrong), for the objects of the session. */
  problems = $derived.by((): Map<string, string[]> => {
    const problems = new Map<string, string[]>()
    const add = (id: string, text: string) => problems.set(id, [...(problems.get(id) ?? []), text])
    for (const o of this.detail?.objects ?? []) {
      if (o.status === 'removed') continue
      const { state, hint } = validityOf(o.text ?? '')
      if (state !== 'valid') add(o.id, hint)
    }
    if (this.items.length > 0) {
      // The groups are checked as they would be with the session accepted.
      const touched = new Set(this.items.map((i) => i.entry.id))
      const nodes = [...this.#archive.entries.filter((e) => !touched.has(e.id)), ...this.byId.values()]
      for (const issue of checkParents(nodes)) if (this.byId.has(issue.id)) add(issue.id, issue.message)
    }
    return problems
  })

  /** Why the session cannot be accepted (in words), or nothing if it can. */
  get blocked(): string | undefined {
    const detail = this.detail
    if (!detail || detail.pull.state !== 'open' || detail.pull.draft) return undefined
    if (detail.checks === 'failure') return 'Die automatische Prüfung (Validierung) ist fehlgeschlagen.'
    if (detail.checks === 'pending') return 'Die automatische Prüfung läuft noch.'
    if (detail.mergeable === false) return 'GitHub kann diese Erfassung nicht übernehmen (Konflikt mit dem Archiv).'
    if (this.problems.size > 0) return 'Einige Objekte sind nicht in Ordnung.'
    return undefined
  }

  /**
   * Looks at GitHub now, whenever the live connection tells that a session changed, and otherwise every minute while the
   * page is visible (every ten minutes with the live connection open).
   */
  start(): void {
    if (this.#timer) return
    void this.#restored.then(() => this.refresh())
    this.#unsubscribe = this.#archive.subscribe((news) => this.#news(news))
    this.#timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (this.#archive.liveState === 'live' && Date.now() - this.#last < SAFETY_MS) return
      void this.refresh()
    }, POLL_MS)
  }

  /** News from the live connection (or that it opened): a session or a comment may have changed. */
  #news(news?: News): void {
    void this.refresh()
    const pull = this.selectedPull
    if (pull !== undefined && (!news || news.type === 'comment') && (news?.number === undefined || news.number === pull)) void this.loadComments(pull)
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }

  /** Asks GitHub for the list; what is looked at is read again if it changed. News that comes while it is asking makes it ask once more. */
  async refresh(): Promise<void> {
    if (this.#running) {
      this.#again = true
      return
    }
    this.#running = true
    try {
      do {
        this.#again = false
        await this.#refresh()
      } while (this.#again)
    } finally {
      this.#running = false
    }
  }

  async #refresh(): Promise<void> {
    if (this.state === 'idle') this.state = 'loading'
    try {
      this.#last = Date.now()
      this.list = await this.#backend.erfassungen()
      this.state = 'ready'
      // The sessions that are gone are forgotten with their objects and comments.
      const gone = [...this.#kept.keys()].filter((key) => /^(detail|comments):(\d+)$/.test(key) && !this.list.some((e) => key.endsWith(`:${e.number}`)))
      this.#keep('list', this.list, gone)
      const wanted = this.selectedPull
      if (wanted !== undefined && this.detailState !== 'loading') {
        const e = this.current
        // Changed since it was read: another commit, or another state (submitted, given back, accepted ...).
        if (!this.detail || (e && (e.head !== this.detail.head || stateOf(e) !== this.#loadedState || (e.checks !== undefined && e.checks !== this.detail.checks)))) await this.#load(wanted)
      }
    } catch (error) {
      if (error instanceof SignedOut) return
      if (this.state !== 'ready') {
        this.state = 'failed'
        this.error = (error as Error).message
      }
    }
  }

  /** Shows a session (and an object of it). */
  async select(pull: number | undefined, id?: string): Promise<void> {
    if (pull === undefined) {
      this.selectedPull = undefined
      this.selectedId = undefined
      this.detail = undefined
      this.detailState = 'idle'
      this.comments = []
      this.commentsState = 'idle'
      this.#loading++
      this.#loadingComments++
      return
    }
    this.selectedId = id
    if (pull === this.selectedPull && this.detail) return
    await this.#restored
    this.selectedPull = pull
    this.actionError = ''
    // What the browser kept of this session is shown at once; what GitHub says comes in behind it.
    const kept = this.#kept.get(`detail:${pull}`) as Review | undefined
    this.detail = kept
    this.detailState = kept ? 'ready' : 'idle'
    if (kept && !this.selectedId) this.selectedId = this.#firstObject(kept)
    const keptComments = this.#kept.get(`comments:${pull}`) as Comment[] | undefined
    this.comments = keptComments ?? []
    this.commentsState = keptComments ? 'ready' : 'idle'
    // The filter that shows it, if the person came by an address.
    const e = this.list.find((x) => x.number === pull)
    if (e) this.filter = isWaiting(e) ? 'waiting' : isDone(e) ? 'done' : 'drafts'
    await this.#load(pull)
  }

  async #load(pull: number): Promise<void> {
    const mine = ++this.#loading
    if (!this.detail) this.detailState = 'loading'
    try {
      const detail = await this.#backend.review(pull)
      if (mine !== this.#loading) return
      this.detail = detail
      this.#keep(`detail:${pull}`, detail)
      this.#loadedState = this.current && stateOf(this.current)
      this.detailState = 'ready'
      // Without a chosen object the first one is shown.
      void this.loadComments(pull)
      if (!this.selectedId || !detail.objects.some((o) => o.id === this.selectedId)) this.selectedId = this.#firstObject(detail)
    } catch (error) {
      if (mine !== this.#loading || error instanceof SignedOut) return
      // What the browser kept stays on the screen; only if there is nothing, it is a failure.
      if (this.detail) return
      this.detailState = 'failed'
      this.detailError = (error as Error).message
    }
  }

  /** The object that is shown first: the first one that is not removed. */
  #firstObject(detail: Review): string | undefined {
    const objects = detail.objects.map((o) => o.id)
    const items = this.items.length > 0 ? this.items : undefined
    if (items) return (items.find((i) => i.change !== 'removed') ?? items[0])?.entry.id
    return objects[0]
  }

  /** Reads the comments of a session (again). Only the newest request counts. */
  async loadComments(pull: number): Promise<void> {
    const mine = ++this.#loadingComments
    if (this.commentsState === 'idle') this.commentsState = 'loading'
    try {
      const comments = await this.#backend.comments(pull)
      if (mine !== this.#loadingComments || pull !== this.selectedPull) return
      this.comments = comments
      this.commentsState = 'ready'
      this.#keep(`comments:${pull}`, comments)
    } catch (error) {
      if (mine !== this.#loadingComments || error instanceof SignedOut) return
      // Comments that are on the screen stay there; only a first reading that fails is a failure.
      if (this.commentsState !== 'ready') {
        this.commentsState = 'failed'
        this.commentsError = (error as Error).message
      }
    }
  }

  /** Whether the comment was written by the signed-in person and can be changed here. */
  isOwnComment(c: Comment): boolean {
    return c.kind === 'issue' && c.login === this.#me()
  }

  /** Writes a comment on the session that is looked at. Returns whether it worked (the error is in `actionError`). */
  async comment(text: string): Promise<boolean> {
    const pull = this.selectedPull
    if (pull === undefined) return false
    return this.#commentAction(async () => {
      const made = await this.#backend.addComment(pull, text)
      // It may have arrived already through the live connection.
      if (pull === this.selectedPull && !this.comments.some((c) => c.id === made.id)) this.comments = [...this.comments, made]
      this.#keepComments(pull)
    })
  }

  async editComment(id: number, text: string): Promise<boolean> {
    return this.#commentAction(async () => {
      const changed = await this.#backend.editComment(id, text)
      this.comments = this.comments.map((c) => (c.id === id ? changed : c))
      this.#keepComments(this.selectedPull)
    })
  }

  async deleteComment(id: number): Promise<boolean> {
    return this.#commentAction(async () => {
      await this.#backend.deleteComment(id)
      this.comments = this.comments.filter((c) => c.id !== id)
      this.#keepComments(this.selectedPull)
    })
  }

  commentError = $state('')

  #keepComments(pull: number | undefined): void {
    if (pull !== undefined) this.#keep(`comments:${pull}`, this.comments)
  }

  async #commentAction(run: () => Promise<void>): Promise<boolean> {
    this.commentError = ''
    try {
      await run()
      return true
    } catch (error) {
      if (!(error instanceof SignedOut)) this.commentError = (error as Error).message
      return false
    }
  }

  /** Does what was chosen with the session that is looked at. */
  async act(action: Action): Promise<boolean> {
    const detail = this.detail
    const pull = this.selectedPull
    if (!detail || pull === undefined || this.acting) return false
    this.acting = action
    this.actionError = ''
    try {
      if (action === 'merge') await this.#backend.merge(pull, detail.head)
      else await this.#backend.reject(pull)
      await this.refresh()
      await this.#load(pull)
      // What was accepted is in the archive now: the copy in the browser is brought up to date.
      if (action === 'merge') void this.#archive.refresh()
      return true
    } catch (error) {
      if (!(error instanceof SignedOut)) this.actionError = (error as Error).message
      return false
    } finally {
      this.acting = undefined
    }
  }
}
