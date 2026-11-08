// Saving to the data repository, for the person who is signed in:
//
//   POST /repo/save        {session, objects?, deleted?}  one commit on the session's branch (objects written,
//                          deleted ones removed); the first one also opens the pull request as a draft.
//                          Refused once the pull request is ready for review: it is frozen then.
//   POST /repo/submit      {session}  asks for a review: marks the draft ready (or opens the pull request)
//   POST /repo/rename      {session}  gives the open pull request the session's new name
//   GET  /repo/pull/<n>    state of a pull request: open, closed, merged
//
// The app checks every object against the schema before it sends it. The Worker cannot (the schema
// checker generates code, which Workers do not allow); it only checks that the objects are what they
// claim to be. The check in the data repository's pull request is the one that counts.

import { objectPath, parseObjectId } from '@tamandua/core/paths'
import { GitHubError, Repo, type GithubEnv } from './github.js'
import type { Auth } from './session.js'

const MAX_OBJECTS = 50
const MAX_OBJECT_BYTES = 200_000

/** The branch of one session of a person: erfassung/<login>/<slug>. */
export const branchOf = (login: string, slug: string): string => `erfassung/${login.replace(/[^A-Za-z0-9-]/g, '-')}/${slug}`

interface Failure {
  error: string
  status: number
}

