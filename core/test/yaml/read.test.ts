import { describe, expect, it } from 'vitest'
import { readField, readValue, stripFiles } from '../../src/yaml/read.js'

describe('readField', () => {
  it('reads a text field', () => expect(readField('title: Hallo\n', 'title')).toBe('Hallo'))
  it('gives undefined for a missing or empty field', () => {
    expect(readField('type: image\n', 'title')).toBeUndefined()
    expect(readField('title:\n', 'title')).toBeUndefined()
  })
  it('gives undefined for a value that is not text', () => expect(readField('title: 1963\n', 'title')).toBeUndefined())
  it('survives broken YAML', () => expect(readField('title: [x', 'title')).toBeUndefined())
})

describe('stripFiles', () => {
  it('removes the files and keeps the rest', () => {
    const text = 'id: A\ntitle: T # note\nfiles:\n  - role: main\n    sha256: abc\nnotes: X\n'
    expect(stripFiles(text)).toBe('id: A\ntitle: T # note\nnotes: X\n')
  })
  it('leaves broken YAML as it is', () => expect(stripFiles('title: [x')).toBe('title: [x'))
})

describe('readValue', () => {
  it('reads text, lists and objects as plain data', () => {
    const text = 'title: A\nsubjects:\n  - name: B\norigin:\n  name: C\n'
    expect(readValue(text, 'title')).toBe('A')
    expect(readValue(text, 'subjects')).toEqual([{ name: 'B' }])
    expect(readValue(text, 'origin')).toEqual({ name: 'C' })
  })
  it('gives undefined for a missing field or broken YAML', () => {
    expect(readValue('title: A\n', 'origin')).toBeUndefined()
    expect(readValue('title: [x', 'title')).toBeUndefined()
  })
})
