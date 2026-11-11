// Where files live in the object store.
//
//   files/<sha[0,2]>/<sha[2,2]>/<sha>/original.<ext>
//   files/<sha[0,2]>/<sha[2,2]>/<sha>/<name>.<hash12>.<ext>     (variants)
//
// <sha> is the SHA-256 of the original. A variant lives in the directory of the
// file it was made from. Its own name carries the first 12 hex characters of its
// own hash, so equal content gives an equal name and changed content a new one.

const SHA256 = /^[0-9a-f]{64}$/
const EXT = /^[a-z0-9]+$/
const NAME = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/

export function assertSha256(sha256: string): void {
  if (!SHA256.test(sha256)) {
    throw new Error(`not a sha256 (64 lowercase hex characters): ${sha256}`)
  }
}

function normalizeExt(ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase()
  if (!EXT.test(clean)) throw new Error(`invalid file extension: ${ext}`)
  return clean
}

/** Directory holding an original and all of its variants. */
export function fileDir(sha256: string): string {
  assertSha256(sha256)
  return `files/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`
}

export function originalPath(sha256: string, ext: string): string {
  return `${fileDir(sha256)}/original.${normalizeExt(ext)}`
}

export interface VariantRef {
  /** E.g. "preview-400", "web-1600", "ocr_text". */
  name: string
  /** SHA-256 of the variant itself. */
  sha256: string
  ext: string
}

export function variantPath(originalSha256: string, variant: VariantRef): string {
  assertSha256(variant.sha256)
  if (!NAME.test(variant.name)) throw new Error(`invalid variant name: ${variant.name}`)
  const hash12 = variant.sha256.slice(0, 12)
  return `${fileDir(originalSha256)}/${variant.name}.${hash12}.${normalizeExt(variant.ext)}`
}

const FILE_PATH = /^files\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\/([a-z0-9_.-]+)$/
const ORIGINAL_NAME = /^original\.[a-z0-9]+$/
const VARIANT_NAME = /^[a-z0-9_]+(?:-[a-z0-9_]+)*\.[0-9a-f]{12}\.[a-z0-9]+$/

/**
 * Tells whether a path is one this layout produces and whose directories belong to the hash.
 * The Worker uses it to refuse anything else before it signs an upload. Returns null if not.
 */
export function parseFilePath(path: string): { sha256: string; kind: 'original' | 'variant' } | null {
  const match = FILE_PATH.exec(path)
  if (!match) return null
  const [, first, second, sha256, name] = match
  if (first !== sha256.slice(0, 2) || second !== sha256.slice(2, 4)) return null
  if (ORIGINAL_NAME.test(name)) return { sha256, kind: 'original' }
  if (VARIANT_NAME.test(name)) return { sha256, kind: 'variant' }
  return null
}

const OBJECT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** The ULID of an object as the path wants it (26 characters, Crockford base32), or null. */
export function parseObjectId(id: string): string | null {
  return OBJECT_ID.test(id) ? id : null
}

/**
 * Where an object's YAML lives in the data repository: objects/<a>/<b>/<id>.yaml, with <a><b> the last two characters of
 * the id. The first characters of a ULID are its creation time and nearly the same for all objects, the last ones are random
 * (and also change when a generator counts up within a millisecond): an even spread over 32 x 32 folders. GitHub shows
 * at most 1000 entries of a folder, so no folder may have many more than 32 (the files in the last folders are
 * N / 1024: about 20 for 20,000 objects, and 1000 only at a million).
 */
export function objectPath(id: string): string {
  if (!parseObjectId(id)) throw new Error(`not an object id (ULID): ${id}`)
  return `objects/${id[24]}/${id[25]}/${id}.yaml`
}
