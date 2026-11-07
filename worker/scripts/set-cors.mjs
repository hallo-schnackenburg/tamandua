// Sets the bucket's CORS rules so the browser app may upload directly. Run from worker/:
//   node --experimental-strip-types scripts/set-cors.mjs [origin ...]
// Without arguments it allows http://localhost:5173 (local development). Reads S3_* from .dev.vars
// and prints only statuses. It replaces all existing CORS rules of the bucket.

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
const origins = process.argv.length > 2 ? process.argv.slice(2) : ['http://localhost:5173']

const origin = origins.map((origin) => `<AllowedOrigin>${origin}</AllowedOrigin>`).join('')
const methods = '<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>'
const wrap = (rule) => `<CORSConfiguration><CORSRule>${rule}</CORSRule></CORSConfiguration>`

// Browsers may upload (PUT) and read (GET/HEAD) from these origins. The bucket's S3 implementation
// is picky about the rule, so we try from the fullest rule down to the one Hetzner documents.
const variants = [
  ['with ETag and max age', wrap(`${origin}${methods}<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>`)],
  ['with max age', wrap(`${origin}${methods}<AllowedHeader>*</AllowedHeader><MaxAgeSeconds>3600</MaxAgeSeconds>`)],
  ['as documented', wrap(`<AllowedHeader>*</AllowedHeader>${methods}${origin}`)],
]

let ok = false
for (const [name, xml] of variants) {
  const headers = {
    'content-type': 'application/xml',
    'content-md5': createHash('md5').update(xml).digest('base64'),
  }
  const url = await presign(config, { method: 'PUT', key: '', expires: 300, headers, query: { cors: '' } })
  const res = await fetch(url, { method: 'PUT', headers, body: xml })
  console.log(`${res.ok ? 'ok  ' : 'FAIL'} PutBucketCors ${name} for ${origins.join(', ')} - status ${res.status}`)
  if (res.ok) {
    ok = true
    break
  }
  console.log((await res.text()).replace(/\s+/g, ' ').slice(0, 300))
}
process.exit(ok ? 0 : 1)
