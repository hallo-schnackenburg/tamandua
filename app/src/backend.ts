// The part of the app that talks to GitHub through the Worker: who is signed in, saving objects
// to the person's branch, submitting them as a pull request. The rest of the app only knows this
// interface. HttpBackend is the real one; FakeBackend stands in without a Worker.

import { jsonOf, request, SignedOut } from './api.js'
import type { MirrorBackend } from './archive-mirror.js'
import { readSnapshot } from './snapshot.js'

export interface User {
  login: string
  name: string
  avatar: string
  /** `admin` may also review and merge. */
  role: 'admin' | 'write'
  /** The address the bucket's files (previews, pictures) are read from; none if the Worker has no bucket. */
  files?: string
}

export interface Pull {
  number: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
  draft?: boolean
}

/** A session as GitHub knows it (a pull request on a branch erfassung/<login>/<slug>). */
export interface RemoteErfassung {
  number: number
  url: string
  state: 'open' | 'submitted' | 'merged'
  /** Closed without being merged: its branch is there, but its pull request is not open any more. */
  closed: boolean
  login: string
  slug: string
  name: string
  createdAt: string
  head: string
  /** How the checks stand, for a session waiting for review. */
  checks?: Checks
}

/** How the automatic checks (the validation of the data) of a session stand. */
export type Checks = 'none' | 'pending' | 'failure' | 'success' | 'unknown'

/** A session as it is looked at for review: what it changes, and whether it can be accepted. */
export interface Review {
  head: string
  /** The address of the bucket's files, if the Worker knows it. */
  files?: string
  pull: Pull
  /** Whether GitHub can merge it; null while it does not know. */
  mergeable: boolean | null
  checks: Checks
  /** What the session does with each object; the text is the one of the session (none for a removed object). */
  objects: { id: string; status: 'added' | 'modified' | 'removed'; text?: string }[]
  /** The commit that was asked about (`since`) is still the head: nothing was read, `objects` is empty. */
  unchanged?: true
}

/** A comment on a session. */
export interface Comment {
  id: number
  /** `issue`: written in the app or on the pull request (can be changed here); `review`: on a file of the pull request, written on GitHub. */
  kind: 'issue' | 'review'
  login: string
  avatar: string
  text: string
  createdAt: string
  /** It was changed after it was written. */
  edited: boolean
  /** The object a comment on a file line (kind 'review') belongs to. */
  object?: string
  field?: string
}

/** What a session holds on GitHub: its objects (YAML text) and where to read the files' previews from. */
export interface RemoteContent {
  head: string
  /** The address of the bucket's files, if the Worker knows it. */
  files?: string
  objects: { id: string; text: string }[]
}

/** What the Worker needs to know of a session: the branch is made from `slug`, the pull request is titled with `name`. */
export interface SessionRef {
  slug: string
  name: string
  /** The login the branch is named after, if the session was started by somebody else. */
  owner?: string
}

/** What a save leaves behind: the session's pull request (if there is one) and the branch's new commit (if anything changed). */
export interface SaveResult {
  pull?: Pull
  head?: string
}

/** An object as it is sent: whether the branch has it already decides the mark in the commit message. */
export interface SavedObject {
  id: string
  text: string
  change: 'new' | 'changed'
}

/** A deleted object; its title is for the commit message (the app remembers it, the branch is not asked). */
export interface Removed {
  id: string
  title?: string
}

export interface Backend {
  /** The signed-in person, or undefined if nobody is. Throws if the server cannot be asked. */
  me(): Promise<User | undefined>
  /**
   * Puts the objects (id and YAML text) into one commit on the session's branch and removes the deleted
   * ones from it. Returns the pull request of the session, if there is one.
   */
  save(session: SessionRef, objects: SavedObject[], deleted: Removed[]): Promise<SaveResult>
  /** Marks the pull request of the session as ready for review. */
  submit(session: SessionRef): Promise<Pull>
  /** Gives the pull request of the session its new name, if it has one. */
  rename(session: SessionRef): Promise<void>
  pull(number: number): Promise<Pull>
  /** The sessions of everybody (newest first, up to a hundred). */
  erfassungen(): Promise<RemoteErfassung[]>
  /** The objects of one session, with their text. */
  erfassung(number: number): Promise<RemoteContent>
  /** A session as it is looked at for review. */
  review(number: number, since?: string): Promise<Review>
  /** Accepts a submitted session (`head`: the commit that was looked at; if it changed since, this fails). */
  merge(number: number, head: string): Promise<Pull>
  /** Closes a submitted session without accepting it. */
  reject(number: number): Promise<Pull>
  /** The comments on a session, oldest first. */
  comments(number: number): Promise<Comment[]>
  /** Writes a comment on the session. */
  addComment(number: number, text: string): Promise<Comment>
  /** Changes the text of a comment (the person's own). */
  editComment(id: number, text: string): Promise<Comment>
  deleteComment(id: number): Promise<void>
  /** What the copy of the archive needs from the repository (see archive-mirror.ts). */
  readonly archive: MirrorBackend
  /** A file from the bucket (a preview), or undefined if it cannot be had. */
  fetchFile(base: string, path: string): Promise<Blob | undefined>
  logout(): Promise<void>
  /** Where the browser goes to sign in. */
  readonly loginUrl: string
}

