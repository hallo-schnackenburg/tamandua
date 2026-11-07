// Saving to the data repository, for the person who is signed in:
//
//   POST /repo/save        {objects: [{id, text}]}  one commit on the person's branch; the first one also
//                          opens the branch's pull request as a draft
//   POST /repo/submit      asks for a review: marks the draft ready (or opens the pull request)
//   GET  /repo/pull/<n>    state of a pull request: open, closed, merged
//
// The app checks every object against the schema before it sends it. The Worker cannot (the schema
// checker generates code, which Workers do not allow); it only checks that the objects are what they
// claim to be. The check in the data repository's pull request is the one that counts.

import { objectPath, parseObjectId } from '@tamandua/core/paths'
import { GitHubError, Repo, type GithubEnv } from './github.js'
import type { Session } from './session.js'

const MAX_OBJECTS = 50
const MAX_OBJECT_BYTES = 200_000

/** "Erfassung von Anna (07.11.2026, 23:47)": when the pull request was opened, in the time of the archive. */
export function titleOf(name: string, now = new Date()): string {
  const zone = { timeZone: 'Europe/Berlin' } as const
  const date = now.toLocaleDateString('de-DE', { ...zone, day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = now.toLocaleTimeString('de-DE', { ...zone, hour: '2-digit', minute: '2-digit' })
  return `Erfassung von ${name} (${date}, ${time})`
}

export const branchOf = (login: string): string => `erfassung/${login.replace(/[^A-Za-z0-9-]/g, '-')}`

interface Failure {
  error: string
  status: number
}

export interface Saved {
  files: { path: string; content: string }[]
}

/** The objects of a save request as files, or a failure to report. */
export function parseSave(data: unknown): Saved | Failure {
  const objects = (data as { objects?: unknown } | null)?.objects
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > MAX_OBJECTS) {
    return { error: `"objects" must list 1 to ${MAX_OBJECTS} objects.`, status: 400 }
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
  return { files }
}

export interface RepoEnv extends GithubEnv {}

export async function handleRepo(request: Request, route: string, session: Session, env: RepoEnv, fetchFn: typeof fetch): Promise<Response | null> {
  if (!route.startsWith('/repo/')) return null
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!env.DATA_REPO) return json({ error: 'The server has no data repository (DATA_REPO).' }, 500)
  const repo = new Repo(session.access, env.DATA_REPO, env.BASE_BRANCH ?? 'main', fetchFn)
  const branch = branchOf(session.login)

  try {
    if (route === '/repo/save' && request.method === 'POST') {
      let data: unknown
      try {
        data = JSON.parse(await request.text())
      } catch {
        return json({ error: 'Body must be valid JSON.' }, 400)
      }
      const parsed = parseSave(data)
      if ('error' in parsed) return json({ error: parsed.error }, parsed.status)
      const n = parsed.files.length
      const commit = await repo.save(branch, parsed.files, `Erfassung: ${n} ${n === 1 ? 'Objekt' : 'Objekte'}`)
      // The pull request is a convenience: if it cannot be opened now, the save still counts.
      const pull = await repo.draft(branch, titleOf(session.name), `Erfasst über Tamandua von ${session.login}.`).catch((error) => {
        console.error('Could not open the pull request', error)
        return undefined
      })
      return json({ commit, saved: n, pull })
    }

    if (route === '/repo/submit' && request.method === 'POST') {
      const pull = await repo.submit(branch, titleOf(session.name), `Erfasst über Tamandua von ${session.login}.`)
      return json(pull)
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
