import { describe, expect, it } from 'vitest'
import { mergeObject } from '../../src/yaml/merge.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const base = `id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: document
title: Brief
note: alt
files:
  - role: page
    num: 1
    sha256: ${A}
`

describe('mergeObject', () => {
  it('takes what only the other side changed, and keeps what only I changed', () => {
    const mine = base.replace('title: Brief', 'title: Brief an Anna')
    const theirs = base.replace('note: alt', 'note: neu')
    const merged = mergeObject(base, mine, theirs)
    expect(merged.conflicts).toEqual([])
    expect(merged.text).toContain('title: Brief an Anna')
    expect(merged.text).toContain('note: neu')
    expect(merged.taken).toEqual(['note'])
  })

  it('leaves the text alone when there is nothing to take', () => {
    const mine = base.replace('title: Brief', 'title: X')
    expect(mergeObject(base, mine, base)).toEqual({ text: mine, conflicts: [], taken: [] })
  })

  it('is no conflict when both changed a field to the same', () => {
    const both = base.replace('note: alt', 'note: gleich')
    expect(mergeObject(base, both, both).conflicts).toEqual([])
  })

  it('reports a field that both changed differently, and keeps mine', () => {
    const mine = base.replace('title: Brief', 'title: Meins')
    const theirs = base.replace('title: Brief', 'title: Ihrs')
    const merged = mergeObject(base, mine, theirs)
    expect(merged.text).toBe(mine)
    expect(merged.conflicts).toEqual([{ field: 'title', mine: 'Meins', theirs: 'Ihrs' }])
  })

  it('takes a field the other side added or removed', () => {
    const added = mergeObject(base, base, base.replace('note: alt\n', 'note: alt\nlanguage: de\n'))
    expect(added.text).toContain('language: de')
    const removed = mergeObject(base, base, base.replace('note: alt\n', ''))
    expect(removed.text).not.toContain('note:')
  })

  it('puts the files of both sides together', () => {
    const mine = `${base}  - role: page\n    num: 2\n    sha256: ${B}\n`
    const theirs = `${base}  - role: page\n    num: 2\n    sha256: ${C}\n`
    const merged = mergeObject(base, mine, theirs)
    expect(merged.conflicts).toEqual([])
    expect(merged.text.match(/sha256: (\w+)/g)).toEqual([`sha256: ${A}`, `sha256: ${B}`, `sha256: ${C}`])
    expect(merged.text).toMatch(/num: 3/)
  })

  it('keeps a file out that the other side took out', () => {
    const theirs = base.replace(/files:[\s\S]*/, 'files: []\n')
    const merged = mergeObject(base, base.replace('title: Brief', 'title: X'), theirs)
    expect(merged.text).not.toContain(A)
    expect(merged.text).toContain('title: X')
  })

  it('does not merge a text that cannot be read', () => {
    const broken = 'title: [unclosed\n'
    expect(mergeObject(base, broken, base.replace('note: alt', 'note: neu'))).toEqual({ text: broken, conflicts: [], taken: [] })
  })
})
