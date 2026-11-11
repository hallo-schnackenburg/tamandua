import { describe, expect, it } from 'vitest'
import { objectPath } from '@tamandua/core/paths'
import { handle, type Env } from '../src/index.js'
import { bodyOf, branchOf, erfassungenOf, markerOf, messageOf, parseSessionRef, titleOf } from '../src/repo.js'
import { authEnv, blobSha, cookieOf, fakeGitHub } from './support.js'

const env: Env = { ...authEnv }
const cookie = await cookieOf()
const post = (path: string, data?: unknown) =>
  new Request(`http://worker/api${path}`, { method: 'POST', headers: { cookie }, body: data === undefined ? undefined : JSON.stringify(data) })

const ID_A = '01JABCDEFGHJKMNPQRSTVWXYZ0'
const ID_B = '01JABCDEFGHJKMNPQRSTVWXYZ1'
const text = (id: string, title = 'Brief') => `id: ${id}\ntype: document\ntitle: ${title}\n`
const session = { slug: 'dachbodenfund-postkarten-4k2x', name: 'Dachbodenfund Postkarten' }
const BRANCH = 'erfassung/anna/dachbodenfund-postkarten-4k2x'
const objects = (...ids: string[]) => ({ session, objects: ids.map((id) => ({ id, text: text(id) })) })
const saveOf = async (gh: ReturnType<typeof fakeGitHub>, data: unknown) => handle(post('/repo/save', data), env, gh.fn)

