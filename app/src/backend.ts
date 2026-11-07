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
}

export interface Backend {
  /** The signed-in person, or undefined if nobody is. Throws if the server cannot be asked. */
  me(): Promise<User | undefined>
  /** Puts the objects (id and YAML text) into one commit on the person's branch. */
  save(objects: { id: string; text: string }[]): Promise<void>
  /** Opens the pull request of the person's branch, or returns the one that is open. */
  submit(): Promise<Pull>
  pull(number: number): Promise<Pull>
  logout(): Promise<void>
  /** Where the browser goes to sign in. */
  readonly loginUrl: string
}

const MAX_PER_SAVE = 50

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

  async save(objects: { id: string; text: string }[]): Promise<void> {
    for (let from = 0; from < objects.length; from += MAX_PER_SAVE) {
      const response = await request(`${this.#url}/repo/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objects: objects.slice(from, from + MAX_PER_SAVE) }),
      })
      if (!response.ok) throw new Error((await jsonOf<object>(response)).error ?? `Fehler ${response.status}`)
    }
  }

  async submit(): Promise<Pull> {
    const response = await request(`${this.#url}/repo/submit`, { method: 'POST' })
    const data = await jsonOf<Pull>(response)
    if (response.status === 409) throw new Error('Es gibt nichts Neues einzureichen.')
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data
  }

  async pull(number: number): Promise<Pull> {
    const response = await request(`${this.#url}/repo/pull/${number}`)
    const data = await jsonOf<Pull>(response)
    if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data
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
  saved = new Map<string, string>()
  merged = false
  #signedIn = true

  async me(): Promise<User | undefined> {
    return this.#signedIn ? { login: 'test', name: 'Test Person', avatar: '', role: 'write' } : undefined
  }

  async save(objects: { id: string; text: string }[]): Promise<void> {
    await sleep(150)
    if (objects.some((o) => /failsave/.test(o.text))) throw new Error('Speichern fehlgeschlagen (Test).')
    for (const o of objects) this.saved.set(o.id, o.text)
  }

  async submit(): Promise<Pull> {
    await sleep(150)
    return { number: 1, url: 'https://example.org/pull/1', state: 'open', merged: false }
  }

  async pull(number: number): Promise<Pull> {
    return { number, url: 'https://example.org/pull/1', state: this.merged ? 'closed' : 'open', merged: this.merged }
  }

  async logout(): Promise<void> {
    this.#signedIn = false
  }
}
