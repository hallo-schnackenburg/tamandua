// Signing in with GitHub (a GitHub App's web flow with PKCE) and the session cookie.
//
//   GET  /auth/login     sends the browser to GitHub
//   GET  /auth/callback  GitHub sends it back; we check who it is and what they may do in the data repository
//   GET  /auth/me        who is signed in (401 if nobody)
//   POST /auth/logout    ends the session
//
// Who may use the tool is decided by GitHub: whoever has write access to the data repository.

import { currentUser, exchangeCode, refreshTokens, repoRole, revoke, type GithubEnv, type Tokens } from './github.js'
import { LOGIN_COOKIE, SESSION_COOKIE, SESSION_DAYS, challengeOf, randomToken, readCookie, seal, setCookie, unseal, type Auth } from './session.js'

export interface AuthEnv extends GithubEnv {
  SESSION_SECRET?: string
  /** Where the app is reached from outside, e.g. https://tamandua.schnackenburg.de (no slash at the end). */
  APP_URL?: string
}

const MAX_AGE = SESSION_DAYS * 24 * 3600
/** Renew the access token when it has less than this left. */
const RENEW_BEFORE = 5 * 60 * 1000

export function authConfigured(env: AuthEnv): boolean {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET && env.DATA_REPO && env.APP_URL)
}

const isHttps = (request: Request) => new URL(request.url).protocol === 'https:'

function redirect(to: string, cookies: string[] = []): Response {
  const headers = new Headers({ location: to })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

const forget = (name: string, secure: boolean) => setCookie(name, '', 0, secure)

export interface Signed {
  session: Auth
  /** Set when the session was renewed and the browser has to get the new cookie. */
  cookie?: string
}

/** The signed-in person of a request, with the token renewed if it is about to expire. Null if nobody. */
export async function readSession(request: Request, env: AuthEnv, fetchFn: typeof fetch): Promise<Signed | null> {
  const raw = readCookie(request, SESSION_COOKIE)
  if (!raw || !env.SESSION_SECRET) return null
  const session = await unseal<Auth>(raw, env.SESSION_SECRET)
  if (!session) return null

  if (session.accessExpires - Date.now() > RENEW_BEFORE) return { session }
  if (!session.refresh || (session.refreshExpires ?? Infinity) < Date.now()) return null
  try {
    const tokens = await refreshTokens(env, session.refresh, fetchFn)
    const renewed = withTokens(session, tokens)
    return { session: renewed, cookie: setCookie(SESSION_COOKIE, await seal(renewed, env.SESSION_SECRET), MAX_AGE, isHttps(request)) }
  } catch {
    return null
  }
}

const withTokens = (session: Auth, tokens: Tokens): Auth => ({
  ...session,
  access: tokens.access,
  accessExpires: tokens.accessExpires,
  refresh: tokens.refresh,
  refreshExpires: tokens.refreshExpires,
})

export async function handleAuth(request: Request, route: string, env: AuthEnv, fetchFn: typeof fetch): Promise<Response | null> {
  if (!['/auth/login', '/auth/callback', '/auth/me', '/auth/logout'].includes(route)) return null
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!authConfigured(env)) return json({ error: 'The server is not set up for sign-in (GITHUB_*, SESSION_SECRET, DATA_REPO, APP_URL).' }, 500)

  const secure = isHttps(request)
  const url = new URL(request.url)
  const appUrl = env.APP_URL!.replace(/\/$/, '')

  if (route === '/auth/login' && request.method === 'GET') {
    const state = randomToken(16)
    const verifier = randomToken(32)
    const authorize = new URL('https://github.com/login/oauth/authorize')
    authorize.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID!,
      redirect_uri: `${appUrl}/api/auth/callback`,
      state,
      code_challenge: await challengeOf(verifier),
      code_challenge_method: 'S256',
    }).toString()
    // State and verifier wait in a short-lived cookie until GitHub sends the person back.
    return redirect(authorize.toString(), [setCookie(LOGIN_COOKIE, await seal({ state, verifier }, env.SESSION_SECRET!), 600, secure)])
  }

  if (route === '/auth/callback' && request.method === 'GET') {
    const pending = await unseal<{ state: string; verifier: string }>(readCookie(request, LOGIN_COOKIE) ?? '', env.SESSION_SECRET!)
    const code = url.searchParams.get('code')
    const cleanup = forget(LOGIN_COOKIE, secure)
    if (!pending || !code || url.searchParams.get('state') !== pending.state) return redirect(`${appUrl}/?login=failed`, [cleanup])

    try {
      const tokens = await exchangeCode(env, code, pending.verifier, `${appUrl}/api/auth/callback`, fetchFn)
      const user = await currentUser(tokens.access, fetchFn)
      const role = await repoRole(tokens.access, env.DATA_REPO!, fetchFn)
      if (role === 'none') {
        await revoke(env, tokens.access, fetchFn)
        return redirect(`${appUrl}/?login=denied&user=${encodeURIComponent(user.login)}`, [cleanup])
      }
      const session: Auth = { ...user, role, access: tokens.access, accessExpires: tokens.accessExpires, refresh: tokens.refresh, refreshExpires: tokens.refreshExpires }
      return redirect(`${appUrl}/`, [cleanup, setCookie(SESSION_COOKIE, await seal(session, env.SESSION_SECRET!), MAX_AGE, secure)])
    } catch (error) {
      console.error('Sign-in failed', (error as Error).message)
      return redirect(`${appUrl}/?login=failed`, [cleanup])
    }
  }

  if (route === '/auth/me' && request.method === 'GET') {
    const signed = await readSession(request, env, fetchFn)
    if (!signed) return json({ error: 'Not signed in.' }, 401)
    const { login, name, avatar, role } = signed.session
    const response = json({ login, name, avatar, role })
    if (signed.cookie) response.headers.append('set-cookie', signed.cookie)
    return response
  }

  if (route === '/auth/logout' && request.method === 'POST') {
    const signed = await readSession(request, env, fetchFn)
    if (signed) await revoke(env, signed.session.access, fetchFn)
    const response = json({ ok: true })
    response.headers.append('set-cookie', forget(SESSION_COOKIE, secure))
    return response
  }

  return json({ error: 'Not found.' }, 404)
}