describe('POST /repo/save', () => {
  it('puts the objects into one commit on the session\'s branch, made from main', async () => {
    const gh = fakeGitHub()
    const response = await saveOf(gh, objects(ID_A, ID_B))
    expect(response.status).toBe(200)
    const { commit, saved } = (await response.json()) as { commit: string; saved: number }
    expect(saved).toBe(2)

    expect(gh.state.refs[BRANCH]).toBe(commit)
    expect(gh.state.commits[commit].parents).toEqual(['c0']) // the branch started at main
    expect(gh.state.commits[commit].message).toBe('Dachbodenfund Postkarten: 2 neu\n\n+ Brief\n+ Brief')
    const tree = gh.state.trees[gh.state.commits[commit].tree]
    expect(tree.entries.map((e) => e.path)).toEqual([objectPath(ID_A), objectPath(ID_B)])
    expect(tree.entries[0].content).toBe(text(ID_A))
    // Everything ran with the person's own token.
    expect(gh.state.calls.every((c) => c.auth === 'Bearer ghu_anna')).toBe(true)
  })

  it('keeps sessions apart: every session has its own branch', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A))
    await saveOf(gh, { session: { slug: 'protokolle-stadtrat-9zzz', name: 'Protokolle Stadtrat' }, objects: [{ id: ID_B, text: text(ID_B) }] })
    expect(Object.keys(gh.state.refs).sort()).toEqual(['erfassung/anna/dachbodenfund-postkarten-4k2x', 'erfassung/anna/protokolle-stadtrat-9zzz', 'main'])
    expect(gh.state.pulls).toHaveLength(2)
  })

  it('adds to the branch on the next save', async () => {
    const gh = fakeGitHub()
    const first = (await (await saveOf(gh, objects(ID_A))).json()) as { commit: string }
    const second = (await (await saveOf(gh, objects(ID_B))).json()) as { commit: string }
    expect(gh.state.commits[second.commit].parents).toEqual([first.commit])
    expect(gh.state.refs[BRANCH]).toBe(second.commit)
    expect(gh.state.commits[second.commit].message).toBe('Dachbodenfund Postkarten: + Brief')
  })

  it('makes no commit when the objects are what the branch has already', async () => {
    const gh = fakeGitHub()
    const first = (await (await saveOf(gh, objects(ID_A))).json()) as { commit: string }
    const again = (await (await saveOf(gh, objects(ID_A))).json()) as { commit: string | null }
    expect(again.commit).toBeNull()
    expect(gh.state.refs[BRANCH]).toBe(first.commit)
    expect(Object.keys(gh.state.commits).filter((c) => gh.state.commits[c].message.startsWith('Dachbodenfund'))).toHaveLength(1)
  })

  it('makes no branch when the objects are what main has already', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A))
    gh.state.refs.main = gh.state.refs[BRANCH] // merged
    const response = await saveOf(gh, { session: { slug: 'other-1', name: 'Other' }, objects: [{ id: ID_A, text: text(ID_A) }] })
    expect(((await response.json()) as { commit: unknown }).commit).toBeNull()
    expect(gh.state.refs['erfassung/anna/other-1']).toBeUndefined()
  })

  it('tries again once when the branch moved in the meantime', async () => {
    expect((await saveOf(fakeGitHub({ patchFailures: 1 }), objects(ID_A))).status).toBe(200)
    expect((await saveOf(fakeGitHub({ patchFailures: 2 }), objects(ID_A))).status).toBe(502)
  })

  it('refuses what is not a session or an object, before it asks GitHub anything', async () => {
    const gh = fakeGitHub()
    const o = [{ id: ID_A, text: text(ID_A) }]
    const bad = [
      {},
      { objects: o },
      { session: { slug: 'Bad Slug', name: 'x' }, objects: o },
      { session: { slug: '../x', name: 'x' }, objects: o },
      { session: { slug: 'ok', name: '  ' }, objects: o },
      { session, objects: [] },
      { session, objects: [{ id: 'nope', text: text(ID_A) }] },
      { session, objects: [{ id: '../../etc/passwd', text: 'x' }] },
      { session, objects: [{ id: ID_A, text: text(ID_B) }] }, // the id inside differs
      { session, objects: [{ id: ID_A, text: 'title: no id' }] },
      { session, objects: [{ id: ID_A }] },
      { session, objects: [{ id: ID_A, text: text(ID_A) }, { id: ID_A, text: text(ID_A) }] },
      { session, objects: Array.from({ length: 51 }, () => ({ id: ID_A, text: text(ID_A) })) },
      { session, deleted: ['nope'] },
      { session, objects: o, deleted: [ID_A] }, // written and deleted at once
    ]
    for (const body of bad) expect((await saveOf(gh, body)).status).toBe(400)
    expect((await saveOf(gh, { session, objects: [{ id: ID_A, text: text(ID_A, 'x'.repeat(250_000)) }] })).status).toBe(413)
    expect(gh.mock).not.toHaveBeenCalled()
  })

  it('asks to sign in again when GitHub refuses the token', async () => {
    const gh = fakeGitHub()
    gh.mock.mockImplementation(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
    expect((await saveOf(gh, objects(ID_A))).status).toBe(401)
  })
})

describe('the commit message', () => {
  it('names the session and lists the titles, marked as new, changed or deleted', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, { session, objects: [{ id: ID_A, text: text(ID_A, 'Karte vom Dachboden') }] })
    const response = await saveOf(gh, {
      session,
      objects: [
        { id: ID_A, text: text(ID_A, 'Karte vom Dachboden, 1930'), change: 'changed' },
        { id: ID_B, text: text(ID_B, '"Prospekt: Ofen"'), change: 'new' },
      ],
    })
    const { commit } = (await response.json()) as { commit: string }
    expect(gh.state.commits[commit].message).toBe('Dachbodenfund Postkarten: 1 neu, 1 geändert\n\n~ Karte vom Dachboden, 1930\n+ Prospekt: Ofen')
  })

  it('takes the title of a deleted object from the request, and names it by its id if there is none', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A, ID_B))
    const response = await saveOf(gh, { session, deleted: [{ id: ID_A, title: 'Brief von 1929' }, ID_B] })
    const { commit } = (await response.json()) as { commit: string }
    expect(gh.state.commits[commit].message).toBe(`Dachbodenfund Postkarten: 2 gelöscht\n\n- Brief von 1929\n- Objekt ${ID_B.slice(-6)}`)
  })

  it('leaves a deleted object out that was not on the branch', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A))
    const response = await saveOf(gh, { session, objects: [{ id: ID_B, text: text(ID_B, 'Neu') }], deleted: [{ id: '01JABCDEFGHJKMNPQRSTVWXYZ2', title: 'Nie da' }] })
    const { commit } = (await response.json()) as { commit: string }
    expect(gh.state.commits[commit].message).toBe('Dachbodenfund Postkarten: + Neu')
  })

  it('shortens a long first line and keeps one line per object short of control characters', () => {
    const long = messageOf('Sitzung', [{ mark: '+', label: 'x'.repeat(200) }])
    expect(long.length).toBe(72)
    expect(long.endsWith('…')).toBe(true)
    expect(messageOf('S', [{ mark: '+', label: 'a' }, { mark: '~', label: 'b' }, { mark: '-', label: 'c' }])).toBe('S: 1 neu, 1 geändert, 1 gelöscht\n\n+ a\n~ b\n- c')
  })
})

