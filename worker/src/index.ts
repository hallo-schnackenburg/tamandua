// The Worker. Routes (an optional /api in front is ignored, so the app can reach it under /api):
//   /auth/*       sign in with GitHub, who am I, sign out (auth.ts). Open to everyone.
//   POST /hook/github  GitHub tells that the archive changed; passed on to everybody who has the app open (webhook.ts).
// and only for a signed-in person who may write to the data repository:
//   POST /chat    passes a chat message to the model and returns tool calls. It holds the
//                 Anthropic key, so the key never reaches the browser.
//   POST /upload  checks which files the browser wants to store and signs upload URLs for the
//                 bucket. It holds the bucket's secret key, which never reaches the browser either.
//   GET  /live    a WebSocket on which the browser hears that the archive changed (hub.ts).
//   /repo/*       saves objects to the data repository and opens the pull request (repo.ts).
//
// NOT YET THERE (needed before this is deployed for others): a limit per person and a spending cap.

import { resolveGeocodes, type GeocodeEnv } from './geocode.js'
import { BadRequest, buildModelRequest, parseChatRequest, toToolCalls } from './chat.js'
import { parseUploadRequest, planUpload, s3Config, type UploadEnv } from './upload.js'
import { handleAuth, readSession, type AuthEnv } from './auth.js'
import { handleRepo } from './repo.js'
import { hubOf, type HubNamespace } from './hub.js'
import { handleHook, type HookEnv } from './webhook.js'
import type { Auth } from './session.js'

export { Hub } from './hub.js'

export interface Env extends GeocodeEnv, UploadEnv, AuthEnv, HookEnv {
  ANTHROPIC_API_KEY?: string
  ALLOWED_ORIGIN?: string
  MODEL?: string
}

const MAX_BODY = 200_000

function json(body: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': env.ALLOWED_ORIGIN ?? '',
      vary: 'origin',
    },
  })
}

/** `fetchFn` is the network; tests pass a fake. */
export async function handle(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
  pause?: (ms: number) => Promise<void>,
): Promise<Response> {
  const route = new URL(request.url).pathname.replace(/^\/api(?=\/)/, '')

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': env.ALLOWED_ORIGIN ?? '',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
    })
  }

  const hook = await handleHook(request, route, env)
  if (hook) return hook

  const auth = await handleAuth(request, route, env, fetchFn)
  if (auth) return auth

  // Everything else is for a signed-in person only. A renewed token goes back to the browser as a new cookie.
  const signed = await readSession(request, env, fetchFn)
  if (!signed) return json({ error: 'Nicht angemeldet.' }, 401, env)
  const response = await signedRoute(request, route, signed.session, env, fetchFn, pause)
  // (The headers of a WebSocket's response cannot be changed; the next request renews the cookie.)
  if (signed.cookie && response.status !== 101) response.headers.append('set-cookie', signed.cookie)
  return response
}

async function signedRoute(
  request: Request,
  route: string,
  session: Auth,
  env: Env,
  fetchFn: typeof fetch,
  pause?: (ms: number) => Promise<void>,
): Promise<Response> {
  if (route === '/live' && request.method === 'GET') return live(request, env)
  const repo = await handleRepo(request, route, session, env, fetchFn)
  if (repo) return repo
  if (request.method === 'POST' && route === '/upload') return upload(request, env, fetchFn)
  if (request.method !== 'POST' || route !== '/chat') return json({ error: 'Not found.' }, 404, env)
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'The server has no Anthropic key (worker/.secrets/dev).' }, 500, env)

  let chat
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY) throw new BadRequest('Request too large.')
    chat = parseChatRequest(JSON.parse(raw))
  } catch (error) {
    const message = error instanceof BadRequest ? error.message : 'Body must be valid JSON.'
    return json({ error: message }, 400, env)
  }

  let answer: Response
  try {
    answer = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(buildModelRequest(chat, env.MODEL ?? 'claude-haiku-5-5')),
    })
  } catch {
    return json({ error: 'The model could not be reached.' }, 502, env)
  }

  if (!answer.ok) {
    // The model's own explanation ("invalid_request_error: ...") helps to find a mistake and holds no secrets.
    const detail = await answer.text().catch(() => '')
    console.error('Anthropic API error', answer.status, detail)
    let reason = ''
    try {
      reason = String(JSON.parse(detail)?.error?.message ?? '').slice(0, 300)
    } catch {
      // not JSON; keep only the status
    }
    return json({ error: `The model answered with an error (${answer.status})${reason ? `: ${reason}` : ''}` }, 502, env)
  }
  const calls = await resolveGeocodes(toToolCalls(await answer.json()), env, fetchFn, pause)
  return json({ calls }, 200, env)
}

/** The WebSocket on which the browser hears that the archive changed (see hub.ts). */
async function live(request: Request, env: Env): Promise<Response> {
  if (!env.HUB) return json({ error: 'The server has no hub (HUB).' }, 503, env)
  if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426, env)
  // A WebSocket is not held back by the browser's cross-origin rules: only our own app may open one.
  if (!env.ALLOWED_ORIGIN || request.headers.get('origin') !== env.ALLOWED_ORIGIN) return json({ error: 'Wrong origin.' }, 403, env)
  return hubOf(env.HUB).fetch(request)
}

async function upload(request: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
  const config = s3Config(env)
  if (!config) return json({ error: 'The server has no storage settings (S3_* in worker/.secrets/dev).' }, 500, env)

  let items
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY) throw new BadRequest('Request too large.')
    items = parseUploadRequest(JSON.parse(raw))
  } catch (error) {
    const message = error instanceof BadRequest ? error.message : 'Body must be valid JSON.'
    return json({ error: message }, 400, env)
  }

  try {
    return json({ files: await planUpload(items, config, fetchFn) }, 200, env)
  } catch (error) {
    console.error('Storage error', (error as Error).message)
    return json({ error: 'The storage could not be reached.' }, 502, env)
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
}
