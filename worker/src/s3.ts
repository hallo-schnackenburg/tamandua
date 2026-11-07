// Presigned URLs for an S3-compatible bucket (Hetzner Object Storage), signed with AWS Signature
// Version 4 in the query string. The browser gets such a URL and uploads straight to the bucket, so
// the file never runs through the Worker and the secret key never reaches the browser.
//
// Only Web Crypto is used (available in Workers, browsers and Node), no S3 library.

export interface S3Config {
  /** e.g. https://nbg1.your-objectstorage.com */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Defaults to the first label of the endpoint host ("nbg1"). */
  region?: string
}

export interface PresignOptions {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD'
  key: string
  /** Seconds the URL stays valid (1..604800). */
  expires: number
  /** Headers the client must send exactly like this (e.g. content-type); they become part of the signature. */
  headers?: Record<string, string>
  /** Sub-resource or extra query parameters, e.g. { cors: '' } for the bucket's CORS rules. */
  query?: Record<string, string>
  now?: Date
}

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === 'string' ? encoder.encode(key) : key
  const imported = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', imported, encoder.encode(data))
}

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
function encode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

export function regionOf(config: S3Config): string {
  return config.region ?? new URL(config.endpoint).hostname.split('.')[0]
}

/** Virtual-hosted style: https://<bucket>.<endpoint host>/<key>. */
export function objectUrl(config: S3Config, key: string): URL {
  const endpoint = new URL(config.endpoint)
  const path = '/' + key.split('/').map(encode).join('/')
  return new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}${path}`)
}

export async function presign(config: S3Config, options: PresignOptions): Promise<string> {
  if (!Number.isInteger(options.expires) || options.expires < 1 || options.expires > 604800) {
    throw new Error('expires must be 1..604800 seconds')
  }
  const url = objectUrl(config, options.key)
  const now = options.now ?? new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') // 20130524T000000Z
  const day = stamp.slice(0, 8)
  const region = regionOf(config)
  const scope = `${day}/${region}/s3/aws4_request`

  const headers: Record<string, string> = { host: url.host }
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value.trim()
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')

  const query: Record<string, string> = {
    ...options.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(options.expires),
    'X-Amz-SignedHeaders': signedHeaders,
  }
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encode(name)}=${encode(query[name])}`)
    .join('&')

  const canonicalRequest = [
    options.method,
    url.pathname,
    canonicalQuery,
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n')
  let signingKey = await hmac('AWS4' + config.secretAccessKey, day)
  for (const part of [region, 's3', 'aws4_request']) signingKey = await hmac(signingKey, part)
  const signature = hex(await hmac(signingKey, toSign))

  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`
}
