// POST /upload: the browser says which files it wants to put into the bucket; the Worker checks that
// the paths are ones the app would produce, finds out which files are already there, and hands out
// signed URLs for the rest. The files themselves go from the browser straight to the bucket.

import { parseFilePath } from '@tamandua/core/paths'
import { BadRequest } from './chat.js'
import { presign, type S3Config } from './s3.js'

export interface UploadEnv {
  S3_ENDPOINT?: string
  S3_BUCKET?: string
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  /** Only if it differs from the first label of S3_ENDPOINT. */
  S3_REGION?: string
}

export interface UploadItem {
  path: string
  mime: string
  bytes: number
}

export type UploadAnswer =
  | { path: string; exists: true }
  | { path: string; exists: false; url: string; headers: Record<string, string> }

/** One signed PUT takes up to 5 GB at Hetzner; scans and photos stay far below this. */
export const MAX_FILE_BYTES = 1024 ** 3
const MAX_ITEMS = 8
/** A scan over a slow line takes a while. */
const URL_LIFETIME = 3 * 3600
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/

export function parseUploadRequest(data: unknown): UploadItem[] {
  const files = (data as { files?: unknown } | null)?.files
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ITEMS) {
    throw new BadRequest(`"files" must list 1 to ${MAX_ITEMS} files.`)
  }
  return files.map((item: Partial<UploadItem> | null) => {
    const { path, mime, bytes } = item ?? {}
    if (typeof path !== 'string' || !parseFilePath(path)) throw new BadRequest('A file path is not valid.')
    if (typeof mime !== 'string' || !MIME.test(mime)) throw new BadRequest('A file type is not valid.')
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES) {
      throw new BadRequest('A file has an invalid or too large size.')
    }
    return { path, mime, bytes }
  })
}

export function s3Config(env: UploadEnv): S3Config | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = env
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null
  return {
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    region: S3_REGION || undefined,
  }
}

/** Is the file in the bucket already, with the size we expect? A path holds one content only (it contains the hash). */
async function isThere(config: S3Config, item: UploadItem, fetchFn: typeof fetch): Promise<boolean> {
  const url = await presign(config, { method: 'HEAD', key: item.path, expires: 60 })
  const response = await fetchFn(url, { method: 'HEAD' })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`The bucket answered ${response.status}.`)
  const length = response.headers.get('content-length')
  return length === null || Number(length) === item.bytes
}

export async function planUpload(items: UploadItem[], config: S3Config, fetchFn: typeof fetch = fetch): Promise<UploadAnswer[]> {
  return Promise.all(
    items.map(async (item): Promise<UploadAnswer> => {
      if (await isThere(config, item, fetchFn)) return { path: item.path, exists: true }
      // The content type is signed: the browser has to send exactly this one.
      const headers = { 'content-type': item.mime }
      const url = await presign(config, { method: 'PUT', key: item.path, expires: URL_LIFETIME, headers })
      return { path: item.path, exists: false, url, headers }
    }),
  )
}