const MAX_PER_SAVE = 50
/** How many objects are read from GitHub at once. */
const READ_PARALLEL = 6

/** The texts are read from GitHub directly, at a commit: a public address that never changes its content. */
async function readTexts(raw: string, wanted: { id: string; path: string }[], progress?: (done: number) => void): Promise<{ id: string; text: string }[]> {
  const objects: { id: string; text: string }[] = []
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const object = wanted[next++]
      const text = await fetch(`${raw}/${object.path}`)
      if (!text.ok) throw new Error(`Objekt ${object.id} konnte nicht gelesen werden (${text.status}).`)
      objects.push({ id: object.id, text: await text.text() })
      progress?.(objects.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_PARALLEL, wanted.length) }, worker))
  return objects.sort((a, b) => a.id.localeCompare(b.id))
}

export class HttpBackend implements Backend {
  #url: string
  readonly loginUrl: string

  constructor(url: string) {
    this.#url = url.replace(/\/$/, '')
    this.loginUrl = `${this.#url}/auth/login`
  }

  async me(): Promise<User | undefined> {
    const response = await request(`${this.#url}/auth/me`).catch((error) => {
      if (!(error instanceof SignedOut)) throw error
      return undefined
    })
    if (!response) return undefined
    if (!response.ok) throw new Error((await jsonOf<object>(response)).error ?? `Fehler ${response.status}`)
    return (await response.json()) as User
  }

