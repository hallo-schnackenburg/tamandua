import { describe, expect, it, vi } from 'vitest'
import { handle, type Env } from '../src/index.js'

const env: Env = { ANTHROPIC_API_KEY: 'sk-test', ALLOWED_ORIGIN: 'http://localhost:5173' }
const body = { message: 'Foto', files: [{ name: 'a.jpg' }], objects: [], history: [] }

const post = (data: unknown, path = '/chat') =>
  new Request(`http://worker${path}`, { method: 'POST', body: typeof data === 'string' ? data : JSON.stringify(data) })

const asFetch = (fn: unknown) => fn as typeof fetch
const modelAnswer = (content: unknown[], status = 200) => vi.fn(async () => new Response(JSON.stringify({ content }), { status }))

describe('POST /chat', () => {
  it('asks the model with the key and returns the tool calls', async () => {
    const fake = modelAnswer([{ type: 'tool_use', name: 'create_object', input: { type: 'image' } }])
    const response = await handle(post(body), env, asFetch(fake))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ calls: [{ tool: 'create_object', type: 'image' }] })
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test')
    expect(JSON.parse(init.body as string).model).toBe('claude-haiku-5-5')
  })

  it('uses the model from the settings', async () => {
    const fake = modelAnswer([{ type: 'text', text: 'ok' }])
    await handle(post(body), { ...env, MODEL: 'other-model' }, asFetch(fake))
    expect(JSON.parse((fake.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe('other-model')
  })

  it('does not call the model for a bad request', async () => {
    const fake = modelAnswer([])
    expect((await handle(post('not json'), env, asFetch(fake))).status).toBe(400)
    expect((await handle(post({ message: '' }), env, asFetch(fake))).status).toBe(400)
    expect(fake).not.toHaveBeenCalled()
  })

  it('refuses a request that is far too large', async () => {
    const response = await handle(post({ ...body, message: 'x'.repeat(300_000) }), env, asFetch(modelAnswer([])))
    expect(response.status).toBe(400)
  })

  it('reports an error of the model without leaking details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await handle(post(body), env, asFetch(modelAnswer([], 529)))
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('sk-test')
  })

  it('passes on the reason the model gives', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusal = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad parameter' } }), { status: 400 }))
    const response = await handle(post(body), env, asFetch(refusal))
    expect(((await response.json()) as { error: string }).error).toBe('The model answered with an error (400): bad parameter')
  })

  it('reports that the model is not reachable', async () => {
    const offline = async () => {
      throw new Error('offline')
    }
    expect((await handle(post(body), env, asFetch(offline))).status).toBe(502)
  })

  it('says so when there is no key', async () => {
    const response = await handle(post(body), { ...env, ANTHROPIC_API_KEY: undefined }, asFetch(modelAnswer([])))
    expect(response.status).toBe(500)
  })
})

describe('other requests', () => {
  it('answers the browser preflight', async () => {
    const response = await handle(new Request('http://worker/chat', { method: 'OPTIONS' }), env)
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('content-type')
  })

  it('knows no other route', async () => {
    expect((await handle(post(body, '/other'), env)).status).toBe(404)
    expect((await handle(new Request('http://worker/chat'), env)).status).toBe(404)
  })
})
