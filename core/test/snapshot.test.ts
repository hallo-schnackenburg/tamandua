import { describe, expect, it } from 'vitest'
import { parseSnapshotHeader, parseSnapshotLine, snapshotHeader, snapshotLine } from '../src/snapshot.js'

const record = { path: 'objects/ZH/X.yaml', id: 'X', sha: 'abc', text: 'id: X\ntitle: "Ä\nZeile"\n' }

describe('snapshot lines', () => {
  it('carries a record through, also with line breaks and special characters in the text', () => {
    const line = snapshotLine(record)
    expect(line).not.toContain('\n') // one line per object
    expect(parseSnapshotLine(line)).toEqual(record)
  })

  it('carries the header through', () => {
    expect(parseSnapshotHeader(snapshotHeader({ commit: 'c1', count: 3 }))).toEqual({ commit: 'c1', count: 3 })
  })

  it('does not take what is not a record or not a header', () => {
    expect(parseSnapshotLine('not json')).toBeUndefined()
    expect(parseSnapshotLine('{"path":"a"}')).toBeUndefined()
    expect(parseSnapshotLine('{"path":"a","id":"b","sha":"c","text":5}')).toBeUndefined()
    expect(parseSnapshotHeader('{"snapshot":2,"commit":"c","count":1}')).toBeUndefined()
    expect(parseSnapshotHeader('{"snapshot":1,"commit":"c","count":-1}')).toBeUndefined()
    expect(parseSnapshotHeader(snapshotLine(record))).toBeUndefined()
  })
})
