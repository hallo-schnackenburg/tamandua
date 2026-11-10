import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { addFile, removeFile, setField } from '../../src/yaml/patch.js'
import { validateObjectYaml } from '../../src/yaml/validate.js'
import { file, sha } from '../fixtures.js'

const { role: _role, ...entry } = file('x', 'a')

const base = (type: string, extra = ''): string => `# my note
id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: ${type}
title: Test   # keep me
${extra}`

describe('addFile', () => {
  it('adds the main file to an image and leaves the rest alone', () => {
    const out = addFile(base('image'), entry)
    expect(out).toContain('# my note')
    expect(out).toContain('title: Test # keep me')
    expect(parse(out).files).toEqual([{ role: 'main', ...entry }])
  })

  it('gives a valid image', () => {
    expect(validateObjectYaml(addFile(base('image'), entry))).toEqual([])
  })

  it('refuses a second file for an image', () => {
    const once = addFile(base('image'), entry)
    const { role: _r, ...other } = file('x', 'b')
    expect(() => addFile(once, other)).toThrow(/exactly one file/)
  })

  it('numbers the pages of a document', () => {
    let text = base('document', 'subtype: letter\n')
    for (const c of ['a', 'b', 'c']) {
      const { role: _r, ...e } = file('x', c)
      text = addFile(text, e)
    }
    expect(parse(text).files.map((f: any) => [f.role, f.num])).toEqual([['page', 1], ['page', 2], ['page', 3]])
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
    const text = addFile(base('image'), { ...entry, sha256: digits })
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
    num: 1
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
    const out = ok(setField(text, 'recipient', 'Volker H.', undefined))
    expect(out.indexOf('recipient:')).toBeLessThan(out.indexOf('files:'))
    expect(parse(out).recipient).toBe('Volker H.')
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

  it('fills an empty field whatever the old value claims', () => {
    expect(setField(text, 'title', 'X', 'something the model made up').ok).toBe(true)
    const edited = ok(setField(text, 'title', 'Von Hand', undefined))
    expect(setField(edited, 'title', 'X', 'something the model made up')).toEqual({ ok: false, current: 'Von Hand' })
  })

  it('removes a field when the new value is empty', () => {
    const edited = ok(setField(text, 'title', 'Alt', undefined))
    expect(parse(ok(setField(edited, 'title', '', 'Alt'))).title).toBeUndefined()
  })

  it('takes lists', () => {
    expect(parse(ok(setField(text, 'notes', ['A', 'B'], undefined))).notes).toEqual(['A', 'B'])
  })

  it('takes an object and writes it as a block', () => {
    const out = ok(setField(text, 'origin', { name: 'Max Ketterer', type: 'business', location: 'Leipzig' }, undefined))
    expect(parse(out).origin).toEqual({ name: 'Max Ketterer', type: 'business', location: 'Leipzig' })
    expect(out).toContain('origin:\n  name: Max Ketterer')
    expect(out.indexOf('origin:')).toBeLessThan(out.indexOf('files:'))
  })

  it('takes a list of objects and compares them with the old value', () => {
    const one = [{ name: 'Haus', type: 'building' }]
    const edited = ok(setField(text, 'subjects', one, undefined))
    expect(setField(edited, 'subjects', [], undefined)).toEqual({ ok: false, current: one })
    const two = [...one, { name: 'Konditorei', type: 'business' }]
    expect(parse(ok(setField(edited, 'subjects', two, one))).subjects).toEqual(two)
  })

  it('does not touch id, type and files', () => {
    for (const field of ['id', 'type', 'files']) expect(() => setField(text, field, 'x', undefined)).toThrow(/cannot be changed/)
  })

  it('lets the type of an object without files be set, nothing depends on it yet', () => {
    const empty = 'id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D\ntype:\ntitle: x\n'
    expect(parse(ok(setField(empty, 'type', 'image', undefined))).type).toBe('image')
    expect(() => setField(empty, 'id', 'x', undefined)).toThrow(/cannot be changed/)
  })

  it('refuses broken YAML', () => {
    expect(() => setField('title: [x', 'title', 'y', undefined)).toThrow(/syntax error/)
  })
})

describe('removeFile', () => {
  const three = (): string => {
    let text = base('document', 'subtype: letter\n')
    for (const c of ['a', 'b', 'c']) text = addFile(text, { ...entry, sha256: sha(c).replace(/./g, c) })
    return text
  }
  const names = (text: string) => parse(text).files.map((f: any) => [f.sha256[0], f.num])

  it('removes the file and keeps the rest, comments included', () => {
    const out = removeFile(three(), sha('b'))
    expect(names(out)).toEqual([['a', 1], ['c', 2]])
    expect(out).toContain('# my note')
    expect(out).toContain('title: Test # keep me')
  })

  it('numbers the pages without a gap', () => {
    expect(names(removeFile(three(), sha('a')))).toEqual([['b', 1], ['c', 2]])
  })

  it('numbers by the old order, not by the order in the text', () => {
    const swapped = three().replace('num: 1', 'num: 9').replace('num: 2', 'num: 1').replace('num: 9', 'num: 2')
    expect(names(removeFile(swapped, sha('c')))).toEqual([['a', 2], ['b', 1]].map(([s, n]) => [s, n === 2 ? 2 : 1]))
  })

  it('leaves an empty list when the last file goes', () => {
    const one = addFile(base('image'), entry)
    expect(parse(removeFile(one, entry.sha256 as string)).files).toEqual([])
  })

  it('writes the files in block style again when one is added after the last went', () => {
    const emptied = removeFile(addFile(base('image'), entry), entry.sha256 as string)
    expect(emptied).toContain('files: []')
    const { role: _r, ...other } = file('x', 'b')
    const again = addFile(emptied, other)
    expect(again).not.toContain('[')
    expect(again).toContain('files:\n  - role: main')
    expect(parse(again).files).toHaveLength(1)
    expect(validateObjectYaml(again)).toEqual([])
  })

  it('refuses a file that is not part of the object, and broken YAML', () => {
    expect(() => removeFile(three(), sha('z'))).toThrow(/not part of the object/)
    expect(() => removeFile('files: [x', sha('a'))).toThrow(/syntax error/)
  })
})
