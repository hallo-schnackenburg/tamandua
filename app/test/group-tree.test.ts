import { describe, expect, it } from 'vitest'
import { ancestors, buildTree, rowsOf, type Node } from '../src/group-tree.js'

const group = (id: string, ...parents: string[]): Node => ({ id, type: 'group', parents })
const object = (id: string, ...parents: string[]): Node => ({ id, type: 'image', parents })

describe('buildTree', () => {
  const nodes = [group('Sammlung'), group('Album1', 'Sammlung'), group('Album2', 'Sammlung'), object('a', 'Album1'), object('b', 'Album1', 'Album2'), object('c', 'Sammlung'), object('d'), object('e', 'Gibtsnicht')]
  const tree = buildTree(nodes)

  it('has the groups that are in no group as roots, and the others below their parents', () => {
    expect(tree.roots.map((g) => g.id)).toEqual(['Sammlung'])
    expect(tree.children.get('Sammlung')?.map((g) => g.id)).toEqual(['Album1', 'Album2'])
    expect(tree.children.has('Album1')).toBe(false)
  })

  it('counts the objects below a group, too', () => {
    expect([...tree.members.get('Sammlung')!].sort()).toEqual(['a', 'b', 'c'])
    expect([...tree.members.get('Album1')!].sort()).toEqual(['a', 'b'])
    expect([...tree.members.get('Album2')!]).toEqual(['b'])
  })

  it('counts objects, and those that are in no (existing) group', () => {
    expect(tree.objects).toBe(5)
    expect(tree.ungrouped).toBe(2) // d, and e whose group is not there
  })

  it('shows a group that is in several groups under each of them', () => {
    const t = buildTree([group('A'), group('B'), group('C', 'A', 'B')])
    expect(t.children.get('A')?.map((g) => g.id)).toEqual(['C'])
    expect(t.children.get('B')?.map((g) => g.id)).toEqual(['C'])
    expect(rowsOf(t, new Set(['A', 'B'])).map((r) => r.key)).toEqual(['A', 'A/C', 'B', 'B/C'])
  })

  it('puts a group with a missing parent at the top', () => {
    expect(buildTree([group('X', 'Gibtsnicht')]).roots.map((g) => g.id)).toEqual(['X'])
  })

  it('survives a circle', () => {
    const t = buildTree([group('A', 'B'), group('B', 'A'), object('o', 'A')])
    expect([...t.members.get('A')!]).toEqual(['o'])
    expect([...t.members.get('B')!]).toEqual(['o'])
    expect(t.roots.map((g) => g.id)).toEqual(['A']) // a circle has no root: its first group is shown at the top
    expect(rowsOf(t, new Set(['A', 'B'])).map((r) => r.key)).toEqual(['A', 'A/B']) // and nothing hangs
  })
})

describe('rowsOf', () => {
  const tree = buildTree([group('S'), group('A', 'S'), group('B', 'A'), group('T')])

  it('shows the roots, and the children of the open groups', () => {
    expect(rowsOf(tree, new Set()).map((r) => [r.group.id, r.depth, r.branch, r.open])).toEqual([['S', 0, true, false], ['T', 0, false, false]])
    expect(rowsOf(tree, new Set(['S', 'A'])).map((r) => [r.group.id, r.depth])).toEqual([['S', 0], ['A', 1], ['B', 2], ['T', 0]])
  })
})

describe('ancestors', () => {
  it('names all groups above one', () => {
    const map = new Map([group('S'), group('A', 'S'), group('B', 'A'), group('C', 'S', 'B')].map((g) => [g.id, g]))
    expect([...ancestors(map, 'C')].sort()).toEqual(['A', 'B', 'S'])
    expect([...ancestors(map, 'S')]).toEqual([])
  })
})
