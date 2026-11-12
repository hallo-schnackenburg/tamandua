// Saving to the data repository, for the person who is signed in:
//
//   POST /repo/save        {session, objects?, deleted?}  one commit on the session's branch (objects written,
//                          deleted ones removed); the first one also opens the pull request as a draft.
//                          A pull request that was submitted can still be changed: the review sees what is there.
//   POST /repo/submit      {session}  asks for a review: marks the draft ready (or opens the pull request)
//   POST /repo/rename      {session}  gives the open pull request the session's new name
//   POST /repo/merge       {number, head?}  accepts a submitted session: its pull request is merged (squashed); `head` is the commit
//                          that was looked at, and if the session changed since, nothing happens (409)
//   POST /repo/close       {number}   closes a submitted session without merging it (what is to be said goes into a comment)
//   GET  /repo/pull/<n>    state of a pull request: open, closed, merged
//   GET  /repo/erfassungen the sessions of everybody: the pull requests whose branch is erfassung/<login>/<slug>
//   GET  /repo/objects     the objects of the archive (main): id, path and hash of each, and where to read their text (like below)
//   GET  /repo/snapshot    where the snapshot of the archive is (one file with all objects, kept on the branch `snapshot` by the
//                          data repository's CI): {url}. The browser reads it for its first copy, and asks for the rest as usual.
//   GET  /repo/changes?since=<commit>  what changed on main since that commit: objects added, modified, removed (or
//                          {reload: true} if that cannot be told: then everything is read again)
//   GET  /repo/erfassung/<n>/comments   the comments on a session, oldest first: written in the app (they say which object and field
//                          they are about) or on GitHub (a comment on a file in the pull request is about that object)
//   POST /repo/erfassung/<n>/comments   {text, object?, field?}  writes a comment
//   PATCH /repo/comment/<id>  {text}  changes a comment; DELETE /repo/comment/<id> removes it (only the author may, GitHub sees to it)
//   GET  /repo/erfassung/<n>  one session's objects (path and what happened to it) and where to read their text:
//                          the browser reads it itself, from raw.githubusercontent.com at the head commit; `files` is the
//                          address of the bucket for the previews; `pull` is its pull request, `checks` how the checks stand,
//                          `mergeable` whether GitHub can merge it (null: not known yet)
//
// The app checks every object against the schema before it sends it. The Worker cannot (the schema
// checker generates code, which Workers do not allow); it only checks that the objects are what they
// claim to be. The check in the data repository's pull request is the one that counts.

import { objectPath, parseObjectId } from '@tamandua/core/paths'
import { SNAPSHOT_BRANCH, SNAPSHOT_FILE } from '@tamandua/core/snapshot'
import { GitHubError, Repo, type Checks, type ChangedFile, type GithubEnv, type ListedPull, type RawComment } from './github.js'
import { objectUrl } from './s3.js'
import { s3Config, type UploadEnv } from './upload.js'
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
  /** The login the branch is named after, when the session was started by somebody else: everybody works on every session. */
  owner?: string
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LOGIN = /^[A-Za-z0-9-]{1,39}$/

export function parseSessionRef(data: unknown): SessionRef | Failure {
  const slug = (data as { slug?: unknown } | null)?.slug
  const raw = (data as { name?: unknown } | null)?.name
  if (typeof slug !== 'string' || slug.length > 60 || !SLUG.test(slug)) return { error: 'A session needs a slug (a-z, 0-9, -).', status: 400 }
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : ''
  if (!name) return { error: 'A session needs a name.', status: 400 }
  const owner = (data as { owner?: unknown } | null)?.owner
  if (owner !== undefined && (typeof owner !== 'string' || !LOGIN.test(owner))) return { error: 'An owner must be a login (A-Z, a-z, 0-9, -).', status: 400 }
  return owner === undefined ? { slug, name } : { slug, name, owner }
}

export interface Saved {
  session: SessionRef
  files: { path: string; content: string }[]
  /** What the commit message says about each object: a mark (+ new, ~ changed) and its title. */
  notes: Note[]
  /** The label of each removed path, for the commit message. */
  removedLabels: Record<string, string>
  removals: string[]
}

export interface Note {
  mark: '+' | '~' | '-'
  label: string
}

