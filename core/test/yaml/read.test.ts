import { describe, expect, it } from 'vitest'
import { readField, stripFiles } from '../../src/yaml/read.js'

describe('readField', () => {
  it('reads a text field', () => expect(readField('title: Hallo\n', 'title')).toBe('Hallo'))
  it('gives undefined for a missing or empty field', () => {
    expect(readField('type: photo\n', 'title')).toBeUndefined()
    expect(readField('title:\n', 'title')).toBeUndefined()
  })
  it('gives undefined for a value that is not text', () => expect(readField('title: 1963\n', 'title')).toBeUndefined())
  it('survives broken YAML', () => expect(readField('title: [x', 'title')).toBeUndefined())
})

describe('stripFiles', () => {
  it('removes the files and keeps the rest', () => {
    const text = 'id: A\ntitle: T # note\nfiles:\n  - role: main\n    sha256: abc\nauthor: X\n'
    expect(stripFiles(text)).toBe('id: A\ntitle: T # note\nauthor: X\n')
  })
  it('leaves broken YAML as it is', () => expect(stripFiles('title: [x')).toBe('title: [x'))
})
