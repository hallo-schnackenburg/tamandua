// Makes sure an environment's bucket exists and lets the browser app upload to it. Run from worker/:
//   node --experimental-strip-types scripts/provision-bucket.mjs <local|staging|production>
// Safe to run again. The bucket and the app's address come from wrangler.toml (or .secrets/dev for local),
// the keys from .secrets/<environment>; see environment.mjs. It creates the bucket if it is missing
// and replaces all CORS rules of the bucket. It prints only statuses, never the keys.
// The keys themselves (and the Hetzner project they belong to) are made in the Hetzner console.

import { createHash } from 'node:crypto'
import { presign, regionOf } from '../src/s3.ts'
import { loadEnvironment } from './environment.mjs'

let environment
try {
  environment = loadEnvironment(process.argv[2])
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
const { name, config, origin } = environment

const bucketStatus = async () => (await fetch(await presign(config, { method: 'HEAD', key: '', expires: 300 }), { method: 'HEAD' })).status
const short = async (res) => (await res.text()).replace(/\s+/g, ' ').slice(0, 300)

// 1. The bucket.
let status = await bucketStatus()
if (status === 200) {
  console.log(`ok   bucket ${config.bucket} exists (${name})`)
} else if (status === 404) {
  // Some S3 implementations want the location in the body, some refuse it: try without, then with.
  const location = `<CreateBucketConfiguration><LocationConstraint>${regionOf(config)}</LocationConstraint></CreateBucketConfiguration>`
  for (const [label, body] of [['without location', undefined], ['with location', location]]) {
    const res = await fetch(await presign(config, { method: 'PUT', key: '', expires: 300 }), { method: 'PUT', body })
    console.log(`${res.ok ? 'ok  ' : 'FAIL'} CreateBucket ${config.bucket} ${label} - status ${res.status}`)
    if (res.ok) break
    console.log(await short(res))
  }
  status = await bucketStatus()
  if (status !== 200) {
    console.error(`FAIL bucket ${config.bucket} still not there (status ${status}). Create it in the Hetzner console.`)
    process.exit(1)
  }
} else {
  // Bucket names are unique across all of Hetzner, so a 403 can also mean the name belongs to someone else.
  console.error(`FAIL bucket ${config.bucket}: status ${status}. These keys cannot reach it (wrong Hetzner project, or the name is taken).`)
  process.exit(1)
}

// 2. CORS: browsers may upload (PUT) and read (GET/HEAD) from the app's address.
const rule = `<AllowedOrigin>${origin}</AllowedOrigin>`
const methods = '<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>'
const wrap = (inner) => `<CORSConfiguration><CORSRule>${inner}</CORSRule></CORSConfiguration>`

// The bucket's S3 implementation is picky about the rule, so we try from the fullest rule down to the one Hetzner documents.
const variants = [
  ['with ETag and max age', wrap(`${rule}${methods}<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>`)],
  ['with max age', wrap(`${rule}${methods}<AllowedHeader>*</AllowedHeader><MaxAgeSeconds>3600</MaxAgeSeconds>`)],
  ['as documented', wrap(`<AllowedHeader>*</AllowedHeader>${methods}${rule}`)],
]

let ok = false
for (const [label, xml] of variants) {
  const headers = {
    'content-type': 'application/xml',
    'content-md5': createHash('md5').update(xml).digest('base64'),
  }
  const url = await presign(config, { method: 'PUT', key: '', expires: 300, headers, query: { cors: '' } })
  const res = await fetch(url, { method: 'PUT', headers, body: xml })
  console.log(`${res.ok ? 'ok  ' : 'FAIL'} PutBucketCors ${label} for ${origin} - status ${res.status}`)
  if (res.ok) {
    ok = true
    break
  }
  console.log(await short(res))
}
process.exit(ok ? 0 : 1)
