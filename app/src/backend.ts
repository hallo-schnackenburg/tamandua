// The part of the app that talks to GitHub through the Worker: who is signed in, saving objects
// to the person's branch, submitting them as a pull request. The rest of the app only knows this
// interface. HttpBackend is the real one; FakeBackend stands in without a Worker.

import { jsonOf, request, SignedOut } from './api.js'

export interface User {
  login: string
  name: string
  avatar: string
  /** `admin` may also review and merge. */
  role: 'admin' | 'write'
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

/** The pull request of the session is no longer a draft: it was submitted, nothing may be added to it. */
export class Locked extends Error {
  constructor() {
    super('Diese Erfassung ist schon eingereicht.')
  }
}

export interface Backend {
  /** The signed-in person, or undefined if nobody is. Throws if the server cannot be asked. */
  me(): Promise<User | undefined>
  /**
   * Puts the objects (id and YAML text) into one commit on the session's branch and removes the deleted
   * ones from it. Returns the pull request of the session, if there is one. Throws `Locked` if it was submitted.
   */
  save(session: SessionRef, objects: SavedObject[], deleted: Removed[]): Promise<Pull | undefined>
  /** Marks the pull request of the session as ready for review. */
  submit(session: SessionRef): Promise<Pull>
  /** Gives the pull request of the session its new name, if it has one. */
  rename(session: SessionRef): Promise<void>
  pull(number: number): Promise<Pull>
  /** The sessions of everybody (newest first, up to a hundred). */
  erfassungen(): Promise<RemoteErfassung[]>
  /** The objects of one session, with their text. */
  erfassung(number: number): Promise<RemoteContent>
  /** A file from the bucket (a preview), or undefined if it cannot be had. */
  fetchFile(base: string, path: string): Promise<Blob | undefined>
  logout(): Promise<void>
  /** Where the browser goes to sign in. */
  readonly loginUrl: string
}

const MAX_PER_SAVE = 50
/** How many objects are read from GitHub at once. */
const READ_PARALLEL = 6

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

  async save(session: SessionRef, objects: SavedObject[], deleted: Removed[]): Promise<Pull | undefined> {
    let pull: Pull | undefined
    for (let o = 0, d = 0; o < objects.length || d < deleted.length; o += MAX_PER_SAVE, d += MAX_PER_SAVE) {
      const response = await request(`${this.#url}/repo/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, objects: objects.slice(o, o + MAX_PER_SAVE), deleted: deleted.slice(d, d + MAX_PER_SAVE) }),
      })
      const data = await jsonOf<{ pull?: Pull; locked?: boolean }>(response)
      if (response.status === 409 && data.locked) throw new Locked()
      if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
      pull = data.pull ?? pull
    }
    return pull
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
    // The texts are read from GitHub directly, at the commit: a public address that never changes its content.
    const wanted = data.objects.filter((o) => o.status !== 'removed')
    const objects: { id: string; text: string }[] = []
    let next = 0
    const worker = async () => {
      while (next < wanted.length) {
        const object = wanted[next++]
        const text = await fetch(`${data.raw}/${object.path}`)
        if (!text.ok) throw new Error(`Objekt ${object.id} konnte nicht gelesen werden (${text.status}).`)
        objects.push({ id: object.id, text: await text.text() })
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_PARALLEL, wanted.length) }, worker))
    return { head: data.head, files: data.files, objects: objects.sort((a, b) => a.id.localeCompare(b.id)) }
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

  async save(session: SessionRef, objects: SavedObject[], deleted: Removed[]): Promise<Pull | undefined> {
    await sleep(150)
    if (this.submitted.has(session.slug) && !this.closed) throw new Locked()
    if (objects.some((o) => /failsave/.test(o.text))) throw new Error('Speichern fehlgeschlagen (Test).')
    if (this.closed) {
      this.submitted.delete(session.slug)
      this.#pulls.delete(session.slug)
      this.closed = false
    }
    const branch = this.branches.get(session.slug) ?? new Map<string, string>()
    this.branches.set(session.slug, branch)
    this.names.set(session.slug, session.name)
    for (const o of objects) branch.set(o.id, o.text)
    for (const { id } of deleted) branch.delete(id)
    return branch.size > 0 || objects.length > 0 ? this.#pullOf(session.slug) : undefined
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
      login: 'test',
      slug,
      name: this.names.get(slug) ?? slug,
      createdAt: new Date().toISOString(),
      head: 'fake',
    }))
  }

  async erfassung(number: number): Promise<RemoteContent> {
    const slug = [...this.branches.keys()].find((s) => this.#pullOf(s).number === number)
    const branch = slug ? this.branches.get(slug) : undefined
    return { head: 'fake', objects: [...(branch ?? [])].map(([id, text]) => ({ id, text })).sort((a, b) => a.id.localeCompare(b.id)) }
  }

  async fetchFile(): Promise<Blob | undefined> {
    return undefined
  }

  async logout(): Promise<void> {
    this.#signedIn = false
  }
}
