import { describe, expect, it } from 'vitest'
import { ulid } from '../src/ids.js'

describe('ulid', () => {
  it('has 26 characters of Crockford base32', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('encodes the time in the first 10 characters', () => {
    expect(ulid(0, (b) => b).slice(0, 10)).toBe('0000000000')
    expect(ulid(32, (b) => b).slice(0, 10)).toBe('0000000010')
  })

  it('sorts by creation time', () => {
    expect(ulid(1_000_000) < ulid(2_000_000)).toBe(true)
  })

  it('differs between calls', () => {
    expect(ulid()).not.toBe(ulid())
  })
})