/** The title of an object as its commit message line: the title from the YAML, or the end of its id. */
function labelOf(id: string, title?: string | null): string {
  const clean = (title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  return clean ? clean.slice(0, 120) : `Objekt ${id.slice(-6)}`
}

/**
 * The commit message: the session and what happened, with one line per object in the text.
 * One object is named in the first line; several are counted there.
 */
export function messageOf(session: string, notes: Note[]): string {
  if (notes.length === 1) {
    const subject = `${session}: ${notes[0].mark} ${notes[0].label}`
    return subject.length > 72 ? `${subject.slice(0, 71)}…` : subject
  }
  const count = (mark: Note['mark'], word: string) => {
    const n = notes.filter((x) => x.mark === mark).length
    return n > 0 ? `${n} ${word}` : ''
  }
  const subject = `${session}: ${[count('+', 'neu'), count('~', 'geändert'), count('-', 'gelöscht')].filter(Boolean).join(', ')}`
  return `${subject}\n\n${notes.map((n) => `${n.mark} ${n.label}`).join('\n')}`
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
  const notes: Note[] = []
  for (const item of objects as ({ id?: unknown; text?: unknown; change?: unknown } | null)[]) {
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
    notes.push({ mark: item?.change === 'changed' ? '~' : '+', label: labelOf(id, /^title:[ \t]*(.*)$/m.exec(text)?.[1]) })
  }
  const removals: string[] = []
  const removedLabels: Record<string, string> = {}
  // A removed object is an id, or an id with its title (which the app remembers; the branch is not asked for it).
  for (const raw of deleted as (string | { id?: unknown; title?: unknown } | null)[]) {
    const rawId = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.id : undefined
    const id = typeof rawId === 'string' ? parseObjectId(rawId) : null
    if (!id) return { error: '"deleted" must list object ids (ULID).', status: 400 }
    if (seen.has(id)) return { error: 'An object is listed twice.', status: 400 }
    seen.add(id)
    removals.push(objectPath(id))
    removedLabels[objectPath(id)] = labelOf(id, raw && typeof raw === 'object' && typeof raw.title === 'string' ? raw.title : undefined)
  }
  return { session, files, removals, notes, removedLabels }
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

/** A session as the list shows it. */
export interface Erfassung {
  number: number
  url: string
  /** `open` is a draft, `submitted` is ready for review, `merged`; a pull request closed without merge counts as open again. */
  state: 'open' | 'submitted' | 'merged'
  /** Closed without being merged: the branch is still there, but its pull request is not open any more. */
  closed: boolean
  /** The branch erfassung/<login>/<slug>. */
  branch: string
  login: string
  slug: string
  name: string
  createdAt: string
  /** The commit the pull request is at now. */
  head: string
  /** How the checks of a submitted session stand (only given for those waiting for review). */
  checks?: Checks
}

const MARKER = /<!-- tamandua-session: (\{.*?\}) -->/s

/** The session's name and slug from the pull request's text (see `bodyOf`), or undefined if it has no marker. */
export function markerOf(body: string | null): SessionRef | undefined {
  const match = body ? MARKER.exec(body) : null
  if (!match) return undefined
  try {
    const data = JSON.parse(match[1]) as { slug?: unknown; name?: unknown }
    return typeof data.slug === 'string' && typeof data.name === 'string' ? { slug: data.slug, name: data.name } : undefined
  } catch {
    return undefined
  }
}

const SESSION_BRANCH = /^erfassung\/([A-Za-z0-9-]+)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/

/** The sessions among the pull requests: those whose branch is erfassung/<login>/<slug>. */
export function erfassungenOf(pulls: ListedPull[]): Erfassung[] {
  const found: Erfassung[] = []
  for (const pull of pulls) {
    const match = SESSION_BRANCH.exec(pull.head.ref)
    if (!match) continue
    const [, login, slug] = match
    const state = pull.merged_at ? 'merged' : pull.state === 'open' && !pull.draft ? 'submitted' : 'open'
    found.push({
      number: pull.number,
      url: pull.html_url,
      state,
      closed: pull.state === 'closed' && !pull.merged_at,
      branch: pull.head.ref,
      login,
      slug,
      name: markerOf(pull.body)?.name ?? pull.title.replace(/\s*\([^()]*\)\s*$/, ''),
      createdAt: pull.created_at,
      head: pull.head.sha,
    })
  }
  return found
}

/** An object of a session: where its YAML is in the repository, and what the pull request does with it. */
/** The sessions waiting for review, with how their checks stand (a few calls at most: only those are asked). */
async function withChecks(repo: Repo, list: Erfassung[]): Promise<Erfassung[]> {
  return Promise.all(list.map(async (e) => (e.state === 'submitted' && !e.closed ? { ...e, checks: await repo.checks(e.head) } : e)))
}

export interface ErfassungObject {
  id: string
  path: string
  status: 'added' | 'modified' | 'removed'
}

const OBJECT_FILE = /^objects\/[0-9A-HJKMNP-TV-Z]\/[0-9A-HJKMNP-TV-Z]\/([0-9A-HJKMNP-TV-Z]{26})\.yaml$/

export function objectsOf(files: { filename: string; status: string }[]): ErfassungObject[] {
  const objects: ErfassungObject[] = []
  for (const file of files) {
    const match = OBJECT_FILE.exec(file.filename)
    if (!match) continue
    objects.push({ id: match[1], path: file.filename, status: file.status === 'removed' ? 'removed' : file.status === 'added' ? 'added' : 'modified' })
  }
  return objects
}

/** An object of the archive (main): where its YAML is and the hash of that file (to tell whether it changed). */
export interface ArchiveObject {
  id: string
  path: string
  sha: string
}

export function archiveObjectsOf(files: { path: string; sha: string }[]): ArchiveObject[] {
  const objects: ArchiveObject[] = []
  for (const file of files) {
    const match = OBJECT_FILE.exec(file.path)
    if (match) objects.push({ id: match[1], path: file.path, sha: file.sha })
  }
  return objects
}

export interface ArchiveChange extends ArchiveObject {
  status: 'added' | 'modified' | 'removed'
}

/** The changes of objects among the changed files. A renamed file is the removal of the old and the new one of the new path. */
export function archiveChangesOf(files: ChangedFile[]): ArchiveChange[] {
  const changes: ArchiveChange[] = []
  for (const file of files) {
    if (file.status === 'renamed' && file.previous_filename) {
      const old = OBJECT_FILE.exec(file.previous_filename)
      if (old) changes.push({ id: old[1], path: file.previous_filename, sha: file.sha, status: 'removed' })
    }
    const match = OBJECT_FILE.exec(file.filename)
    if (!match) continue
    changes.push({ id: match[1], path: file.filename, sha: file.sha, status: file.status === 'removed' ? 'removed' : file.status === 'added' || file.status === 'renamed' ? 'added' : 'modified' })
  }
  return changes
}

/** A comment of a session as the app shows it. */
export interface Comment {
  id: number
  /** `issue`: on the pull request (can be changed here); `review`: on a file of it, written on GitHub (can only be read here). */
  kind: 'issue' | 'review'
  login: string
  avatar: string
  text: string
  createdAt: string
  edited: boolean
  /** The object (and its field) the comment is about, if it says so. */
  object?: string
  field?: string
}

const COMMENT_MARKER = /\n*<!-- tamandua-comment: (\{[^\n]*?\}) -->\s*$/
const FIELD = /^[a-z][a-z_]{0,39}$/

/** A comment's text with what the app put at its end ("this is about that object") taken off. */
export function splitComment(body: string): { text: string; object?: string; field?: string } {
  const match = COMMENT_MARKER.exec(body)
  if (!match) return { text: body.trim() }
  const text = body.slice(0, match.index).trim()
  try {
    const data = JSON.parse(match[1]) as { object?: unknown; field?: unknown }
    const object = typeof data.object === 'string' ? parseObjectId(data.object) : null
    if (!object) return { text }
    return { text, object, field: typeof data.field === 'string' && FIELD.test(data.field) ? data.field : undefined }
  } catch {
    return { text }
  }
}

/** The text of a comment as it is written to GitHub: with the note about the object at its end, so that a person reading it there sees only the text. */
export function joinComment(text: string, object?: string, field?: string): string {
  if (!object) return text
  return `${text}\n\n<!-- tamandua-comment: ${JSON.stringify({ object, ...(field ? { field } : {}) })} -->`
}

const MAX_COMMENT = 5000

/** The text of a request for a comment: 1 to 5000 characters, without control characters; or a failure to report. */
export function parseCommentText(data: unknown): string | Failure {
  const text = (data as { text?: unknown } | null)?.text
  if (typeof text !== 'string') return { error: '"text" must be text.', status: 400 }
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/<!--/g, '<!- -').trim()
  if (clean.length === 0 || clean.length > MAX_COMMENT) return { error: `A comment needs 1 to ${MAX_COMMENT} characters.`, status: 400 }
  return clean
}

/** The comments of a session in one list, oldest first. */
export function commentsOf(raw: { issue: RawComment[]; review: RawComment[] }): Comment[] {
  const comments: Comment[] = []
  for (const kind of ['issue', 'review'] as const) {
    for (const c of raw[kind]) {
      const { text, object, field } = splitComment(c.body ?? '')
      const onFile = kind === 'review' ? OBJECT_FILE.exec(c.path ?? '')?.[1] : undefined
      comments.push({
        id: c.id,
        kind,
        login: c.user?.login ?? 'unbekannt',
        avatar: c.user?.avatar_url ?? '',
        text,
        createdAt: c.created_at,
        edited: c.updated_at !== c.created_at,
        object: object ?? onFile,
        field,
      })
    }
  }
  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
}

/** A commit as it is written into the address: letters and digits only (GitHub knows what is a commit). */
const COMMIT = /^[0-9A-Za-z]{1,64}$/

export interface RepoEnv extends GithubEnv, UploadEnv {}

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
      const { session, files, removals, notes, removedLabels } = parsed
      const branch = branchOf(session.owner ?? user.login, session.slug)

      // A submitted session can still be changed (also while it is being reviewed): its pull request is the same.
      const existing = await repo.current(branch)

      const commit = await repo.save(branch, files, removals, (removed) =>
        messageOf(session.name, [...notes, ...removed.map((path): Note => ({ mark: '-', label: removedLabels[path] }))]),
      )
      // The pull request is a convenience: if it cannot be opened now, the save still counts.
      const pull =
        existing ??
        (commit
          ? await repo.draft(branch, titleOf(session.name, user.name), bodyOf(user.login, { slug: session.slug, name: session.name })).catch((error) => {
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
      const author = session.owner ?? user.login
      const branch = branchOf(author, session.slug)
      const title = titleOf(session.name, session.owner ?? user.name)
      const text = bodyOf(author, { slug: session.slug, name: session.name })
      if (route === '/repo/submit') return json(await repo.submit(branch, title, text))
      return json({ pull: (await repo.rename(branch, title, text)) ?? null })
    }

    if ((route === '/repo/merge' || route === '/repo/close') && request.method === 'POST') {
      const data = await body()
      if (data instanceof Response) return data
      const { number, head } = (data ?? {}) as { number?: unknown; head?: unknown }
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 999_999_999) return json({ error: '"number" must be the number of a pull request.' }, 400)
      if (head !== undefined && (typeof head !== 'string' || !COMMIT.test(head))) return json({ error: '"head" must be a commit.' }, 400)
      return json(route === '/repo/merge' ? await repo.merge(number, head) : await repo.reject(number))
    }

    const talk = /^\/repo\/erfassung\/(\d{1,9})\/comments$/.exec(route)
    if (talk && request.method === 'GET') return json({ comments: commentsOf(await repo.comments(Number(talk[1]))) })
    if (talk && request.method === 'POST') {
      const data = await body()
      if (data instanceof Response) return data
      const text = parseCommentText(data)
      if (typeof text !== 'string') return json({ error: text.error }, text.status)
      const { object, field } = (data ?? {}) as { object?: unknown; field?: unknown }
      if (object !== undefined && (typeof object !== 'string' || !parseObjectId(object))) return json({ error: '"object" must be an object id (ULID).' }, 400)
      if (field !== undefined && (typeof field !== 'string' || !FIELD.test(field))) return json({ error: '"field" must be the name of a field.' }, 400)
      const made = await repo.addComment(Number(talk[1]), joinComment(text, object as string | undefined, field as string | undefined))
      return json({ comment: commentsOf({ issue: [made], review: [] })[0] }, 201)
    }
    const one_comment = /^\/repo\/comment\/(\d{1,12})$/.exec(route)
    if (one_comment && request.method === 'PATCH') {
      const data = await body()
      if (data instanceof Response) return data
      const text = parseCommentText(data)
      if (typeof text !== 'string') return json({ error: text.error }, text.status)
      // What the comment is about stays: it is read from the comment itself.
      const before = splitComment((await repo.issueComment(Number(one_comment[1]))).body ?? '')
      const changed = await repo.editComment(Number(one_comment[1]), joinComment(text, before.object, before.field))
      return json({ comment: commentsOf({ issue: [changed], review: [] })[0] })
    }
    if (one_comment && request.method === 'DELETE') {
      await repo.deleteComment(Number(one_comment[1]))
      return json({ deleted: true })
    }

    const match = /^\/repo\/pull\/(\d{1,9})$/.exec(route)
    if (match && request.method === 'GET') return json(await repo.pull(Number(match[1])))

    if (route === '/repo/erfassungen' && request.method === 'GET') return json({ erfassungen: await withChecks(repo, erfassungenOf(await repo.pulls())) })

    if (route === '/repo/objects' && request.method === 'GET') {
      const { head, files } = await repo.tree()
      return json({ head, raw: `https://raw.githubusercontent.com/${env.DATA_REPO}/${head}`, objects: archiveObjectsOf(files) })
    }

    if (route === '/repo/snapshot' && request.method === 'GET') {
      return json({ url: `https://raw.githubusercontent.com/${env.DATA_REPO}/${SNAPSHOT_BRANCH}/${SNAPSHOT_FILE}` })
    }

    if (route === '/repo/changes' && request.method === 'GET') {
      const since = new URL(request.url).searchParams.get('since') ?? ''
      if (!COMMIT.test(since)) return json({ error: '"since" must be a commit.' }, 400)
      const found = await repo.changes(since)
      if (!found) return json({ reload: true })
      return json({ head: found.head, raw: `https://raw.githubusercontent.com/${env.DATA_REPO}/${found.head}`, changes: archiveChangesOf(found.files) })
    }

    const one = /^\/repo\/erfassung\/(\d{1,9})$/.exec(route)
    if (one && request.method === 'GET') {
      const { head, pull, files } = await repo.pullFiles(Number(one[1]))
      // `files` is where the bucket's files can be read from (it is public): the browser fetches the previews itself.
      const storage = s3Config(env)
      return json({
        head,
        raw: `https://raw.githubusercontent.com/${env.DATA_REPO}/${head}`,
        files: storage ? objectUrl(storage, '').origin : undefined,
        objects: objectsOf(files),
        pull: { number: pull.number, url: pull.html_url, state: pull.state, merged: pull.merged, draft: pull.draft === true },
        mergeable: pull.mergeable,
        // `light` (for a look at the objects only, e.g. before a save) leaves out the checks: they cost more calls.
        checks: new URL(request.url).searchParams.has('light') ? 'unknown' : await repo.checks(head),
      })
    }
  } catch (error) {
    if (error instanceof GitHubError) {
      console.error('GitHub error', error.status, error.message)
      // Without a token that works any more the app has to sign in again; everything else is passed on as a message.
      if (error.status === 401) return json({ error: 'Not signed in.' }, 401)
      if (error.status === 409 && ['/repo/submit', '/repo/merge', '/repo/close'].includes(route)) return json({ error: error.message }, 409)
      if (error.status === 404 && (error.message === 'Das ist keine Erfassung.' || error.message === 'Das ist kein Kommentar zu einer Erfassung.')) return json({ error: error.message }, 404)
      if (error.status === 403 && route.startsWith('/repo/comment/')) return json({ error: 'Das darf nur, wer den Kommentar geschrieben hat.' }, 403)
      return json({ error: `GitHub answered with an error (${error.status}): ${error.message}`.slice(0, 300) }, 502)
    }
    throw error
  }
  return json({ error: 'Not found.' }, 404)
}
