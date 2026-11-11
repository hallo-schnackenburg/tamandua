import { describe, expect, it } from 'vitest'
import { checkParents } from '../src/groups.js'

const group = (id: string, ...parents: string[]) => ({ id, type: 'group', parents: parents.length ? parents : undefined })
const image = (id: string, ...parents: string[]) => ({ id, type: 'image', parents: parents.length ? parents : undefined })
const texts = (nodes: Parameters<typeof checkParents>[0]) => checkParents(nodes).map((i) => `${i.id}${i.path}: ${i.message}`)

describe('parents', () => {
  it('are fine in a tree, and in a diamond (one object in several groups, groups in several groups)', () => {
    expect(texts([group('A'), group('B', 'A'), group('C', 'A'), group('D', 'B', 'C'), image('I', 'D', 'A'), image('J')])).toEqual([])
  })

  it('must exist', () => {
    expect(texts([image('I', 'A', 'X'), group('A')])).toEqual(['I/parents/1: unknown group X'])
  })

  it('must be groups', () => {
    expect(texts([image('I', 'J'), image('J')])).toEqual(['I/parents/0: J is not a group'])
  })

  it('must not lead back to themselves: not to the group itself', () => {
    expect(texts([group('A', 'A')])).toEqual(['A/parents/0: makes a circle: A > A'])
  })

  it('and not through others', () => {
    expect(texts([group('A', 'C'), group('B', 'A'), group('C', 'B'), image('I', 'A')])).toEqual(['B/parents/0: makes a circle: A > C > B > A'])
  })

  it('report a circle once, wherever the walk enters it', () => {
    const issues = checkParents([group('A', 'B'), group('B', 'C'), group('C', 'A'), image('I', 'C')])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/^makes a circle: /)
  })

  it('skip what the schema reports', () => {
    expect(texts([{ id: 'A', type: 'group', parents: 'B' }, { id: 'B', type: 'group', parents: [1, null] }])).toEqual([])
  })

  it('cope with a long chain', () => {
    const chain = Array.from({ length: 20000 }, (_, i) => group(`G${i}`, ...(i > 0 ? [`G${i - 1}`] : [])))
    expect(checkParents(chain)).toEqual([])
  })
})
