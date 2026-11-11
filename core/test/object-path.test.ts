import { describe, expect, it } from 'vitest'
import { objectPath, parseObjectId } from '../src/paths.js'
import { ulid } from '../src/ids.js'

describe('objectPath', () => {
  it('uses the last two characters as two folders', () => {
    expect(objectPath('01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe('objects/Z/0/01JABCDEFGHJKMNPQRSTVWXYZ0.yaml')
  })

  it('spreads objects created at about the same time over all folders, and keeps every folder small', () => {
    const paths = Array.from({ length: 20_000 }, () => objectPath(ulid(1_800_000_000_000)))
    const first = new Set(paths.map((p) => p.split('/')[1]))
    const second = new Map<string, Set<string>>()
    for (const p of paths) {
      const [, a, b] = p.split('/')
      second.set(a, (second.get(a) ?? new Set()).add(b))
    }
    expect(first.size).toBe(32)
    expect([...second.values()].every((set) => set.size <= 32)).toBe(true)
    const perFolder = new Map<string, number>()
    for (const p of paths) perFolder.set(p.slice(0, p.lastIndexOf('/')), (perFolder.get(p.slice(0, p.lastIndexOf('/'))) ?? 0) + 1)
    expect(Math.max(...perFolder.values())).toBeLessThan(60) // 20 on average
  })

  it('also spreads ids that a generator counts up within one millisecond', () => {
    // Same time, same start of the random part: only the end differs, as the ids of one burst of a counting generator do.
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const ids = Array.from({ length: 1024 }, (_, i) => `01M75HR3RVYARM3WP9TJXEYF${alphabet[Math.floor(i / 32)]}${alphabet[i % 32]}`)
    expect(new Set(ids.map((id) => objectPath(id).slice(0, -(id.length + 6)))).size).toBe(1024)
  })

  it('refuses anything that is not a ULID', () => {
    expect(() => objectPath('../etc/passwd')).toThrow()
    expect(() => objectPath('01jabcdefghjkmnpqrstvwxyz0')).toThrow() // lower case
    expect(parseObjectId('01JABCDEFGHJKMNPQRSTVWXYZ0')).not.toBeNull()
    expect(parseObjectId('01JABCDEFGHJKMNPQRSTVWXYZ')).toBeNull() // 25 characters
  })
})
