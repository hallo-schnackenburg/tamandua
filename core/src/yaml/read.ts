import { parseDocument } from 'yaml'

/** Reads one top-level text field from the YAML, e.g. the title. Undefined if it is missing or not text. */
export function readField(text: string, key: string): string | undefined {
  const value = parseDocument(text).get(key)
  return typeof value === 'string' ? value : undefined
}

/** Reads one top-level field of any kind (text, list, object) as plain data. */
export function readValue(text: string, key: string): unknown {
  const doc = parseDocument(text)
  return doc.errors.length > 0 ? undefined : doc.get(key) === undefined ? undefined : (doc.toJS() as Record<string, unknown>)[key]
}

/**
 * The YAML without its `files` list. The hashes and paths in it mean nothing to a
 * reader (or a model) and only cost space; the rest is what a person would describe.
 */
export function stripFiles(text: string): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return text
  doc.delete('files')
  return doc.toString()
}
