import { vi } from 'vitest'
import { seal, SESSION_COOKIE, type Session } from '../src/session.js'

export const SECRET = 'test-secret-test-secret-test-secret'

/** The settings that make the Worker accept sign-ins. */
export const authEnv = {
  SESSION_SECRET: SECRET,
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  DATA_REPO: 'verein/archiv-data',
  BASE_BRANCH: 'main',
  APP_URL: 'http://localhost:5173',
}

export const anna: Session = {
  login: 'anna',
  name: 'Anna Beispiel',
  avatar: 'https://avatars.example/anna',
  role: 'write',
  access: 'ghu_anna',
  accessExpires: Date.now() + 3600_000,
  refresh: 'ghr_anna',
  refreshExpires: Date.now() + 86_400_000,
}

/** The Cookie header of a signed-in person. */
export async function cookieOf(session: Session = anna): Promise<string> {
  return `${SESSION_COOKIE}=${await seal(session, SECRET)}`
}

export interface Call {
  method: string
  url: string
  auth?: string
  body?: any
}

/** A small pretend GitHub: enough of the sign-in and the git/pull request API to follow what the Worker does. */
export function fakeGitHub(options: { permissions?: Record<string, boolean>; patchFailures?: number; emptyPull?: boolean } = {}) {
  const state = {
    refs: { main: 'c0' } as Record<string, string>,
    commits: { c0: { tree: 't0', parents: [] as string[], message: 'start' } } as Record<string, { tree: string; parents: string[]; message: string }>,
    trees: {} as Record<string, { base: string; entries: { path: string; content: string }[] }>,
    pulls: [] as { number: number; head: string; state: 'open' | 'closed'; merged: boolean }[],
    calls: [] as Call[],
    revoked: 0,
    patchFailures: options.patchFailures ?? 0,
    next: 1,
  }
  const reply = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status })

  const fn = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const auth = (init.headers as Record<string, string> | undefined)?.authorization
    const body = init.body ? JSON.parse(init.body as string) : undefined
    state.calls.push({ method, url: input, auth, body })
    const path = url.pathname.replace('/repos/verein/archiv-data', '')

    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
      if (body.grant_type === 'refresh_token') {
        return body.refresh_token === 'ghr_anna'
          ? reply({ access_token: 'ghu_renewed', expires_in: 28800, refresh_token: 'ghr_renewed', refresh_token_expires_in: 15897600 })
          : reply({ error: 'bad_refresh_token' })
      }
      return body.code === 'good'
        ? reply({ access_token: 'ghu_anna', expires_in: 28800, refresh_token: 'ghr_anna', refresh_token_expires_in: 15897600 })
        : reply({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
    }
    if (method === 'DELETE' && url.pathname === '/applications/cid/token') {
      state.revoked++
      return reply(null, 204)
    }
    if (url.pathname === '/user') return reply({ login: 'anna', name: 'Anna Beispiel', avatar_url: 'https://avatars.example/anna' })
    if (url.pathname === '/repos/verein/archiv-data') return reply({ permissions: options.permissions ?? { push: true } })

    let m: RegExpExecArray | null
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) return m[1] in state.refs ? reply({ object: { sha: state.refs[m[1]] } }) : reply({ message: 'Not Found' }, 404)
    if (path === '/git/refs' && method === 'POST') {
      state.refs[body.ref.replace('refs/heads/', '')] = body.sha
      return reply({}, 201)
    }
    if ((m = /^\/git\/commits\/(.+)$/.exec(path))) return reply({ tree: { sha: state.commits[m[1]].tree } })
    if (path === '/git/trees') {
      const sha = `t${state.next++}`
      state.trees[sha] = { base: body.base_tree, entries: body.tree }
      return reply({ sha }, 201)
    }
    if (path === '/git/commits') {
      const sha = `c${state.next++}`
      state.commits[sha] = { tree: body.tree, parents: body.parents, message: body.message }
      return reply({ sha }, 201)
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(path)) && method === 'PATCH') {
      if (state.patchFailures > 0) {
        state.patchFailures--
        return reply({ message: 'Update is not a fast forward' }, 422)
      }
      state.refs[m[1]] = body.sha
      return reply({})
    }
    if (path === '/pulls' && method === 'GET') {
      const head = url.searchParams.get('head')?.split(':')[1]
      return reply(state.pulls.filter((p) => p.state === 'open' && p.head === head).map((p) => ({ number: p.number, html_url: `https://github.com/verein/archiv-data/pull/${p.number}` })))
    }
    if (path === '/pulls' && method === 'POST') {
      if (options.emptyPull) return reply({ message: 'Validation Failed' }, 422)
      const pull = { number: state.next++, head: body.head, state: 'open' as const, merged: false }
      state.pulls.push(pull)
      return reply({ number: pull.number, html_url: `https://github.com/verein/archiv-data/pull/${pull.number}` }, 201)
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(path))) {
      const pull = state.pulls.find((p) => p.number === Number(m![1]))
      return pull ? reply({ number: pull.number, html_url: `https://github.com/verein/archiv-data/pull/${pull.number}`, state: pull.state, merged: pull.merged }) : reply({ message: 'Not Found' }, 404)
    }
    return reply({ message: `unexpected ${method} ${input}` }, 500)
  })
  return { fn: fn as unknown as typeof fetch, state, mock: fn }
}
