import { describe, expect, it } from 'vitest'
import { handle, type Env } from '../src/index.js'
import { titleOf } from '../src/repo.js'
import { authEnv, cookieOf, fakeGitHub } from './support.js'

const env: Env = { ...authEnv }
const cookie = await cookieOf()
const post = (path: string, data?: unknown) =>
  new Request(`http://worker/api${path}`, { method: 'POST', headers: { cookie }, body: data === undefined ? undefined : JSON.stringify(data) })

const ID_A = '01JABCDEFGHJKMNPQRSTVWXYZ0'
const ID_B = '01JABCDEFGHJKMNPQRSTVWXYZ1'
const text = (id: string, title = 'Brief') => `id: ${id}\ntype: document\ntitle: ${title}\n`
const objects = (...ids: string[]) => ({ objects: ids.map((id) => ({ id, text: text(id) })) })

describe('POST /repo/save', () => {
  it('puts the objects into one commit on the person\'s own branch, made from main', async () => {
    const gh = fakeGitHub()
    const response = await handle(post('/repo/save', objects(ID_A, ID_B)), env, gh.fn)
    expect(response.status).toBe(200)
    const { commit, saved } = (await response.json()) as { commit: string; saved: number }
    expect(saved).toBe(2)

    expect(gh.state.refs['erfassung/anna']).toBe(commit)
    expect(gh.state.commits[commit].parents).toEqual(['c0']) // the branch started at main
    expect(gh.state.commits[commit].message).toBe('Erfassung: 2 Objekte')
    const tree = gh.state.trees[gh.state.commits[commit].tree]
    expect(tree.entries.map((e) => e.path)).toEqual([`objects/HJ/${ID_A}.yaml`, `objects/HJ/${ID_B}.yaml`])
    expect(tree.entries[0].content).toBe(text(ID_A))
    // Everything ran with the person's own token.
    expect(gh.state.calls.every((c) => c.auth === 'Bearer ghu_anna')).toBe(true)
  })

  it('adds to the branch on the next save', async () => {
    const gh = fakeGitHub()
    const first = (await (await handle(post('/repo/save', objects(ID_A)), env, gh.fn)).json()) as { commit: string }
    const second = (await (await handle(post('/repo/save', objects(ID_A)), env, gh.fn)).json()) as { commit: string }
    expect(gh.state.commits[second.commit].parents).toEqual([first.commit])
    expect(gh.state.refs['erfassung/anna']).toBe(second.commit)
    expect(gh.state.commits[second.commit].message).toBe('Erfassung: 1 Objekt')
  })

  it('tries again once when the branch moved in the meantime', async () => {
    const gh = fakeGitHub({ patchFailures: 1 })
    expect((await handle(post('/repo/save', objects(ID_A)), env, gh.fn)).status).toBe(200)
    const gone = fakeGitHub({ patchFailures: 2 })
    expect((await handle(post('/repo/save', objects(ID_A)), env, gone.fn)).status).toBe(502)
  })

  it('refuses what is not an object, before it asks GitHub anything', async () => {
    const gh = fakeGitHub()
    const bad = [
      {},
      { objects: [] },
      { objects: [{ id: 'nope', text: text(ID_A) }] },
      { objects: [{ id: '../../etc/passwd', text: 'x' }] },
      { objects: [{ id: ID_A, text: text(ID_B) }] }, // the id inside differs
      { objects: [{ id: ID_A, text: 'title: no id' }] },
      { objects: [{ id: ID_A }] },
      { objects: [{ id: ID_A, text: text(ID_A) }, { id: ID_A, text: text(ID_A) }] },
      { objects: Array.from({ length: 51 }, () => ({ id: ID_A, text: text(ID_A) })) },
    ]
    for (const body of bad) expect((await handle(post('/repo/save', body), env, gh.fn)).status).toBe(400)
    expect((await handle(post('/repo/save', { objects: [{ id: ID_A, text: text(ID_A, 'x'.repeat(250_000)) }] }), env, gh.fn)).status).toBe(413)
    expect(gh.mock).not.toHaveBeenCalled()
  })

  it('asks to sign in again when GitHub refuses the token', async () => {
    const gh = fakeGitHub()
    gh.mock.mockImplementation(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
    expect((await handle(post('/repo/save', objects(ID_A)), env, gh.fn)).status).toBe(401)
  })
})

describe('the pull request as a draft', () => {
  it('opens a draft with the first save and reuses it afterwards', async () => {
    const gh = fakeGitHub()
    const first = (await (await handle(post('/repo/save', objects(ID_A)), env, gh.fn)).json()) as { pull: { number: number; url: string; draft: boolean } }
    expect(first.pull.draft).toBe(true)
    expect(first.pull.url).toBe(`https://github.com/verein/archiv-data/pull/${first.pull.number}`)
    const created = gh.state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ head: 'erfassung/anna', base: 'main', draft: true })
    expect(created.body.title).toMatch(/^Erfassung von Anna Beispiel \(\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\)$/)

    const second = (await (await handle(post('/repo/save', objects(ID_B)), env, gh.fn)).json()) as { pull: { number: number } }
    expect(second.pull.number).toBe(first.pull.number)
    expect(gh.state.pulls).toHaveLength(1)
  })

  it('still saves when the pull request cannot be opened', async () => {
    const response = await handle(post('/repo/save', objects(ID_A)), env, fakeGitHub({ emptyPull: true }).fn)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { pull?: unknown }).pull).toBeUndefined()
  })

  it('gives the title the time in Berlin', () => {
    expect(titleOf('Anna', new Date('2026-11-07T22:47:00Z'))).toBe('Erfassung von Anna (07.11.2026, 23:47)')
    expect(titleOf('Anna', new Date('2026-07-01T10:05:00Z'))).toBe('Erfassung von Anna (01.07.2026, 12:05)')
  })
})