describe('deleting', () => {
  it('removes a file that is on the branch, in a commit of its own', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A, ID_B))
    const response = await saveOf(gh, { session, deleted: [ID_A] })
    const { commit, deleted } = (await response.json()) as { commit: string; deleted: number }
    expect(deleted).toBe(1)
    expect(gh.state.commits[commit].message).toBe(`Dachbodenfund Postkarten: - Objekt ${ID_A.slice(-6)}`)
    const tree = gh.state.trees[gh.state.commits[commit].tree]
    expect(tree.entries).toEqual([{ path: objectPath(ID_A), mode: '100644', type: 'blob', sha: null }])
    expect([...tree.paths]).toEqual([objectPath(ID_B)])
  })

  it('combines writing and deleting in one commit', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A))
    const { commit } = (await (await saveOf(gh, { session, objects: [{ id: ID_B, text: text(ID_B) }], deleted: [ID_A] })).json()) as { commit: string }
    expect(gh.state.commits[commit].message).toBe(`Dachbodenfund Postkarten: 1 neu, 1 gelöscht\n\n+ Brief\n- Objekt ${ID_A.slice(-6)}`)
    expect([...gh.state.trees[gh.state.commits[commit].tree].paths]).toEqual([objectPath(ID_B)])
  })

  it('does nothing for a file that is not there: no commit, no branch', async () => {
    const gh = fakeGitHub()
    const response = await saveOf(gh, { session, deleted: [ID_A] })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { commit: unknown }).commit).toBeNull()
    expect(Object.keys(gh.state.refs)).toEqual(['main'])
    expect(gh.state.pulls).toHaveLength(0)
  })
})

describe('the pull request as a draft', () => {
  it('opens a draft with the first save and reuses it afterwards', async () => {
    const gh = fakeGitHub()
    const first = (await (await saveOf(gh, objects(ID_A))).json()) as { pull: { number: number; url: string; draft: boolean } }
    expect(first.pull.draft).toBe(true)
    expect(first.pull.url).toBe(`https://github.com/verein/archiv-data/pull/${first.pull.number}`)
    const created = gh.state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ head: BRANCH, base: 'main', draft: true })
    expect(created.body.title).toMatch(/^Dachbodenfund Postkarten \(Anna Beispiel, \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\)$/)
    expect(created.body.body).toContain('<!-- tamandua-session: {"slug":"dachbodenfund-postkarten-4k2x","name":"Dachbodenfund Postkarten"} -->')

    const second = (await (await saveOf(gh, objects(ID_B))).json()) as { pull: { number: number } }
    expect(second.pull.number).toBe(first.pull.number)
    expect(gh.state.pulls).toHaveLength(1)
  })

  it('still saves when the pull request cannot be opened', async () => {
    const response = await saveOf(fakeGitHub({ emptyPull: true }), objects(ID_A))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { pull?: unknown }).pull).toBeUndefined()
  })

  it('gives the title the time in Berlin', () => {
    expect(titleOf('Protokolle', 'Anna', new Date('2026-11-07T22:47:00Z'))).toBe('Protokolle (Anna, 07.11.2026, 23:47)')
    expect(titleOf('Protokolle', 'Anna', new Date('2026-07-01T10:05:00Z'))).toBe('Protokolle (Anna, 01.07.2026, 12:05)')
  })

  it('puts the session into the text of the pull request so that it can be found again', () => {
    expect(bodyOf('anna', { slug: 'x-1', name: 'A --> B' })).not.toMatch(/-->.*-->/s)
    expect(bodyOf('anna', { slug: 'x-1', name: 'Ä' })).toContain('"name":"Ä"')
  })

  it('names the branch after the person and the session', () => {
    expect(branchOf('anna', 'x-1')).toBe('erfassung/anna/x-1')
    expect(branchOf('a.b_c', 'x-1')).toBe('erfassung/a-b-c/x-1')
  })

  it('cleans the name of a session', () => {
    expect(parseSessionRef({ slug: 'a-1', name: '  Hallo\n <b>Welt</b>  ' })).toEqual({ slug: 'a-1', name: 'Hallo b Welt /b' })
  })
})

