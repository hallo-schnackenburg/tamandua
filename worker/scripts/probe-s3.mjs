// Checks what an environment's bucket supports. Run from worker/:
//   node --experimental-strip-types scripts/probe-s3.mjs [local|staging|production]
// Reads the settings like provision-bucket.mjs (see environment.mjs) and prints only statuses, never
// the keys. It writes and deletes one small object under probe/.

import { createHash } from 'node:crypto'
import { presign } from '../src/s3.ts'
import { loadEnvironment } from './environment.mjs'

const { config, origin } = loadEnvironment(process.argv[2] ?? 'local')

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
