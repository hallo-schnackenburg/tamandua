import { describe, expect, it } from 'vitest'
import { handle, type Env } from '../src/index.js'
import { anna, authEnv, cookieOf, fakeGitHub } from './support.js'

const env: Env = { ...authEnv }
const get = (path: string, cookie?: string) => new Request(`http://worker${path}`, { headers: cookie ? { cookie } : {} })
const cookiesOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(';')[0])
const cookieValue = (response: Response, name: string) => cookiesOf(response).find((c) => c.startsWith(`${name}=`))

/** Starts a sign-in and returns what GitHub would be sent and the cookie that waits for the answer. */
async function startLogin(gh = fakeGitHub()) {
  const response = await handle(get('/api/auth/login'), env, gh.fn)
  return { response, to: new URL(response.headers.get('location')!), waiting: cookieValue(response, 'tamandua_login')! }
}

describe('sign-in', () => {
  it('sends the browser to GitHub with state and PKCE', async () => {
    const { response, to, waiting } = await startLogin()
    expect(response.status).toBe(302)
    expect(`${to.origin}${to.pathname}`).toBe('https://github.com/login/oauth/authorize')
    expect(to.searchParams.get('client_id')).toBe('cid')
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/callback')
    expect(to.searchParams.get('code_challenge_method')).toBe('S256')
    expect(to.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(to.searchParams.get('state')).toBeTruthy()
    expect(waiting).toBeTruthy()
    const raw = response.headers.getSetCookie()[0]
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Lax')
    expect(raw).not.toContain('Secure') // plain http on localhost
  })

  it('makes a new state every time', async () => {
    const a = (await startLogin()).to.searchParams.get('state')
    const b = (await startLogin()).to.searchParams.get('state')
    expect(a).not.toBe(b)
  })

  it('signs a collaborator in and keeps the tokens out of the answers', async () => {
    const gh = fakeGitHub()
    const { to, waiting } = await startLogin(gh)
    const back = await handle(get(`/api/auth/callback?code=good&state=${to.searchParams.get('state')}`, waiting), env, gh.fn)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('http://localhost:5173/')
    const session = cookieValue(back, 'tamandua_session')!
    expect(session).toBeTruthy()
    expect(session).not.toContain('ghu_') // sealed, not readable
    expect(back.headers.getSetCookie().find((c) => c.startsWith('tamandua_login='))).toContain('Max-Age=0')

    // PKCE: the code is exchanged together with the verifier whose hash was sent first.
    const exchange = gh.state.calls.find((c) => c.url.endsWith('/access_token'))!
    expect(exchange.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(exchange.body.client_secret).toBe('csecret')

    const me = await handle(get('/api/auth/me', session), env, gh.fn)
    expect(await me.json()).toEqual({ login: 'anna', name: 'Anna Beispiel', avatar: 'https://avatars.example/anna', role: 'write' })
  })

  it('knows maintainers as reviewers', async () => {
    const gh = fakeGitHub({ permissions: { push: true, maintain: true } })
    const { to, waiting } = await startLogin(gh)
    const back = await handle(get(`/api/auth/callback?code=good&state=${to.searchParams.get('state')}`, waiting), env, gh.fn)
    const me = await handle(get('/api/auth/me', cookieValue(back, 'tamandua_session')), env, gh.fn)
    expect(((await me.json()) as { role: string }).role).toBe('admin')
  })

  it('does not sign in someone without write access and takes the token back', async () => {
    const gh = fakeGitHub({ permissions: { pull: true } })
    const { to, waiting } = await startLogin(gh)
    const back = await handle(get(`/api/auth/callback?code=good&state=${to.searchParams.get('state')}`, waiting), env, gh.fn)
    expect(back.headers.get('location')).toBe('http://localhost:5173/?login=denied&user=anna')
    expect(cookieValue(back, 'tamandua_session')).toBeUndefined()
    expect(gh.state.revoked).toBe(1)
  })

  it('refuses a callback with the wrong state, a missing cookie or a bad code', async () => {
    const gh = fakeGitHub()
    const { waiting } = await startLogin(gh)
    const wrongState = await handle(get('/api/auth/callback?code=good&state=other', waiting), env, gh.fn)
    expect(wrongState.headers.get('location')).toBe('http://localhost:5173/?login=failed')
    const noCookie = await handle(get('/api/auth/callback?code=good&state=x'), env, gh.fn)
    expect(noCookie.headers.get('location')).toBe('http://localhost:5173/?login=failed')
    const { to, waiting: again } = await startLogin(gh)
    const badCode = await handle(get(`/api/auth/callback?code=bad&state=${to.searchParams.get('state')}`, again), env, gh.fn)
    expect(badCode.headers.get('location')).toBe('http://localhost:5173/?login=failed')
    expect(cookieValue(badCode, 'tamandua_session')).toBeUndefined()
  })

  it('answers 401 to "me" without a session and with a changed cookie', async () => {
    expect((await handle(get('/api/auth/me'), env, fakeGitHub().fn)).status).toBe(401)
    const good = await cookieOf()
    const changed = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect((await handle(get('/api/auth/me', changed), env, fakeGitHub().fn)).status).toBe(401)
  })

  it('signs out: cookie gone, token revoked', async () => {
    const gh = fakeGitHub()
    const response = await handle(new Request('http://worker/api/auth/logout', { method: 'POST', headers: { cookie: await cookieOf() } }), env, gh.fn)
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0')
    expect(gh.state.revoked).toBe(1)
  })

  it('says so when sign-in is not set up', async () => {
    expect((await handle(get('/api/auth/login'), {}, fakeGitHub().fn)).status).toBe(500)
  })
})

describe('the token of a session', () => {
  it('is renewed shortly before it runs out, and the new one goes into a new cookie', async () => {
    const gh = fakeGitHub()
    const almostOut = await cookieOf({ ...anna, accessExpires: Date.now() + 60_000 })
    const response = await handle(get('/api/auth/me', almostOut), env, gh.fn)
    expect(response.status).toBe(200)
    const renewed = cookieValue(response, 'tamandua_session')
    expect(renewed).toBeTruthy()
    expect(renewed).not.toBe(almostOut)

    // The next request uses the new token.
    gh.state.calls.length = 0
    await handle(get('/api/repo/pull/1', renewed), env, gh.fn)
    expect(gh.state.calls[0].auth).toBe('Bearer ghu_renewed')
  })

  it('ends when it cannot be renewed', async () => {
    const gh = fakeGitHub()
    const noRefresh = await cookieOf({ ...anna, accessExpires: Date.now() - 1, refresh: undefined })
    expect((await handle(get('/api/auth/me', noRefresh), env, gh.fn)).status).toBe(401)
    const refreshExpired = await cookieOf({ ...anna, accessExpires: Date.now() - 1, refreshExpires: Date.now() - 1 })
    expect((await handle(get('/api/auth/me', refreshExpired), env, gh.fn)).status).toBe(401)
    const revoked = await cookieOf({ ...anna, accessExpires: Date.now() - 1, refresh: 'ghr_revoked' })
    expect((await handle(get('/api/auth/me', revoked), env, gh.fn)).status).toBe(401)
  })
})
