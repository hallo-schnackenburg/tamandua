import { describe, expect, it, vi } from 'vitest'
import { handle, type Env } from '../src/index.js'
import { MAX_FILE_BYTES } from '../src/upload.js'
import { authEnv, cookieOf } from './support.js'

const sha = '9f2c' + '0'.repeat(60)
const original = `files/9f/2c/${sha}/original.tif`
const preview = `files/9f/2c/${sha}/preview-400.abcdef012345.jpg`
const cookie = await cookieOf()
const env: Env = {
  ...authEnv,
  ALLOWED_ORIGIN: 'http://localhost:5173',
  S3_ENDPOINT: 'https://nbg1.your-objectstorage.com',
  S3_BUCKET: 'archive',
  S3_ACCESS_KEY_ID: 'KEY',
  S3_SECRET_ACCESS_KEY: 'SECRET',
}
const post = (data: unknown) => new Request('http://worker/upload', { method: 'POST', headers: { cookie }, body: typeof data === 'string' ? data : JSON.stringify(data) })
const asFetch = (fn: unknown) => fn as typeof fetch
const item = { path: original, mime: 'image/tiff', bytes: 1000 }

/** A bucket that has the given paths (with the given sizes). */
const bucket = (have: Record<string, number> = {}) =>
  vi.fn(async (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname.slice(1))
    return path in have ? new Response(null, { status: 200, headers: { 'content-length': String(have[path]) } }) : new Response(null, { status: 404 })
  })

describe('POST /upload', () => {
  it('signs an upload for a file that is not in the bucket yet', async () => {
    const response = await handle(post({ files: [item] }), env, asFetch(bucket()))
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    const { files } = (await response.json()) as { files: { path: string; exists: boolean; url?: string; headers?: Record<string, string> }[] }
    expect(files).toHaveLength(1)
    expect(files[0].exists).toBe(false)
    expect(files[0].headers).toEqual({ 'content-type': 'image/tiff' })
    const url = new URL(files[0].url!)
    expect(url.origin).toBe('https://archive.nbg1.your-objectstorage.com')
    expect(url.pathname).toBe('/' + original)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('KEY/')
    expect(JSON.stringify(files)).not.toContain('SECRET')
  })

  it('does not sign what is there already', async () => {
    const response = await handle(post({ files: [item, { path: preview, mime: 'image/jpeg', bytes: 50 }] }), env, asFetch(bucket({ [original]: 1000 })))
    const { files } = (await response.json()) as { files: { exists: boolean }[] }
    expect(files.map((f) => f.exists)).toEqual([true, false])
  })

  it('uploads again when the stored file has another size', async () => {
    const response = await handle(post({ files: [item] }), env, asFetch(bucket({ [original]: 999 })))
    expect(((await response.json()) as { files: { exists: boolean }[] }).files[0].exists).toBe(false)
  })

  it('refuses paths, types and sizes it should not sign', async () => {
    const fake = bucket()
    const bad = [
      { files: [] },
      { files: [{ ...item, path: 'files/../secret' }] },
      { files: [{ ...item, path: `files/aa/2c/${sha}/original.tif` }] },
      { files: [{ ...item, mime: 'TEXT' }] },
      { files: [{ ...item, bytes: 0 }] },
      { files: [{ ...item, bytes: MAX_FILE_BYTES + 1 }] },
      { files: Array(9).fill(item) },
      'not json',
    ]
    for (const body of bad) expect((await handle(post(body), env, asFetch(fake))).status).toBe(400)
    expect(fake).not.toHaveBeenCalled()
  })

  it('says so when the storage is not set up or not reachable', async () => {
    expect((await handle(post({ files: [item] }), { ...authEnv, ALLOWED_ORIGIN: env.ALLOWED_ORIGIN }, asFetch(bucket()))).status).toBe(500)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const down = vi.fn(async () => new Response(null, { status: 503 }))
    expect((await handle(post({ files: [item] }), env, asFetch(down))).status).toBe(502)
  })
})
