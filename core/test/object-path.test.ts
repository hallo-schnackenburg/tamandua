import { describe, expect, it } from 'vitest'
import { objectPath, parseObjectId } from '../src/paths.js'
import { ulid } from '../src/ids.js'

describe('objectPath', () => {
  it('uses the first two random characters as the folder', () => {
    expect(objectPath('01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe('objects/HJ/01JABCDEFGHJKMNPQRSTVWXYZ0.yaml')
  })

  it('spreads objects created at about the same time over many folders', () => {
    const folders = new Set(Array.from({ length: 500 }, () => objectPath(ulid(1_800_000_000_000)).split('/')[1]))
    expect(folders.size).toBeGreaterThan(150)
  })

  it('refuses anything that is not a ULID', () => {
    expect(() => objectPath('../etc/passwd')).toThrow()
    expect(() => objectPath('01jabcdefghjkmnpqrstvwxyz0')).toThrow() // lower case
    expect(parseObjectId('01JABCDEFGHJKMNPQRSTVWXYZ0')).not.toBeNull()
    expect(parseObjectId('01JABCDEFGHJKMNPQRSTVWXYZ')).toBeNull() // 25 characters
  })
})
