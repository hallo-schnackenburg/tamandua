// Changes to the YAML text that keep everything else as it is (comments, order,
// the user's own formatting). The browser and, later, the agent change the text
// through functions like these instead of rewriting it.

import { Scalar, isMap, isSeq, parseDocument, type YAMLMap } from 'yaml'

export type FileEntry = Record<string, unknown>

/**
 * Adds a file to `files`. An image has exactly one file (role "main"); a document
 * takes pages (role "page") with the next free `num`. Throws an Error with a
 * message for the user if the file cannot be added.
 */
export function addFile(text: string, entry: FileEntry): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error('The YAML has a syntax error; fix it first.')
  }
  const type = doc.get('type')
  if (type !== 'image' && type !== 'document') {
    throw new Error('Set the type (image or document) before adding files.')
  }

  const existing = doc.get('files')
  const items: unknown[] = isSeq(existing) ? (existing.toJSON() as unknown[]) : []
  if (items.some((f) => (f as FileEntry)?.sha256 === entry.sha256)) {
    throw new Error('This file is already part of the object.')
  }

  let full: FileEntry
  if (type === 'image') {
    if (items.length > 0) throw new Error('An image has exactly one file.')
    full = { role: 'main', ...entry }
  } else {
    const nums = items.map((f) => Number((f as FileEntry)?.num)).filter(Number.isFinite)
    full = { role: 'page', num: Math.max(0, ...nums) + 1, ...entry }
  }

  // An empty list (`files: []`, left when the last file was taken out) is replaced, not extended: it is written in
  // flow style and the new files would inherit that.
  if (isSeq(existing) && existing.items.length > 0) existing.add(doc.createNode(full))
  else doc.set('files', doc.createNode([full]))
  return doc.toString()
}

/**
 * Removes the file with this hash from `files` and numbers the remaining pages
 * 1, 2, 3 ... again, so that there is no gap. Returns the new text. What happens to an
 * object that has no file left is up to the caller. Throws an Error if the file is
 * not part of the object.
 */
export function removeFile(text: string, sha256: string): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error('The YAML has a syntax error; fix it first.')
  }
  const files = doc.get('files')
  const at = isSeq(files) ? files.items.findIndex((item) => isMap(item) && item.get('sha256') === sha256) : -1
  if (!isSeq(files) || at === -1) throw new Error('This file is not part of the object.')

  files.items.splice(at, 1)
  const pages = files.items.filter((item): item is YAMLMap => isMap(item) && typeof item.get('num') === 'number')
  pages.sort((a, b) => Number(a.get('num')) - Number(b.get('num'))).forEach((page, i) => page.set('num', i + 1))
  return doc.toString()
}

export type SetFieldResult =
  | { ok: true; text: string }
  /** Not changed, because the field no longer has the value the caller expected. */
  | { ok: false; current: unknown }

/**
 * These cannot be changed with `setField`: they are tied to the files. The type is only locked once the object
 * has files (they depend on it); an object without files, e.g. a new empty one, may still get its type.
 */
const LOCKED = new Set(['id', 'type', 'files'])

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

/**
 * Sets one top-level field, but only if it still has the value the caller saw (`old`).
 * That is how the agent changes fields without overwriting what the user has typed in
 * the meantime: it says "title was empty, make it X"; if the user has written a title
 * by then, the change is skipped and the caller reports it. An empty value removes the
 * field. A new field is placed before `files`; a date is always written in quotes.
 */
export function setField(text: string, field: string, value: unknown, old: unknown): SetFieldResult {
  const locked = () => new Error(`The field "${field}" cannot be changed this way.`)
  if (LOCKED.has(field) && field !== 'type') throw locked()
  const doc = parseDocument(text)
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error('The YAML has a syntax error; fix it first.')
  }
  if (field === 'type') {
    const files = doc.get('files')
    if (isSeq(files) && files.items.length > 0) throw locked()
  }

  const current = (doc.toJS() as Record<string, unknown>)[field]
  const unchanged = (isEmpty(current) && isEmpty(old)) || JSON.stringify(current) === JSON.stringify(old)
  if (!unchanged) return { ok: false, current }

  if (isEmpty(value)) {
    doc.delete(field)
    return { ok: true, text: doc.toString() }
  }

  let node: unknown = value
  if (field === 'date' && typeof value === 'string') {
    const quoted = new Scalar(value)
    quoted.type = 'QUOTE_DOUBLE'
    node = quoted
  }
  if (doc.has(field)) {
    doc.set(field, node)
  } else {
    const items = doc.contents.items
    const at = items.findIndex((pair) => String((pair.key as { value?: unknown }).value) === 'files')
    items.splice(at === -1 ? items.length : at, 0, doc.createPair(field, node) as (typeof items)[number])
  }
  return { ok: true, text: doc.toString() }
}
