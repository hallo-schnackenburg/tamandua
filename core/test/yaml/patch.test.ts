import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { addFile } from '../../src/yaml/patch.js'
import { validateObjectYaml } from '../../src/yaml/validate.js'
import { file, sha } from '../fixtures.js'

const { role: _role, ...entry } = file('x', 'a')

const base = (type: string, extra = ''): string => `# my note
id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: ${type}
title: Test   # keep me
${extra}`

describe('addFile', () => {
  it('adds the main file to a photo and leaves the rest alone', () => {
    const out = addFile(base('photo'), entry)
    expect(out).toContain('# my note')
    expect(out).toContain('title: Test # keep me')
    expect(parse(out).files).toEqual([{ role: 'main', ...entry }])
  })

  it('gives a valid photo', () => {
    expect(validateObjectYaml(addFile(base('photo'), entry))).toEqual([])
  })

  it('refuses a second file for a photo', () => {
    const once = addFile(base('photo'), entry)
    const { role: _r, ...other } = file('x', 'b')
    expect(() => addFile(once, other)).toThrow(/exactly one file/)
  })

  it('numbers the pages of a document', () => {
    let text = base('document', 'subtype: letter\n')
    for (const c of ['a', 'b', 'c']) {
      const { role: _r, ...e } = file('x', c)
      text = addFile(text, e)
    }
    expect(parse(text).files.map((f: any) => [f.role, f.seq])).toEqual([['page', 1], ['page', 2], ['page', 3]])
    expect(validateObjectYaml(text)).toEqual([])
  })

  it('refuses the same file twice', () => {
    const text = addFile(base('document', 'subtype: letter\n'), entry)
    expect(() => addFile(text, entry)).toThrow(/already part/)
  })

  it('needs a type', () => {
    expect(() => addFile('title: x\n', entry)).toThrow(/Set the type/)
    expect(() => addFile('type: book\n', entry)).toThrow(/Set the type/)
  })

  it('refuses broken YAML', () => {
    expect(() => addFile('type: [photo', entry)).toThrow(/syntax error/)
  })

  it('keeps a hash made only of digits a string', () => {
    const digits = '1'.repeat(64)
    const text = addFile(base('photo'), { ...entry, sha256: digits })
    expect(parse(text).files[0].sha256).toBe(digits)
    expect(sha('a')).toHaveLength(64)
  })
})