describe('POST /repo/submit and GET /repo/pull', () => {
  it('marks the draft ready for review', async () => {
    const gh = fakeGitHub()
    const saved = (await (await handle(post('/repo/save', objects(ID_A)), env, gh.fn)).json()) as { pull: { number: number } }
    const submitted = (await (await handle(post('/repo/submit'), env, gh.fn)).json()) as { number: number; draft: boolean }
    expect(submitted).toMatchObject({ number: saved.pull.number, draft: false })
    expect(gh.state.pulls[0].draft).toBe(false)
    expect(gh.state.pulls).toHaveLength(1)
    // Submitting again changes nothing.
    const again = (await (await handle(post('/repo/submit'), env, gh.fn)).json()) as { number: number; draft: boolean }
    expect(again).toMatchObject({ number: saved.pull.number, draft: false })
  })

  it('opens the pull request if the save could not', async () => {
    const gh = fakeGitHub()
    gh.state.refs['erfassung/anna'] = 'c0'
    const response = await handle(post('/repo/submit'), env, gh.fn)
    expect(response.status).toBe(200)
    expect(gh.state.pulls[0].draft).toBe(false)
  })

  it('says there is nothing to submit when the branch has nothing new', async () => {
    const response = await handle(post('/repo/submit'), env, fakeGitHub({ emptyPull: true }).fn)
    expect(response.status).toBe(409)
  })

  it('reports a failure of GitHub when the draft cannot be marked ready', async () => {
    const gh = fakeGitHub({ graphqlFails: true })
    await handle(post('/repo/save', objects(ID_A)), env, gh.fn)
    expect((await handle(post('/repo/submit'), env, gh.fn)).status).toBe(502)
  })

  it('reports whether a pull request is a draft, open or merged', async () => {
    const gh = fakeGitHub()
    const { pull } = (await (await handle(post('/repo/save', objects(ID_A)), env, gh.fn)).json()) as { pull: { number: number } }
    const get = async () => (await handle(new Request(`http://worker/api/repo/pull/${pull.number}`, { headers: { cookie } }), env, gh.fn)).json()
    expect(await get()).toMatchObject({ state: 'open', merged: false, draft: true })
    await handle(post('/repo/submit'), env, gh.fn)
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