export interface SessionRef {
  /** Chosen once when the session is created and never changed: names the branch. */
  slug: string
  /** What the person calls the session; may change (it is part of the pull request's title). */
  name: string
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function parseSessionRef(data: unknown): SessionRef | Failure {
  const slug = (data as { slug?: unknown } | null)?.slug
  const raw = (data as { name?: unknown } | null)?.name
  if (typeof slug !== 'string' || slug.length > 60 || !SLUG.test(slug)) return { error: 'A session needs a slug (a-z, 0-9, -).', status: 400 }
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : ''
  if (!name) return { error: 'A session needs a name.', status: 400 }
  return { slug, name }
}

export interface Saved {
  session: SessionRef
  files: { path: string; content: string }[]
  removals: string[]
}

/** A save request as the files to write and the paths to remove, or a failure to report. */
export function parseSave(data: unknown): Saved | Failure {
  const session = parseSessionRef((data as { session?: unknown } | null)?.session)
  if ('error' in session) return session
  const objects = (data as { objects?: unknown } | null)?.objects ?? []
  const deleted = (data as { deleted?: unknown } | null)?.deleted ?? []
  if (!Array.isArray(objects) || !Array.isArray(deleted)) return { error: '"objects" and "deleted" must be lists.', status: 400 }
  if (objects.length > MAX_OBJECTS || deleted.length > MAX_OBJECTS || objects.length + deleted.length === 0) {
    return { error: `"objects" and "deleted" must list 1 to ${MAX_OBJECTS} objects together.`, status: 400 }
  }
  const files: Saved['files'] = []
  const seen = new Set<string>()
  for (const item of objects as ({ id?: unknown; text?: unknown } | null)[]) {
    const id = typeof item?.id === 'string' ? parseObjectId(item.id) : null
    const text = item?.text
    if (!id || typeof text !== 'string') return { error: 'An object needs an id (ULID) and its YAML text.', status: 400 }
    if (seen.has(id)) return { error: 'An object is listed twice.', status: 400 }
    seen.add(id)
    if (new TextEncoder().encode(text).length > MAX_OBJECT_BYTES) return { error: 'An object is too large.', status: 413 }
    // The id inside the YAML has to be the one the path is made from.
    const inside = /^id:\s*([0-9A-Z]{26})\s*$/m.exec(text)?.[1]
    if (inside !== id) return { error: 'The id in the YAML does not match the object.', status: 400 }
    files.push({ path: objectPath(id), content: text.endsWith('\n') ? text : text + '\n' })
  }
  const removals: string[] = []
  for (const raw of deleted) {
    const id = typeof raw === 'string' ? parseObjectId(raw) : null
    if (!id) return { error: '"deleted" must list object ids (ULID).', status: 400 }
    if (seen.has(id)) return { error: 'An object is listed twice.', status: 400 }
    seen.add(id)
    removals.push(objectPath(id))
  }
  return { session, files, removals }
}

/** "Dachbodenfund Postkarten (Anna Beispiel, 07.11.2026, 23:47)": the session and when its pull request was opened, in Berlin time. */
export function titleOf(name: string, person: string, now = new Date()): string {
  const zone = { timeZone: 'Europe/Berlin' } as const
  const date = now.toLocaleDateString('de-DE', { ...zone, day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = now.toLocaleTimeString('de-DE', { ...zone, hour: '2-digit', minute: '2-digit' })
  return `${name} (${person}, ${date}, ${time})`
}

/** The text of the pull request; the marker lets the app find the session's name again. */
export function bodyOf(login: string, session: SessionRef): string {
  const marker = JSON.stringify(session).replace(/--/g, '-\\u002d')
  return `Erfasst über Tamandua von ${login}.\n\n<!-- tamandua-session: ${marker} -->`
}

export interface RepoEnv extends GithubEnv {}

export async function handleRepo(request: Request, route: string, user: Auth, env: RepoEnv, fetchFn: typeof fetch): Promise<Response | null> {
  if (!route.startsWith('/repo/')) return null
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!env.DATA_REPO) return json({ error: 'The server has no data repository (DATA_REPO).' }, 500)
  const repo = new Repo(user.access, env.DATA_REPO, env.BASE_BRANCH ?? 'main', fetchFn)

  const body = async (): Promise<unknown | Response> => {
    try {
      return JSON.parse(await request.text())
    } catch {
      return json({ error: 'Body must be valid JSON.' }, 400)
    }
  }

  try {
    if (route === '/repo/save' && request.method === 'POST') {
      const data = await body()
      if (data instanceof Response) return data
      const parsed = parseSave(data)
      if ('error' in parsed) return json({ error: parsed.error }, parsed.status)
      const { session, files, removals } = parsed
      const branch = branchOf(user.login, session.slug)

      // A pull request that is ready for review is frozen: the reviewer reads a fixed state.
      const existing = await repo.current(branch)
      if (existing && !existing.draft) return json({ error: 'The session was submitted and cannot be changed.', locked: true }, 409)

      const parts = [files.length > 0 && `${files.length} ${files.length === 1 ? 'Objekt' : 'Objekte'}`, removals.length > 0 && `${removals.length} gelöscht`]
      const commit = await repo.save(branch, files, removals, `Erfassung: ${parts.filter(Boolean).join(', ')}`)
      // The pull request is a convenience: if it cannot be opened now, the save still counts.
      const pull =
        existing ??
        (commit
          ? await repo.draft(branch, titleOf(session.name, user.name), bodyOf(user.login, session)).catch((error) => {
              console.error('Could not open the pull request', error)
              return undefined
            })
          : undefined)
      return json({ commit, saved: files.length, deleted: removals.length, pull })
    }

    if ((route === '/repo/submit' || route === '/repo/rename') && request.method === 'POST') {
      const data = await body()
      if (data instanceof Response) return data
      const session = parseSessionRef((data as { session?: unknown } | null)?.session)
      if ('error' in session) return json({ error: session.error }, session.status)
      const branch = branchOf(user.login, session.slug)
      const title = titleOf(session.name, user.name)
      if (route === '/repo/submit') return json(await repo.submit(branch, title, bodyOf(user.login, session)))
      return json({ pull: (await repo.rename(branch, title, bodyOf(user.login, session))) ?? null })
    }

    const match = /^\/repo\/pull\/(\d{1,9})$/.exec(route)
    if (match && request.method === 'GET') return json(await repo.pull(Number(match[1])))
  } catch (error) {
    if (error instanceof GitHubError) {
      console.error('GitHub error', error.status, error.message)
      // Without a token that works any more the app has to sign in again; everything else is passed on as a message.
      if (error.status === 401) return json({ error: 'Not signed in.' }, 401)
      if (error.status === 409 && route === '/repo/submit') return json({ error: error.message }, 409)
      return json({ error: `GitHub answered with an error (${error.status}): ${error.message}`.slice(0, 300) }, 502)
    }
    throw error
  }
  return json({ error: 'Not found.' }, 404)
}
