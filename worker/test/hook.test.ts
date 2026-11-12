import { describe, expect, it } from 'vitest'
import { handle, type Env } from '../src/index.js'
import { Hub } from '../src/hub.js'
import { signedBy } from '../src/webhook.js'
import { authEnv, cookieOf, fakeGitHub } from './support.js'

const SECRET = 'hook-secret'

/** Signs a body the way GitHub does. */
async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return `sha256=${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** A hub that writes down what it is told. */
function fakeHub(answer = () => new Response(null, { status: 204 })) {
  const calls: { url: string; method: string; body: string }[] = []
  return {
    calls,
    namespace: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          calls.push({ url: request.url, method: request.method, body: request.method === 'POST' ? await request.clone().text() : '' })
          return answer()
        },
      }),
    },
  }
}

const push = (over: object = {}) => JSON.stringify({ ref: 'refs/heads/main', after: 'abc123', repository: { full_name: 'verein/archiv-data' }, ...over })
const hook = async (env: Env, body: string, headers: Record<string, string> = {}, signature?: string) =>
  handle(
    new Request('http://worker/api/hook/github', {
      method: 'POST',
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': signature ?? (await sign(body)), ...headers },
      body,
    }),
    env,
    fakeGitHub().fn,
  )

describe('the news about sessions', () => {
  const env = (hub: ReturnType<typeof fakeHub>): Env => ({ ...authEnv, WEBHOOK_SECRET: SECRET, HUB: hub.namespace })
  const send = (event: string, data: object) => hook(env(hubOf), JSON.stringify({ repository: { full_name: 'verein/archiv-data' }, ...data }), { 'x-github-event': event })
  let hubOf: ReturnType<typeof fakeHub>
  const told = () => hubOf.calls.map((c) => JSON.parse(c.body))

  it('passes on a push to the branch of a session', async () => {
    hubOf = fakeHub()
    expect((await send('push', { ref: 'refs/heads/erfassung/anna/x', after: 'abc' })).status).toBe(204)
    expect(told()).toEqual([{ type: 'pull' }])
  })

  it('passes on events of the pull request of a session, with its number', async () => {
    hubOf = fakeHub()
    await send('pull_request', { action: 'closed', number: 7, pull_request: { head: { ref: 'erfassung/anna/x' } } })
    expect(told()).toEqual([{ type: 'pull', number: 7 }])
  })

  it('ignores the pull requests that are no session', async () => {
    hubOf = fakeHub()
    expect((await send('pull_request', { number: 7, pull_request: { head: { ref: 'feature/x' } } })).status).toBe(202)
    expect(hubOf.calls).toEqual([])
  })

  it('passes on comments on a pull request (not on an issue)', async () => {
    hubOf = fakeHub()
    await send('issue_comment', { action: 'created', issue: { number: 7, pull_request: {} } })
    await send('pull_request_review_comment', { action: 'created', pull_request: { number: 8 } })
    expect((await send('issue_comment', { issue: { number: 9 } })).status).toBe(202)
    expect(told()).toEqual([{ type: 'comment', number: 7 }, { type: 'comment', number: 8 }])
  })

  it('passes on how the checks of a session\'s branch stand', async () => {
    hubOf = fakeHub()
    await send('check_run', { action: 'completed', check_run: { check_suite: { head_branch: 'erfassung/anna/x' } } })
    await send('status', { state: 'success', branches: [{ name: 'erfassung/anna/x' }] })
    expect((await send('check_run', { check_run: { check_suite: { head_branch: 'feature/x' } } })).status).toBe(202)
    expect(told()).toEqual([{ type: 'pull' }, { type: 'pull' }])
  })

  it('does not take a number that is none', async () => {
    hubOf = fakeHub()
    await send('pull_request', { number: '7; drop', pull_request: { head: { ref: 'erfassung/anna/x' } } })
    expect(told()).toEqual([{ type: 'pull' }])
  })
})

describe('POST /hook/github', () => {
  it('tells the hub when main moved', async () => {
    const hub = fakeHub()
    const response = await hook({ ...authEnv, WEBHOOK_SECRET: SECRET, HUB: hub.namespace }, push())
    expect(response.status).toBe(204)
    expect(hub.calls).toHaveLength(1)
    expect(hub.calls[0]).toMatchObject({ method: 'POST', url: 'http://hub/notify' })
    expect(JSON.parse(hub.calls[0].body)).toEqual({ type: 'push', ref: 'refs/heads/main', head: 'abc123' })
  })

  it('needs no sign-in (GitHub has none), but a correct signature', async () => {
    const hub = fakeHub()
    const env = { ...authEnv, WEBHOOK_SECRET: SECRET, HUB: hub.namespace }
    expect((await hook(env, push(), {}, await sign(push(), 'other-secret'))).status).toBe(401)
    expect((await hook(env, push(), {}, 'sha256=nothex')).status).toBe(401)
    expect((await hook(env, push(), {}, 'nonsense')).status).toBe(401)
    // a body that was changed after it was signed
    expect((await hook(env, push({ after: 'evil' }), {}, await sign(push()))).status).toBe(401)
    expect(hub.calls).toEqual([])
  })

  it('ignores pushes to other branches and other repositories', async () => {
    const hub = fakeHub()
    const env = { ...authEnv, WEBHOOK_SECRET: SECRET, HUB: hub.namespace }
    expect((await hook(env, push({ ref: 'refs/heads/feature/x' }))).status).toBe(202)
    expect((await hook(env, push({ repository: { full_name: 'someone/else' } }))).status).toBe(202)
    expect((await hook(env, push(), { 'x-github-event': 'issues' })).status).toBe(202)
    expect(hub.calls).toEqual([])
  })

  it('answers GitHub\'s ping, and says so when it is not set up', async () => {
    const hub = fakeHub()
    expect((await hook({ ...authEnv, WEBHOOK_SECRET: SECRET, HUB: hub.namespace }, '{}', { 'x-github-event': 'ping' })).status).toBe(200)
    expect((await hook({ ...authEnv, HUB: hub.namespace }, push())).status).toBe(503)
    expect((await hook({ ...authEnv, WEBHOOK_SECRET: SECRET }, push())).status).toBe(503)
    const get = await handle(new Request('http://worker/hook/github'), { ...authEnv, WEBHOOK_SECRET: SECRET, HUB: hub.namespace }, fakeGitHub().fn)
    expect(get.status).toBe(405)
  })

  it('checks signatures in the form GitHub sends them', async () => {
    expect(await signedBy(SECRET, 'x', await sign('x'))).toBe(true)
    expect(await signedBy(SECRET, 'x', await sign('y'))).toBe(false)
    expect(await signedBy(SECRET, 'x', null)).toBe(false)
  })
})

describe('GET /live', () => {
  const env = (hub = fakeHub()) => ({ ...authEnv, ALLOWED_ORIGIN: 'http://localhost:5173', HUB: hub.namespace }) as Env
  const open = async (e: Env, headers: Record<string, string> = {}, signedIn = true) =>
    handle(
      new Request('http://worker/api/live', { headers: { upgrade: 'websocket', origin: 'http://localhost:5173', ...(signedIn ? { cookie: await cookieOf() } : {}), ...headers } }),
      e,
      fakeGitHub().fn,
    )

  it('passes a signed-in person from our own app on to the hub', async () => {
    const hub = fakeHub(() => new Response('hub', { status: 200 }))
    const response = await open(env(hub))
    expect(await response.text()).toBe('hub')
    expect(hub.calls).toHaveLength(1)
    expect(hub.calls[0].method).toBe('GET')
  })

  it('refuses everybody else', async () => {
    const hub = fakeHub()
    expect((await open(env(hub), {}, false)).status).toBe(401)
    expect((await open(env(hub), { origin: 'https://evil.example' })).status).toBe(403)
    expect((await open(env(hub), { origin: '' })).status).toBe(403)
    expect((await open(env(hub), { upgrade: '' })).status).toBe(426)
    expect((await open({ ...authEnv, ALLOWED_ORIGIN: 'http://localhost:5173' })).status).toBe(503)
    expect(hub.calls).toEqual([])
  })
})

describe('the hub', () => {
  function fakeState(sockets: { send: (text: string) => void }[]) {
    return { acceptWebSocket: () => {}, getWebSockets: () => sockets as unknown as WebSocket[], setWebSocketAutoResponse: (pair: unknown) => void autoResponse.push(pair) }
  }
  const autoResponse: unknown[] = []
  class Pair {
    constructor(
      public request: string,
      public response: string,
    ) {}
  }
  ;(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair = Pair

  it('answers "ping" by itself, so that a quiet connection costs nothing', () => {
    new Hub(fakeState([]))
    expect(autoResponse.at(-1)).toMatchObject({ request: 'ping', response: 'pong' })
  })

  it('sends a message to everybody who is connected, also if one connection is broken', async () => {
    const got: string[] = []
    const hub = new Hub(
      fakeState([
        { send: () => { throw new Error('gone') } },
        { send: (text) => got.push(`a:${text}`) },
        { send: (text) => got.push(`b:${text}`) },
      ]),
    )
    const response = await hub.fetch(new Request('http://hub/notify', { method: 'POST', body: '{"type":"push"}' }))
    expect(response.status).toBe(204)
    expect(got).toEqual(['a:{"type":"push"}', 'b:{"type":"push"}'])
  })

  it('wants a WebSocket for everything else', async () => {
    expect((await new Hub(fakeState([])).fetch(new Request('http://hub/'))).status).toBe(426)
  })
})
