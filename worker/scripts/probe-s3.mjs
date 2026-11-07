// One-off check of what the bucket supports. Run from worker/:
//   node --experimental-strip-types scripts/probe-s3.mjs
// Reads the S3_* values from .dev.vars and prints only statuses, never the keys. It writes and
// deletes one small object under probe/.

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { presign } from '../src/s3.ts'

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
)
const config = {
  endpoint: vars.S3_ENDPOINT,
  bucket: vars.S3_BUCKET,
  accessKeyId: vars.S3_ACCESS_KEY_ID,
  secretAccessKey: vars.S3_SECRET_ACCESS_KEY,
}
for (const [name, value] of Object.entries(config)) if (!value) throw new Error(`${name} is empty in .dev.vars`)

const origin = 'http://localhost:5173'
const key = 'probe/hello.txt'
const body = 'Stadtarchiv probe\n'
const sha = createHash('sha256').update(body).digest('base64')
const results = []
const report = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
}
const sign = (method, headers) => presign(config, { method, key, expires: 300, headers })

// 1. Presigned PUT with a signed content type.
let url = await sign('PUT', { 'content-type': 'text/plain' })
let res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body })
report('presigned PUT', res.ok, `status ${res.status}${res.ok ? '' : ' ' + (await res.text()).slice(0, 200)}`)

// 2. Public read without any signature.
const publicUrl = url.split('?')[0]
res = await fetch(publicUrl)
report('public GET without signature', res.ok && (await res.text()) === body, `status ${res.status}`)

// 3. CORS: does the bucket answer the browser's preflight for a PUT from the app's origin?
res = await fetch(url, {
  method: 'OPTIONS',
  headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
})
const allow = res.headers.get('access-control-allow-origin')
report('CORS preflight for PUT', res.ok && !!allow, `status ${res.status}, allow-origin ${allow ?? 'none'}`)
res = await fetch(publicUrl, { headers: { origin } })
report('CORS header on public GET', !!res.headers.get('access-control-allow-origin'), `allow-origin ${res.headers.get('access-control-allow-origin') ?? 'none'}`)

// 4. Checksum: a wrong x-amz-checksum-sha256 must be refused, the right one accepted.
const checksum = async (value) => {
  const headers = { 'content-type': 'text/plain', 'x-amz-checksum-sha256': value }
  const signed = await sign('PUT', headers)
  return fetch(signed, { method: 'PUT', headers, body })
}
const wrong = await checksum(createHash('sha256').update('something else').digest('base64'))
const right = await checksum(sha)
report('checksum header accepted', right.ok, `status ${right.status}`)
report('wrong checksum refused', !wrong.ok, `status ${wrong.status}`)

// 5. Clean up.
res = await fetch(await sign('DELETE'), { method: 'DELETE' })
report('presigned DELETE', res.ok, `status ${res.status}`)

process.exit(results.every(Boolean) ? 0 : 1)
