// The GitHub webhook of the data repository: GitHub calls it when something was pushed. A push to the base
// branch (a merged pull request) is passed on to the hub, which tells every open browser that the archive
// changed. Everything else is ignored. The call is signed with the webhook's secret (HMAC), which is the only
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
  if (event !== 'push') return reply(202, 'Ignored.')

  let push: { ref?: unknown; after?: unknown; repository?: { full_name?: unknown } }
  try {
    push = JSON.parse(body)
  } catch {
    return reply(400, 'Not JSON.')
  }
  const ref = `refs/heads/${env.BASE_BRANCH ?? 'main'}`
  if (push.repository?.full_name !== env.DATA_REPO || push.ref !== ref || typeof push.after !== 'string') return reply(202, 'Ignored.')

  await hubOf(env.HUB).fetch(new Request('http://hub/notify', { method: 'POST', body: JSON.stringify({ type: 'push', ref: push.ref, head: push.after }) }))
  return reply(204, '')
}