describe('a submitted session is frozen', () => {
  it('marks the draft ready for review', async () => {
    const gh = fakeGitHub()
    const saved = (await (await saveOf(gh, objects(ID_A))).json()) as { pull: { number: number } }
    const submitted = (await (await handle(post('/repo/submit', { session }), env, gh.fn)).json()) as { number: number; draft: boolean }
    expect(submitted).toMatchObject({ number: saved.pull.number, draft: false })
    expect(gh.state.pulls[0].draft).toBe(false)
    expect(gh.state.pulls).toHaveLength(1)
    const again = (await (await handle(post('/repo/submit', { session }), env, gh.fn)).json()) as { draft: boolean }
    expect(again.draft).toBe(false)
  })

  it('refuses further saves, without a commit', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A))
    await handle(post('/repo/submit', { session }), env, gh.fn)
    const head = gh.state.refs[BRANCH]
    const response = await saveOf(gh, objects(ID_B))
    expect(response.status).toBe(409)
    expect(((await response.json()) as { locked: boolean }).locked).toBe(true)
    expect((await saveOf(gh, { session, deleted: [ID_A] })).status).toBe(409)
    expect(gh.state.refs[BRANCH]).toBe(head)
  })

  it('takes saves again once the pull request is closed without merging (a new draft is opened)', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A))
    await handle(post('/repo/submit', { session }), env, gh.fn)
    gh.state.pulls[0].state = 'closed'
    const response = await saveOf(gh, objects(ID_B))
    expect(response.status).toBe(200)
    expect(gh.state.pulls).toHaveLength(2)
    expect(gh.state.pulls[1].draft).toBe(true)
  })

  it('opens the pull request if there is none yet', async () => {
    const gh = fakeGitHub()
    gh.state.refs[BRANCH] = 'c0'
    const response = await handle(post('/repo/submit', { session }), env, gh.fn)
    expect(response.status).toBe(200)
    expect(gh.state.pulls[0].draft).toBe(false)
  })

  it('says there is nothing to submit when the branch has nothing new', async () => {
    expect((await handle(post('/repo/submit', { session }), env, fakeGitHub({ emptyPull: true }).fn)).status).toBe(409)
  })

  it('reports a failure of GitHub when the draft cannot be marked ready', async () => {
    const gh = fakeGitHub({ graphqlFails: true })
    await saveOf(gh, objects(ID_A))
    expect((await handle(post('/repo/submit', { session }), env, gh.fn)).status).toBe(502)
  })

  it('needs a session to submit', async () => {
    expect((await handle(post('/repo/submit', {}), env, fakeGitHub().fn)).status).toBe(400)
  })
})

