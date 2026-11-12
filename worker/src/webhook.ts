// The GitHub webhook of the data repository: GitHub calls it when something happened. What is passed on to the hub,
// which tells every open browser, is the news and not the data: the browsers then ask for what they need.
//   push to the base branch (a merged pull request)       {type: 'push', ref, head}: the archive changed
//   push to a session's branch, a pull request event      {type: 'pull', number?}: a session changed (new commit, submitted, accepted, closed ...)
//   a comment on a pull request                           {type: 'comment', number}
//   a check run or status on a session's branch           {type: 'pull'}: how the checks stand changed
// Everything else is ignored. The call is signed with the webhook's secret (HMAC), which is the only
// thing that proves it comes from GitHub.
//
//   POST /hook/github   (open to everyone, but only a correctly signed call does anything)

import { hubOf, type HubNamespace } from './hub.js'

export interface HookEnv {
  /** The secret entered in the webhook's settings on GitHub. */
  WEBHOOK_SECRET?: string
  DATA_REPO?: string
  BASE_BRANCH?: string
  HUB?: HubNamespace
}

const MAX_BODY = 5_000_000

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** Whether the header "X-Hub-Signature-256" (sha256=<hex>) is the signature of the body made with the secret. */
export async function signedBy(secret: string, body: string, header: string | null): Promise<boolean> {
  const signature = header?.startsWith('sha256=') ? hexBytes(header.slice(7)) : undefined
  if (!signature) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(body)) // compares without giving the time away
}

export async function handleHook(request: Request, route: string, env: HookEnv): Promise<Response | null> {
  if (route !== '/hook/github') return null
  const reply = (status: number, text: string) => new Response(text || null, { status })
  if (request.method !== 'POST') return reply(405, 'POST only.')
  if (!env.WEBHOOK_SECRET || !env.HUB) return reply(503, 'The webhook is not set up (WEBHOOK_SECRET, HUB).')

  const body = await request.text()
  if (body.length > MAX_BODY) return reply(413, 'Too large.')
  if (!(await signedBy(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) return reply(401, 'Bad signature.')

  const event = request.headers.get('x-github-event')
  if (event === 'ping') return reply(200, 'pong')

  let payload: {
    ref?: unknown
    after?: unknown
    number?: unknown
    repository?: { full_name?: unknown }
    pull_request?: { head?: { ref?: unknown } }
    issue?: { number?: unknown; pull_request?: unknown }
    check_suite?: { head_branch?: unknown }
    check_run?: { check_suite?: { head_branch?: unknown } }
    branches?: { name?: unknown }[]
  }
  try {
    payload = JSON.parse(body)
  } catch {
    return reply(400, 'Not JSON.')
  }
  if (payload.repository?.full_name !== env.DATA_REPO) return reply(202, 'Ignored.')

  const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined)
  let news: object | undefined
  if (event === 'push' && typeof payload.ref === 'string') {
    if (payload.ref === `refs/heads/${env.BASE_BRANCH ?? 'main'}` && typeof payload.after === 'string') news = { type: 'push', ref: payload.ref, head: payload.after }
    else if (payload.ref.startsWith('refs/heads/erfassung/')) news = { type: 'pull' }
  } else if (event === 'pull_request') {
    const ref = payload.pull_request?.head?.ref
    if (typeof ref === 'string' && ref.startsWith('erfassung/')) news = { type: 'pull', number: number(payload.number) }
  } else if (event === 'issue_comment') {
    if (payload.issue?.pull_request) news = { type: 'comment', number: number(payload.issue.number) }
  } else if (event === 'check_run' || event === 'check_suite') {
    const branch = event === 'check_run' ? payload.check_run?.check_suite?.head_branch : payload.check_suite?.head_branch
    if (typeof branch === 'string' && branch.startsWith('erfassung/')) news = { type: 'pull' }
  } else if (event === 'status') {
    if (Array.isArray(payload.branches) && payload.branches.some((b) => typeof b?.name === 'string' && b.name.startsWith('erfassung/'))) news = { type: 'pull' }
  } else if (event === 'pull_request_review_comment') {
    news = { type: 'comment', number: number((payload as { pull_request?: { number?: unknown } }).pull_request?.number) }
  }
  if (!news) return reply(202, 'Ignored.')

  await hubOf(env.HUB).fetch(new Request('http://hub/notify', { method: 'POST', body: JSON.stringify(news) }))
  return reply(204, '')
}
