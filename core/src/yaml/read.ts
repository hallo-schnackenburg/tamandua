import { parseDocument } from 'yaml'

/** Reads one top-level text field from the YAML, e.g. the title. Undefined if it is missing or not text. */
export function readField(text: string, key: string): string | undefined {
  const value = parseDocument(text).get(key)
  return typeof value === 'string' ? value : undefined
}
