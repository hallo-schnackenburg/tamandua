// Brings together two changed versions of one object that started from the same text (a three-way merge by
// field). What only one side changed is taken; what both changed to the same is kept; a field that both changed
// differently is a conflict (the text keeps "mine", the conflict says what the other side had). The files are
// the exception: both sides' lists are put together, and a file that either side took out stays out.

import { isMap, parseDocument } from 'yaml'

export interface Conflict {
  field: string
  mine: unknown
  theirs: unknown
}

export interface Merged {
  text: string
  conflicts: Conflict[]
  /** The fields that were taken from the other side (or put together), for a note to the person. */
  taken: string[]
}

type Entry = Record<string, unknown>
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const shaOf = (entry: unknown): string | undefined => (typeof (entry as Entry | null)?.sha256 === 'string' ? ((entry as Entry).sha256 as string) : undefined)
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** The files of both sides: mine in my order, then theirs that are new; what either side took out is gone; pages are numbered anew. */
function mergeFiles(base: unknown, mine: unknown, theirs: unknown): unknown[] {
  const known = (list: unknown[]) => new Set(list.map(shaOf).filter((s): s is string => !!s))
  const was = known(listOf(base))
  const mineNow = known(listOf(mine))
  const theirsNow = known(listOf(theirs))
  const gone = (sha: string) => was.has(sha) && (!mineNow.has(sha) || !theirsNow.has(sha))
  const result: unknown[] = []
  const seen = new Set<string>()
  for (const entry of [...listOf(mine), ...listOf(theirs)]) {
    const sha = shaOf(entry)
    if (sha) {
      if (seen.has(sha) || gone(sha)) continue
      seen.add(sha)
    }
    result.push(entry)
  }
  const pages = result.filter((e): e is Entry => typeof (e as Entry | null)?.num === 'number')
  pages.sort((a, b) => Number(a.num) - Number(b.num)).forEach((page, i) => (page.num = i + 1))
  return result
}

/**
 * `base` is what both started from, `mine` what is here now, `theirs` what the other side made of it. A text that
 * cannot be read (half typed) is not merged: it stays as it is.
 */
export function mergeObject(base: string, mine: string, theirs: string): Merged {
  const docs = [base, mine, theirs].map((text) => parseDocument(text))
  if (docs.some((d) => d.errors.length > 0 || !isMap(d.contents))) return { text: mine, conflicts: [], taken: [] }
  const [b, m, t] = docs.map((d) => d.toJS() as Record<string, unknown>)
  const doc = docs[1]
  const conflicts: Conflict[] = []
  const taken: string[] = []

  const set = (field: string, value: unknown) => {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0 && field !== 'files')) doc.delete(field)
    else if (doc.has(field)) doc.set(field, doc.createNode(value))
    else {
      // New fields go before the files, as when they are typed in.
      const map = doc.contents as import('yaml').YAMLMap
      const at = map.items.findIndex((pair) => String((pair.key as { value?: unknown }).value) === 'files')
      map.items.splice(at === -1 ? map.items.length : at, 0, doc.createPair(field, value) as (typeof map.items)[number])
    }
  }

  for (const field of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
    if (same(m[field], t[field]) || same(t[field], b[field])) continue
    if (field === 'files') {
      const files = mergeFiles(b.files, m.files, t.files)
      if (!same(files, m.files)) {
        set('files', files)
        taken.push(field)
      }
    } else if (same(m[field], b[field])) {
      set(field, t[field])
      taken.push(field)
    } else if (field !== 'id') conflicts.push({ field, mine: m[field], theirs: t[field] })
  }
  return { text: taken.length > 0 ? doc.toString() : mine, conflicts, taken }
}