describe('POST /repo/rename', () => {
  it('gives the open pull request the new name in its title and text', async () => {
    const gh = fakeGitHub()
    await saveOf(gh, objects(ID_A))
    const renamed = { slug: session.slug, name: 'Postkarten vom Dachboden' }
    const response = await handle(post('/repo/rename', { session: renamed }), env, gh.fn)
    expect(response.status).toBe(200)
    expect(gh.state.pulls[0].title).toMatch(/^Postkarten vom Dachboden \(Anna Beispiel,/)
    expect(gh.state.pulls[0].body).toContain('"name":"Postkarten vom Dachboden"')
  })

  it('does nothing when there is no pull request yet', async () => {
    const gh = fakeGitHub()
    const response = await handle(post('/repo/rename', { session }), env, gh.fn)
    expect(((await response.json()) as { pull: unknown }).pull).toBeNull()
    expect(gh.state.pulls).toHaveLength(0)
  })
})

describe('GET /repo/pull', () => {
  it('reports whether a pull request is a draft, open or merged', async () => {
    const gh = fakeGitHub()
    const { pull } = (await (await saveOf(gh, objects(ID_A))).json()) as { pull: { number: number } }
    const get = async () => (await handle(new Request(`http://worker/api/repo/pull/${pull.number}`, { headers: { cookie } }), env, gh.fn)).json()
    expect(await get()).toMatchObject({ state: 'open', merged: false, draft: true })
    await handle(post('/repo/submit', { session }), env, gh.fn)
    expect(await get()).toMatchObject({ state: 'open', merged: false, draft: false })
    gh.state.pulls[0].state = 'closed'
    gh.state.pulls[0].merged = true
    expect(await get()).toMatchObject({ state: 'closed', merged: true })
  })

  it('only takes numbers as the pull request', async () => {
    const gh = fakeGitHub()
    const response = await handle(new Request('http://worker/api/repo/pull/abc', { headers: { cookie } }), env, gh.fn)
    expect(response.status).toBe(404)
    expect(gh.mock).not.toHaveBeenCalled()
  })
})


describe('GET /repo/erfassungen and /repo/erfassung/<n>', () => {
  const get = (path: string) => handle(new Request(`http://worker/api${path}`, { headers: { cookie } }), env, gh.fn)
  let gh: ReturnType<typeof fakeGitHub>

  it('lists the sessions of everybody, and only sessions', async () => {
    gh = fakeGitHub()
    await saveOf(gh, objects(ID_A)) // anna's session, a draft
    gh.state.refs['erfassung/bernd/protokolle-9zzz'] = 'c0'
    gh.state.pulls.push({ number: 90, head: 'erfassung/bernd/protokolle-9zzz', state: 'open', merged: false, draft: false, title: 'Protokolle (Bernd, 08.11.2026, 10:00)', body: bodyOf('bernd', { slug: 'protokolle-9zzz', name: 'Protokolle' }) })
    gh.state.refs['feature/something'] = 'c0'
    gh.state.pulls.push({ number: 91, head: 'feature/something', state: 'open', merged: false, draft: false, title: 'Not a session', body: '' })

    const response = await get('/repo/erfassungen')
    expect(response.status).toBe(200)
    const { erfassungen } = (await response.json()) as { erfassungen: { number: number; state: string; login: string; slug: string; name: string }[] }
    expect(erfassungen.map((e) => [e.login, e.slug, e.name, e.state])).toEqual([
      ['bernd', 'protokolle-9zzz', 'Protokolle', 'submitted'],
      ['anna', 'dachbodenfund-postkarten-4k2x', 'Dachbodenfund Postkarten', 'open'],
    ])
    expect(gh.state.calls.every((c) => c.auth === 'Bearer ghu_anna')).toBe(true)
  })

  it('takes the state from the pull request: draft is open, ready is submitted, merged is merged, closed unmerged is open again', () => {
    const pull = (over: object) => ({ number: 1, html_url: 'u', state: 'open' as const, merged_at: null, draft: true, title: 'Name (Anna, 01.01.2026, 10:00)', body: null, created_at: 't', head: { ref: 'erfassung/anna/name-1', sha: 's' }, ...over })
    const states = [{}, { draft: false }, { state: 'closed', merged_at: 'x', draft: false }, { state: 'closed', draft: false }].map((o) => erfassungenOf([pull(o)])[0].state)
    expect(states).toEqual(['open', 'submitted', 'merged', 'open'])
    // Without the marker the name is the title without the person and date.
    expect(erfassungenOf([pull({})])[0].name).toBe('Name')
  })

  it('reads the marker back that bodyOf wrote, also when the name has dashes', () => {
    const marker = { slug: 'x-1', name: 'A -- B <!-- c' }
    expect(markerOf(bodyOf('anna', marker))).toEqual(marker)
    expect(markerOf('nothing here')).toBeUndefined()
    expect(markerOf(null)).toBeUndefined()
  })

  it('tells what a session changed: its objects, where to read them, at which commit', async () => {
    gh = fakeGitHub()
    const saved = (await (await saveOf(gh, objects(ID_A, ID_B))).json()) as { commit: string; pull: { number: number } }
    const response = await get(`/repo/erfassung/${saved.pull.number}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      head: saved.commit,
      raw: `https://raw.githubusercontent.com/verein/archiv-data/${saved.commit}`,
      objects: [
        { id: ID_A, path: objectPath(ID_A), status: 'added' },
        { id: ID_B, path: objectPath(ID_B), status: 'added' },
      ],
    })
  })

  it('leaves out an object that was added and removed again within the session', async () => {
    gh = fakeGitHub()
    await saveOf(gh, objects(ID_A, ID_B))
    const second = (await (await saveOf(gh, { session, objects: [], deleted: [{ id: ID_B, title: 'Brief' }] })).json()) as { pull: { number: number } }
    const response = await get(`/repo/erfassung/${second.pull.number}`)
    const { objects: list } = (await response.json()) as { objects: { id: string }[] }
    expect(list.map((o) => o.id)).toEqual([ID_A])
  })

  it('names the bucket the files can be read from, when the Worker knows it', async () => {
    gh = fakeGitHub()
    const saved = (await (await saveOf(gh, objects(ID_A))).json()) as { pull: { number: number } }
    const withStorage = { ...env, S3_ENDPOINT: 'https://nbg1.your-objectstorage.com', S3_BUCKET: 'archiv-test', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }
    const response = await handle(new Request(`http://worker/api/repo/erfassung/${saved.pull.number}`, { headers: { cookie } }), withStorage, gh.fn)
    expect(((await response.json()) as { files: string }).files).toBe('https://archiv-test.nbg1.your-objectstorage.com')
  })

  it('refuses without a sign-in and for a pull request that is not there', async () => {
    gh = fakeGitHub()
    expect((await handle(new Request('http://worker/api/repo/erfassungen'), env, gh.fn)).status).toBe(401)
    expect((await get('/repo/erfassung/999')).status).toBe(502)
  })
})

