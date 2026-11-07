// The Worker. For now it has one route, POST /chat: it passes a chat message to the
// model and returns tool calls. It holds the Anthropic key, so the key never reaches
// the browser.
//
// NOT YET THERE (needed before this is deployed for others): checking who is asking
// (GitHub), a limit per person, and a spending cap. Until then it only runs locally.

import { resolveGeocodes, type GeocodeEnv } from './geocode.js'
import { BadRequest, buildModelRequest, parseChatRequest, toToolCalls } from './chat.js'

export interface Env extends GeocodeEnv {
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
  const { pathname } = new URL(request.url)

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

  if (request.method !== 'POST' || pathname !== '/chat') return json({ error: 'Not found.' }, 404, env)
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'The server has no Anthropic key (worker/.dev.vars).' }, 500, env)

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

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
}
