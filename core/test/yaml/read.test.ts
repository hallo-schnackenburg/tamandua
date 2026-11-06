import { describe, expect, it } from 'vitest'
import { readField } from '../../src/yaml/read.js'

describe('readField', () => {
  it('reads a text field', () => expect(readField('title: Hallo\n', 'title')).toBe('Hallo'))
  it('gives undefined for a missing or empty field', () => {
    expect(readField('type: photo\n', 'title')).toBeUndefined()
    expect(readField('title:\n', 'title')).toBeUndefined()
  })
  it('gives undefined for a value that is not text', () => expect(readField('title: 1963\n', 'title')).toBeUndefined())
  it('survives broken YAML', () => expect(readField('title: [x', 'title')).toBeUndefined())
})