describe('GET /repo/objects', () => {
  it('lists the object files of main, and where their text can be read', async () => {
    const gh = fakeGitHub()
    const saved = (await (await saveOf(gh, objects(ID_A, ID_B))).json()) as { commit: string }
    // Nothing is in the archive until the session is merged.
    const empty = await handle(new Request('http://worker/api/repo/objects', { headers: { cookie } }), env, gh.fn)
    expect(((await empty.json()) as { objects: unknown[] }).objects).toEqual([])

    gh.state.refs.main = saved.commit // merged
    const response = await handle(new Request('http://worker/api/repo/objects', { headers: { cookie } }), env, gh.fn)
    expect(response.status).toBe(200)
    const data = (await response.json()) as { head: string; raw: string; objects: { id: string; path: string }[] }
    expect(data.head).toBe(saved.commit)
    expect(data.raw).toBe(`https://raw.githubusercontent.com/verein/archiv-data/${saved.commit}`)
    expect(data.objects).toEqual([
      { id: ID_A, path: objectPath(ID_A), sha: blobSha(text(ID_A)) },
      { id: ID_B, path: objectPath(ID_B), sha: blobSha(text(ID_B)) },
    ])
  })

  it('is for signed-in people only', async () => {
    const gh = fakeGitHub()
    expect((await handle(new Request('http://worker/api/repo/objects'), env, gh.fn)).status).toBe(401)
  })
})

