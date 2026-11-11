// The groups of the archive as a tree for the database tab, and which objects are in which group.
// A group may have several parents (it is then shown under each of them) and may hold groups (their objects count for it, too).

export interface Node {
  id: string
  type?: string
  /** The groups this is in (ids). */
  parents: string[]
}

export interface GroupTree<T extends Node> {
  /** The groups that are in no (existing) group, in the order they were given (and one of each circle of groups). */
  roots: T[]
  /** Group id → the groups in it, in the order they were given. */
  children: Map<string, T[]>
  /** Group id → the ids of the objects in it or in a group below it (groups are not counted, they are in the tree). */
  members: Map<string, Set<string>>
  /** The ids of all groups. */
  groups: Set<string>
  /** How many objects there are (not groups), and how many of them are in no (existing) group. */
  objects: number
  ungrouped: number
}

/** Builds the tree of the groups among `nodes`. A group that names a parent that does not exist is shown at the top, so that it can be found. */
export function buildTree<T extends Node>(nodes: T[]): GroupTree<T> {
  const groups = new Set<string>()
  for (const node of nodes) if (node.type === 'group') groups.add(node.id)

  const roots: T[] = []
  const children = new Map<string, T[]>()
  const above = new Map<string, string[]>() // group id → the groups it is in
  for (const node of nodes) {
    if (node.type !== 'group') continue
    const parents = node.parents.filter((id) => groups.has(id))
    above.set(node.id, parents)
    if (parents.length === 0) roots.push(node)
    for (const parent of parents) {
      const list = children.get(parent)
      if (list) list.push(node)
      else children.set(parent, [node])
    }
  }

  // Groups that lead back to themselves are below no root: the first of such a circle is shown at the top, so that they can be found.
  const reached = new Set<string>()
  const reach = (id: string) => {
    for (let todo = [id]; todo.length > 0; ) {
      const next = todo.pop()!
      if (reached.has(next)) continue
      reached.add(next)
      for (const child of children.get(next) ?? []) todo.push(child.id)
    }
  }
  for (const root of roots) reach(root.id)
  for (const node of nodes) {
    if (node.type !== 'group' || reached.has(node.id)) continue
    roots.push(node)
    reach(node.id)
  }

  const members = new Map<string, Set<string>>()
  let objects = 0
  let ungrouped = 0
  for (const node of nodes) {
    if (node.type === 'group') continue
    objects++
    // Every group above the object, however the groups are nested (and whatever is wrong with them: a group is visited once).
    const seen = new Set<string>()
    const todo = node.parents.filter((id) => groups.has(id))
    for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
      if (seen.has(id)) continue
      seen.add(id)
      todo.push(...(above.get(id) ?? []))
    }
    if (seen.size === 0) ungrouped++
    for (const id of seen) {
      const set = members.get(id)
      if (set) set.add(node.id)
      else members.set(id, new Set([node.id]))
    }
  }
  return { roots, children, members, groups, objects, ungrouped }
}

/** A line of the tree as it is shown. */
export interface Row<T extends Node> {
  /** Unique among the rows (a group that is in several groups is in several rows). */
  key: string
  group: T
  depth: number
  open: boolean
  /** Whether it has groups in it. */
  branch: boolean
}

/** The rows of the tree, depth first, with the children of the groups in `open` only. `open` holds group ids. */
export function rowsOf<T extends Node>(tree: GroupTree<T>, open: ReadonlySet<string>): Row<T>[] {
  const rows: Row<T>[] = []
  const walk = (group: T, depth: number, path: string[]) => {
    const below = tree.children.get(group.id) ?? []
    const isOpen = open.has(group.id)
    rows.push({ key: [...path, group.id].join('/'), group, depth, open: isOpen, branch: below.length > 0 })
    if (!isOpen) return
    for (const child of below) if (!path.includes(child.id) && child.id !== group.id) walk(child, depth + 1, [...path, group.id]) // (a circle is cut)
  }
  for (const root of tree.roots) walk(root, 0, [])
  return rows
}

/** The ids of the groups that have to be open for `id` to be seen: all the groups above it. */
export function ancestors<T extends Node>(nodes: Map<string, T>, id: string): Set<string> {
  const seen = new Set<string>()
  const todo = [...(nodes.get(id)?.parents ?? [])]
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    if (seen.has(next)) continue
    seen.add(next)
    todo.push(...(nodes.get(next)?.parents ?? []))
  }
  return seen
}
