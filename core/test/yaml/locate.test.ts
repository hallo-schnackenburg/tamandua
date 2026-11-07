import { describe, expect, it } from 'vitest'
import { locate } from '../../src/yaml/locate.js'

const text = `id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: image
date: 1963
files:
  - role: main
    path: x
`

const cut = (path: string): string => {
  const { from, to } = locate(text, path)
  return text.slice(from, to)
}

describe('locate', () => {
  it('finds a top-level field, key and value', () => {
    expect(cut('/date')).toBe('date: 1963')
  })

  it('finds a field inside a list item', () => {
    expect(cut('/files/0/role')).toBe('role: main')
  })

  it('cuts long values to their first line', () => {
    expect(cut('/files')).toBe('files:')
  })

  it('marks the parent when the path does not exist', () => {
    expect(cut('/files/0/seq')).toBe(cut('/files/0'))
    expect(cut('/files/0')).toBe('role: main')
  })

  it('marks the first line for the root and for broken input', () => {
    expect(cut('/')).toBe('id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D')
    expect(locate('', '/')).toEqual({ from: 0, to: 0 })
    expect(locate('title: [unclosed', '/').from).toBe(0)
  })
})