describe('GET /repo/snapshot', () => {
  it('tells where the snapshot of the data repository is', async () => {
    const gh = fakeGitHub()
    const response = await handle(new Request('http://worker/api/repo/snapshot', { headers: { cookie } }), env, gh.fn)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ url: 'https://raw.githubusercontent.com/verein/archiv-data/snapshot/snapshot.ndjson.gz' })
  })

  it('is for signed-in people only', async () => {
    const gh = fakeGitHub()
    expect((await handle(new Request('http://worker/api/repo/snapshot'), env, gh.fn)).status).toBe(401)
  })
})

describe('GET /repo/changes', () => {
  const changes = (gh: ReturnType<typeof fakeGitHub>, since: string) => handle(new Request(`http://worker/api/repo/changes?since=${since}`, { headers: { cookie } }), env, gh.fn)
  const merge = async (gh: ReturnType<typeof fakeGitHub>, data: unknown) => {
    const saved = (await (await saveOf(gh, data)).json()) as { commit: string }
    gh.state.refs.main = saved.commit
    return saved.commit
  }

  it('tells which objects were added, changed and removed since a commit', async () => {
    const gh = fakeGitHub()
    const first = await merge(gh, objects(ID_A))
    const second = await merge(gh, { session, objects: [{ id: ID_B, text: text(ID_B) }, { id: ID_A, text: text(ID_A, 'Anderer Titel'), change: 'changed' }] })
    const response = await changes(gh, first)
    expect(response.status).toBe(200)
    const data = (await response.json()) as { head: string; raw: string; changes: unknown[] }
    expect(data.head).toBe(second)
    expect(data.raw).toBe(`https://raw.githubusercontent.com/verein/archiv-data/${second}`)
    expect(data.changes).toEqual([
      { id: ID_A, path: objectPath(ID_A), sha: blobSha(text(ID_A, 'Anderer Titel')), status: 'modified' },
      { id: ID_B, path: objectPath(ID_B), sha: blobSha(text(ID_B)), status: 'added' },
    ])

    const third = await merge(gh, { session, deleted: [ID_A] })
    const removed = (await (await changes(gh, second)).json()) as { head: string; changes: { id: string; status: string }[] }
    expect(removed.head).toBe(third)
    expect(removed.changes.map((c) => [c.id, c.status])).toEqual([[ID_A, 'removed']])
  })

  it('has nothing to tell when nothing changed', async () => {
    const gh = fakeGitHub()
    const head = await merge(gh, objects(ID_A))
    expect(await (await changes(gh, head)).json()).toMatchObject({ head, changes: [] })
  })

  it('asks to read everything again when the commit is not known or the branch was rewritten', async () => {
    const gh = fakeGitHub()
    const first = await merge(gh, objects(ID_A))
    expect(await (await changes(gh, 'unknown')).json()).toEqual({ reload: true })
    gh.state.refs.main = 'c0' // rewritten: the old head is no ancestor any more
    gh.state.commits.cx = { tree: 't0', parents: [], message: 'rewritten' }
    gh.state.refs.main = 'cx'
    expect(await (await changes(gh, first)).json()).toEqual({ reload: true })
  })

  it('refuses a "since" that is no commit, and signed-out people', async () => {
    const gh = fakeGitHub()
    expect((await changes(gh, '..%2F..')).status).toBe(400)
    expect((await handle(new Request('http://worker/api/repo/changes?since=c0'), env, gh.fn)).status).toBe(401)
  })
})