  async save(session: SessionRef, objects: SavedObject[], deleted: Removed[]): Promise<SaveResult> {
    let pull: Pull | undefined
    let head: string | undefined
    for (let o = 0, d = 0; o < objects.length || d < deleted.length; o += MAX_PER_SAVE, d += MAX_PER_SAVE) {
      const response = await request(`${this.#url}/repo/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, objects: objects.slice(o, o + MAX_PER_SAVE), deleted: deleted.slice(d, d + MAX_PER_SAVE) }),
      })
      const data = await jsonOf<{ pull?: Pull; commit?: string | null }>(response)
      if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
      pull = data.pull ?? pull
      head = data.commit ?? head
    }
    return { pull, head }
  }

  async submit(session: SessionRef): Promise<Pull> {
    const response = await request(`${this.#url}/repo/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    const data = await jsonOf<Pull>(response)
    if (response.status === 409) throw new Error('Es gibt nichts Neues einzureichen.')
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data
  }

  async rename(session: SessionRef): Promise<void> {
    const response = await request(`${this.#url}/repo/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    if (!response.ok) throw new Error((await jsonOf<object>(response)).error ?? `Fehler ${response.status}`)
  }

  async pull(number: number): Promise<Pull> {
    const response = await request(`${this.#url}/repo/pull/${number}`)
    const data = await jsonOf<Pull>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data
  }

  async erfassungen(): Promise<RemoteErfassung[]> {
    const response = await request(`${this.#url}/repo/erfassungen`)
    const data = await jsonOf<{ erfassungen: RemoteErfassung[] }>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data.erfassungen
  }

  async erfassung(number: number): Promise<RemoteContent> {
    const response = await request(`${this.#url}/repo/erfassung/${number}`)
    const data = await jsonOf<{ head: string; raw: string; files?: string; objects: { id: string; path: string; status: string }[] }>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return { head: data.head, files: data.files, objects: await readTexts(data.raw, data.objects.filter((o) => o.status !== 'removed')) }
  }

  async review(number: number, since?: string): Promise<Review> {
    const response = await request(`${this.#url}/repo/erfassung/${number}${since ? '?light' : ''}`)
    const data = await jsonOf<Omit<Review, 'objects'> & { raw: string; objects: { id: string; path: string; status: Review['objects'][number]['status'] }[] }>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    if (since && data.head === since) return { head: data.head, files: data.files, pull: data.pull, mergeable: data.mergeable, checks: data.checks, objects: [], unchanged: true }
    const texts = new Map((await readTexts(data.raw, data.objects.filter((o) => o.status !== 'removed'))).map((o) => [o.id, o.text]))
    return {
      head: data.head,
      files: data.files,
      pull: data.pull,
      mergeable: data.mergeable,
      checks: data.checks,
      objects: data.objects.map((o) => ({ id: o.id, status: o.status, text: texts.get(o.id) })),
    }
  }

  async #act(what: 'merge' | 'close', body: object): Promise<Pull> {
    const response = await request(`${this.#url}/repo/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await jsonOf<Pull>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data
  }

  merge(number: number, head: string): Promise<Pull> {
    return this.#act('merge', { number, head })
  }

  reject(number: number): Promise<Pull> {
    return this.#act('close', { number })
  }

  async comments(number: number): Promise<Comment[]> {
    const response = await request(`${this.#url}/repo/erfassung/${number}/comments`)
    const data = await jsonOf<{ comments: Comment[] }>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data.comments
  }

  async #comment(method: string, path: string, body?: object): Promise<Comment> {
    const response = await request(`${this.#url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    const data = await jsonOf<{ comment: Comment }>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data.comment
  }

  addComment(number: number, text: string): Promise<Comment> {
    return this.#comment('POST', `/repo/erfassung/${number}/comments`, { text })
  }

  editComment(id: number, text: string): Promise<Comment> {
    return this.#comment('PATCH', `/repo/comment/${id}`, { text })
  }

  async deleteComment(id: number): Promise<void> {
    const response = await request(`${this.#url}/repo/comment/${id}`, { method: 'DELETE' })
    if (!response.ok) throw new Error((await jsonOf<object>(response)).error ?? `Fehler ${response.status}`)
  }

  readonly archive: MirrorBackend = {
    tree: async () => {
      const response = await request(`${this.#url}/repo/objects`)
      const data = await jsonOf<Awaited<ReturnType<MirrorBackend['tree']>>>(response)
      if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
      return data
    },
    changes: async (since) => {
      const response = await request(`${this.#url}/repo/changes?since=${encodeURIComponent(since)}`)
      const data = await jsonOf<Awaited<ReturnType<MirrorBackend['changes']>>>(response)
      if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
      return data
    },
    texts: readTexts,
    snapshot: async (progress) => {
      const response = await request(`${this.#url}/repo/snapshot`)
      if (!response.ok) return undefined
      const { url } = await jsonOf<{ url?: unknown }>(response)
      return typeof url === 'string' ? readSnapshot(await fetch(url), progress) : undefined
    },
  }

  async fetchFile(base: string, path: string): Promise<Blob | undefined> {
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/${path}`)
      return response.ok ? await response.blob() : undefined
    } catch {
      return undefined
    }
  }

  async logout(): Promise<void> {
    await request(`${this.#url}/auth/logout`, { method: 'POST' }).catch(() => undefined)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Test stand-in: always signed in as a made-up person. A saved object whose text contains "failsave"
 * makes saving fail; `merge()` lets the pull request be accepted.
 */
export class FakeBackend implements Backend {
  readonly loginUrl = '#login'
  /** What is on the branches: session slug → object id → text. */
  branches = new Map<string, Map<string, string>>()
  /** Session slugs whose pull request was submitted, and those that were closed/merged. */
  submitted = new Set<string>()
  names = new Map<string, string>()
  merged = false
  closed = false
  #signedIn = true
  #pulls = new Map<string, number>()

  get saved(): Map<string, string> {
    return new Map([...this.branches.values()].flatMap((b) => [...b]))
  }

  #pullOf(slug: string): Pull {
    let number = this.#pulls.get(slug)
    if (!number) this.#pulls.set(slug, (number = this.#pulls.size + 1))
    return { number, url: `https://example.org/pull/${number}`, state: 'open', merged: false, draft: !this.submitted.has(slug) }
  }

  async me(): Promise<User | undefined> {
    return this.#signedIn ? { login: 'test', name: 'Test Person', avatar: '', role: 'write' } : undefined
  }

  /** The commit of each branch; it changes with every save. */
  heads = new Map<string, number>()
  /** Whose branch a session is, when it is not the signed-in person's (for tests of sessions that somebody else started). */
  owners = new Map<string, string>()

  async save(session: SessionRef, objects: SavedObject[], deleted: Removed[]): Promise<SaveResult> {
    await sleep(150)
    if (objects.some((o) => /failsave/.test(o.text))) throw new Error('Speichern fehlgeschlagen (Test).')
    if (this.closed) {
      this.submitted.delete(session.slug)
      this.#pulls.delete(session.slug)
      this.closed = false
    }
    const branch = this.branches.get(session.slug) ?? new Map<string, string>()
    this.branches.set(session.slug, branch)
    this.names.set(session.slug, session.name)
    if (session.owner) this.owners.set(session.slug, session.owner)
    for (const o of objects) branch.set(o.id, o.text)
    for (const { id } of deleted) branch.delete(id)
    this.heads.set(session.slug, (this.heads.get(session.slug) ?? 0) + 1)
    return { pull: branch.size > 0 || objects.length > 0 ? this.#pullOf(session.slug) : undefined, head: `fake-${this.heads.get(session.slug)}` }
  }

  async submit(session: SessionRef): Promise<Pull> {
    await sleep(150)
    this.submitted.add(session.slug)
    return this.#pullOf(session.slug)
  }

  async rename(session: SessionRef): Promise<void> {
    this.names.set(session.slug, session.name)
  }

  async pull(number: number): Promise<Pull> {
    return { number, url: `https://example.org/pull/${number}`, state: this.merged || this.closed ? 'closed' : 'open', merged: this.merged, draft: false }
  }

  async erfassungen(): Promise<RemoteErfassung[]> {
    return [...this.branches.keys()].map((slug) => ({
      ...this.#pullOf(slug),
      state: this.submitted.has(slug) ? ('submitted' as const) : ('open' as const),
      closed: false,
      login: this.owners.get(slug) ?? 'test',
      slug,
      name: this.names.get(slug) ?? slug,
      createdAt: new Date().toISOString(),
      head: `fake-${this.heads.get(slug) ?? 0}`,
    }))
  }

  async erfassung(number: number): Promise<RemoteContent> {
    const slug = [...this.branches.keys()].find((s) => this.#pullOf(s).number === number)
    const branch = slug ? this.branches.get(slug) : undefined
    return { head: `fake-${this.heads.get(slug ?? '') ?? 0}`, objects: [...(branch ?? [])].map(([id, text]) => ({ id, text })).sort((a, b) => a.id.localeCompare(b.id)) }
  }

  async review(number: number, since?: string): Promise<Review> {
    const content = await this.erfassung(number)
    const slug = [...this.branches.keys()].find((s) => this.#pullOf(s).number === number)
    const head = `fake-${this.heads.get(slug ?? '') ?? 0}`
    if (since && since === head) return { head, pull: this.#pullOf(slug ?? ''), mergeable: true, checks: 'unknown', objects: [], unchanged: true }
    return {
      head,
      pull: { ...this.#pullOf(slug ?? ''), merged: this.merged, state: this.merged || this.closed ? 'closed' : 'open' },
      mergeable: true,
      checks: 'none',
      objects: content.objects.map((o) => ({ id: o.id, status: 'added' as const, text: o.text })),
    }
  }

  async merge(number: number): Promise<Pull> {
    this.merged = true
    return this.pull(number)
  }

  async reject(number: number): Promise<Pull> {
    this.closed = true
    return this.pull(number)
  }

  #comments: Comment[] = []

  async comments(): Promise<Comment[]> {
    return [...this.#comments]
  }

  async addComment(_number: number, text: string): Promise<Comment> {
    const comment: Comment = { id: this.#comments.length + 1, kind: 'issue', login: 'test', avatar: '', text, createdAt: new Date().toISOString(), edited: false }
    this.#comments.push(comment)
    return comment
  }

  async editComment(id: number, text: string): Promise<Comment> {
    const comment = this.#comments.find((c) => c.id === id)
    if (!comment) throw new Error('Kommentar nicht gefunden.')
    Object.assign(comment, { text, edited: true })
    return comment
  }

  async deleteComment(id: number): Promise<void> {
    this.#comments = this.#comments.filter((c) => c.id !== id)
  }

  /** Without a Worker the archive is empty. */
  readonly archive: MirrorBackend = {
    tree: async () => ({ head: 'fake', raw: 'fake', objects: [] }),
    changes: async () => ({ head: 'fake', raw: 'fake', changes: [] }),
    texts: async () => [],
  }

  async fetchFile(): Promise<Blob | undefined> {
    return undefined
  }

  async logout(): Promise<void> {
    this.#signedIn = false
  }
}
