import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { addFile, setField } from '../../src/yaml/patch.js'
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

describe('setField', () => {
  const text = `# note
id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: document
subtype: letter
title:   # to do
files:
  - role: page
    seq: 1
`
  const ok = (r: ReturnType<typeof setField>): string => {
    if (!r.ok) throw new Error('expected ok')
    return r.text
  }

  it('fills an empty field and keeps the comments', () => {
    const out = ok(setField(text, 'title', 'Brief an die Schwester', undefined))
    expect(parse(out).title).toBe('Brief an die Schwester')
    expect(out).toContain('# note')
  })

  it('places a new field before files', () => {
    const out = ok(setField(text, 'author', 'Volker H.', undefined))
    expect(out.indexOf('author:')).toBeLessThan(out.indexOf('files:'))
    expect(parse(out).author).toBe('Volker H.')
  })

  it('always writes a date in quotes', () => {
    const out = ok(setField(text, 'date', '1965-01-03', undefined))
    expect(out).toContain('date: "1965-01-03"')
    expect(parse(ok(setField(text, 'date', '1965', undefined))).date).toBe('1965')
    expect(ok(setField(text, 'date', '1965', undefined))).toContain('date: "1965"')
  })

  it('skips the change when the user has changed the field in the meantime', () => {
    const edited = ok(setField(text, 'title', 'Von Hand', undefined))
    expect(setField(edited, 'title', 'Vom Agenten', undefined)).toEqual({ ok: false, current: 'Von Hand' })
  })

  it('changes a field whose old value matches', () => {
    const edited = ok(setField(text, 'title', 'Alt', undefined))
    expect(parse(ok(setField(edited, 'title', 'Neu', 'Alt'))).title).toBe('Neu')
  })

  it('treats empty, null and missing as the same', () => {
    expect(setField(text, 'title', 'X', '').ok).toBe(true)
    expect(setField(text, 'title', 'X', null).ok).toBe(true)
  })

  it('removes a field when the new value is empty', () => {
    const edited = ok(setField(text, 'title', 'Alt', undefined))
    expect(parse(ok(setField(edited, 'title', '', 'Alt'))).title).toBeUndefined()
  })

  it('takes lists', () => {
    expect(parse(ok(setField(text, 'people', ['A', 'B'], undefined))).people).toEqual(['A', 'B'])
  })

  it('does not touch id, type and files', () => {
    for (const field of ['id', 'type', 'files']) expect(() => setField(text, field, 'x', undefined)).toThrow(/cannot be changed/)
  })

  it('refuses broken YAML', () => {
    expect(() => setField('title: [x', 'title', 'y', undefined)).toThrow(/syntax error/)
  })
})
