import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { snapshotHeader, snapshotLine } from '@tamandua/core'
import { readSnapshot } from '../src/snapshot.js'

const record = (n: number) => ({ path: `objects/ZH/${n}.yaml`, id: String(n), sha: `s${n}`, text: `id: ${n}\ntitle: "Ä Zeile ${n}"\n` })
const file = (lines: string[]) => new Response(gzipSync(lines.join('\n') + '\n'))

describe('readSnapshot', () => {
  it('reads the objects of a snapshot, also when it arrives in small pieces', async () => {
    const body = gzipSync([snapshotHeader({ commit: 'c1', count: 3 }), ...[1, 2, 3].map((n) => snapshotLine(record(n)))].join('\n') + '\n')
    const pieces = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += 7) controller.enqueue(body.subarray(i, i + 7))
        controller.close()
      },
    })
    const seen: number[] = []
    const snapshot = await readSnapshot(new Response(pieces, { headers: { 'content-length': String(body.length) } }), (bytes, total) => seen.push(bytes, total))
    expect(snapshot).toEqual({ commit: 'c1', records: [record(1), record(2), record(3)] })
    expect(seen.at(-2)).toBe(body.length) // the last report: everything arrived
    expect(seen.at(-1)).toBe(body.length)
  })

  it('also reads a file that was unpacked on the way (a server may do that)', async () => {
    const plain = [snapshotHeader({ commit: 'c1', count: 1 }), snapshotLine(record(1))].join('\n') + '\n'
    expect(await readSnapshot(new Response(plain))).toEqual({ commit: 'c1', records: [record(1)] })
  })

  it('gives nothing for what is missing, cut off, or not a snapshot', async () => {
    expect(await readSnapshot(new Response('Not found', { status: 404 }))).toBeUndefined()
    expect(await readSnapshot(new Response(gzipSync('hello')))).toBeUndefined()
    expect(await readSnapshot(new Response('not even gzip'))).toBeUndefined()
    // fewer objects than the header says
    expect(await readSnapshot(file([snapshotHeader({ commit: 'c1', count: 3 }), snapshotLine(record(1))]))).toBeUndefined()
    // a broken line
    expect(await readSnapshot(file([snapshotHeader({ commit: 'c1', count: 1 }), '{"path":'] ))).toBeUndefined()
    // an empty archive is fine
    expect(await readSnapshot(file([snapshotHeader({ commit: 'c1', count: 0 })]))).toEqual({ commit: 'c1', records: [] })
  })
})
