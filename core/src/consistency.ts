// Rules the JSON Schema cannot express. The schema checks the shape of an object;
// this checks that the parts agree with each other.
//
//   - a file's path must be derived from its sha256
//   - a variant must live in the directory of its file, and its name must carry
//     the first 12 characters of its own sha256 and start with its kind
//   - "seq" must be unique within an object, and a file may not appear twice
//
// It only looks at what is well-formed and skips the rest, because malformed parts
// are already reported by validateObject.

import { originalPath, variantPath } from './paths.js'
import type { Issue } from './types.js'

const SHA256 = /^[0-9a-f]{64}$/
const ORIGINAL_EXT = /\.([a-z0-9]+)$/
const VARIANT_FILE = /^(?<name>[a-z0-9_]+(?:-[a-z0-9_]+)*)\.[0-9a-f]{12}\.(?<ext>[a-z0-9]+)$/

type Record_ = Record<string, unknown>
const isRecord = (x: unknown): x is Record_ => typeof x === 'object' && x !== null && !Array.isArray(x)
const isSha = (x: unknown): x is string => typeof x === 'string' && SHA256.test(x)

export function checkConsistency(object: unknown): Issue[] {
  const issues: Issue[] = []
  if (!isRecord(object) || !Array.isArray(object.files)) return issues

  const seenSha = new Map<string, number>()
  const seenSeq = new Map<number, number>()

  object.files.forEach((file, i) => {
    if (!isRecord(file)) return
    const at = `/files/${i}`

    if (isSha(file.sha256)) {
      const first = seenSha.get(file.sha256)
      if (first === undefined) seenSha.set(file.sha256, i)
      else issues.push({ path: `${at}/sha256`, message: `same file as /files/${first}` })
    }

    if (typeof file.seq === 'number') {
      const first = seenSeq.get(file.seq)
      if (first === undefined) seenSeq.set(file.seq, i)
      else issues.push({ path: `${at}/seq`, message: `seq ${file.seq} is already used by /files/${first}` })
    }

    if (isSha(file.sha256) && typeof file.path === 'string') {
      const ext = ORIGINAL_EXT.exec(file.path)?.[1]
      if (ext) {
        const expected = originalPath(file.sha256, ext)
        if (file.path !== expected) {
          issues.push({ path: `${at}/path`, message: `path does not match sha256, expected ${expected}` })
        }
      }
    }

    const originalSha = file.sha256
    if (isSha(originalSha) && Array.isArray(file.variants)) {
      file.variants.forEach((variant, j) => {
        if (!isRecord(variant) || !isSha(variant.sha256) || typeof variant.path !== 'string') return
        const vat = `${at}/variants/${j}`
        const base = variant.path.split('/').pop() ?? ''
        const match = VARIANT_FILE.exec(base)
        if (!match?.groups) return
        const { name, ext } = match.groups as { name: string; ext: string }

        const expected = variantPath(originalSha, { name, sha256: variant.sha256, ext })
        if (variant.path !== expected) {
          issues.push({ path: `${vat}/path`, message: `path does not match the file and the variant's sha256, expected ${expected}` })
        }
        if (typeof variant.kind === 'string' && name !== variant.kind && !name.startsWith(`${variant.kind}-`)) {
          issues.push({ path: `${vat}/path`, message: `name "${name}" must be or start with the kind "${variant.kind}"` })
        }
      })
    }
  })

  return issues
}
