// Finds where an issue belongs in the YAML text, so that an editor can mark it.
// An issue only has a path like "/files/0/role"; the editor needs character offsets.

import { isMap, isSeq, parseDocument } from 'yaml'

export interface Span {
  from: number
  to: number
}

/**
 * Walks the YAML along the path and returns the span of the last part that exists.
 * A field that is missing cannot be marked itself, so its parent is marked.
 * Long values (a whole list, say) are cut to their first line.
 */
export function locate(text: string, path: string): Span {
  const doc = parseDocument(text)
  const keys = path.split('/').slice(1).filter((k) => k !== '')
  let node: unknown = doc.contents
  let span: Span = { from: 0, to: Infinity } // the root: the first line

  for (const key of keys) {
    let next: unknown
    let found: Span | undefined

    if (isMap(node)) {
      const pair = node.items.find((p) => String((p.key as { value?: unknown }).value) === key)
      const k = pair?.key as { range?: number[] | null } | undefined
      const v = pair?.value as { range?: number[] | null } | null | undefined
      if (k?.range) {
        found = { from: k.range[0], to: v?.range ? v.range[1] : k.range[1] }
        next = v
      }
    } else if (isSeq(node)) {
      const item = node.items[Number(key)] as { range?: number[] | null } | undefined
      if (item?.range) {
        found = { from: item.range[0], to: item.range[1] }
        next = item
      }
    }

    if (!found) break
    span = found
    node = next
  }

  const lineEnd = text.indexOf('\n', span.from)
  const end = lineEnd === -1 ? text.length : lineEnd
  return { from: span.from, to: Math.max(span.from, Math.min(span.to, end)) }
}
