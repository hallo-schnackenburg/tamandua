// Rules about groups that need more than one object, so the JSON Schema cannot express them: every parent exists
// and is a group, and the groups do not lead back to themselves (an album in a collection in that album).
// Only the child names its parents; this follows those names.

import type { Issue } from './types.js'

export interface GroupNode {
  id: string
  type?: unknown
  parents?: unknown
}

/** An issue and the object it belongs to. */
export interface GroupIssue extends Issue {
  id: string
}

const parentsOf = (node: GroupNode): string[] => (Array.isArray(node.parents) ? node.parents.filter((p): p is string => typeof p === 'string') : [])

/** Checks the parents of all objects at once. Objects that are not well-formed are skipped, because the schema reports them. */
export function checkParents(nodes: Iterable<GroupNode>): GroupIssue[] {
  const byId = new Map<string, GroupNode>()
  for (const node of nodes) if (typeof node.id === 'string') byId.set(node.id, node)
  const ids = [...byId.keys()].sort()
  const issues: GroupIssue[] = []

  // The parent must be there and be a group.
  for (const id of ids) {
    parentsOf(byId.get(id)!).forEach((parent, i) => {
      const found = byId.get(parent)
      if (!found) issues.push({ id, path: `/parents/${i}`, message: `unknown group ${parent}` })
      else if (found.type !== 'group') issues.push({ id, path: `/parents/${i}`, message: `${parent} is not a group` })
    })
  }

  // No cycles: walk up from every group; reaching a group that is on the way up again closes one. A group is reported once,
  // at the edge that closes the circle.
  const state = new Map<string, 'on the way' | 'done'>()
  for (const start of ids) {
    if (byId.get(start)!.type !== 'group' || state.has(start)) continue
    const way: { id: string; next: number }[] = [{ id: start, next: 0 }]
    state.set(start, 'on the way')
    while (way.length > 0) {
      const top = way[way.length - 1]
      const parents = parentsOf(byId.get(top.id)!)
      if (top.next >= parents.length) {
        state.set(top.id, 'done')
        way.pop()
        continue
      }
      const index = top.next++
      const parent = parents[index]
      if (byId.get(parent)?.type !== 'group') continue
      const seen = state.get(parent)
      if (seen === 'on the way') {
        const circle = [...way.slice(way.findIndex((w) => w.id === parent)).map((w) => w.id), parent]
        issues.push({ id: top.id, path: `/parents/${parents.indexOf(parent)}`, message: `makes a circle: ${circle.join(' > ')}` })
      } else if (!seen) {
        state.set(parent, 'on the way')
        way.push({ id: parent, next: 0 })
      }
    }
  }

  return issues.sort((a, b) => (a.id === b.id ? a.path.localeCompare(b.path) : a.id.localeCompare(b.id)))
}
