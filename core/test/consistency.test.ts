import { describe, expect, it } from 'vitest'
import { checkConsistency } from '../src/consistency.js'
import { clone, file, letter, photo, preview, sha } from './fixtures.js'

type Obj = Record<string, any>

function problems(base: Obj, change: (o: Obj) => void): string[] {
  const o = clone(base)
  change(o)
  return checkConsistency(o).map((i) => `${i.path}: ${i.message}`)
}

describe('checkConsistency', () => {
  it('accepts consistent objects', () => {
    expect(checkConsistency(photo())).toEqual([])
    expect(checkConsistency(letter())).toEqual([])
  })

  it('finds a path that does not belong to the sha256', () => {
    const [message] = problems(photo(), (o) => (o.files[0].sha256 = sha('9')))
    expect(message).toMatch(/^\/files\/0\/path: path does not match sha256/)
  })

  it('finds a variant stored with another file', () => {
    const [message] = problems(photo(), (o) => (o.files[0].variants[0] = preview('e', 'b')))
    expect(message).toMatch(/^\/files\/0\/variants\/0\/path: path does not match the file/)
  })

  it('finds a variant whose name carries the wrong hash', () => {
    const [message] = problems(photo(), (o) => (o.files[0].variants[0].sha256 = sha('9')))
    expect(message).toMatch(/variants\/0\/path: path does not match/)
  })

  it('finds a variant whose name does not start with its kind', () => {
    const [message] = problems(photo(), (o) => (o.files[0].variants[0].kind = 'web'))
    expect(message).toMatch(/must be or start with the kind "web"/)
  })

  it('finds a seq used twice', () => {
    expect(problems(letter(), (o) => (o.files[1].seq = 1))).toEqual([
      '/files/1/seq: seq 1 is already used by /files/0',
    ])
  })

  it('finds the same file twice in one object', () => {
    const messages = problems(letter(), (o) => o.files.push(file('page', 'c', { seq: 3 })))
    expect(messages).toEqual(['/files/2/sha256: same file as /files/0'])
  })

  it('ignores malformed input; that is the schema\'s job', () => {
    expect(checkConsistency(null)).toEqual([])
    expect(checkConsistency({ files: 'nope' })).toEqual([])
    expect(checkConsistency({ files: [{ sha256: 'short', path: 3 }] })).toEqual([])
  })
})
