// Changes to the YAML text that keep everything else as it is (comments, order,
// the user's own formatting). The browser and, later, the agent change the text
// through functions like these instead of rewriting it.

import { isMap, isSeq, parseDocument } from 'yaml'

export type FileEntry = Record<string, unknown>

/**
 * Adds a file to `files`. A photo has exactly one file (role "main"); a document
 * takes pages (role "page") with the next free `seq`. Throws an Error with a
 * message for the user if the file cannot be added.
 */
export function addFile(text: string, entry: FileEntry): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error('The YAML has a syntax error; fix it first.')
  }
  const type = doc.get('type')
  if (type !== 'photo' && type !== 'document') {
    throw new Error('Set the type (photo or document) before adding files.')
  }

  const existing = doc.get('files')
  const items: unknown[] = isSeq(existing) ? (existing.toJSON() as unknown[]) : []
  if (items.some((f) => (f as FileEntry)?.sha256 === entry.sha256)) {
    throw new Error('This file is already part of the object.')
  }

  let full: FileEntry
  if (type === 'photo') {
    if (items.length > 0) throw new Error('A photo has exactly one file.')
    full = { role: 'main', ...entry }
  } else {
    const seqs = items.map((f) => Number((f as FileEntry)?.seq)).filter(Number.isFinite)
    full = { role: 'page', seq: Math.max(0, ...seqs) + 1, ...entry }
  }

  if (isSeq(existing)) existing.add(doc.createNode(full))
  else doc.set('files', doc.createNode([full]))
  return doc.toString()
}
