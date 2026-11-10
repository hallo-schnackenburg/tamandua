// Reads a snapshot (see core/src/snapshot.ts): the whole archive in one download. The file is gzip-compressed
// newline-delimited JSON; it is unpacked and cut into lines while it arrives, so that 20,000 objects never
// exist twice in memory.

import { parseSnapshotHeader, parseSnapshotLine, type SnapshotRecord } from '@tamandua/core'

export interface Snapshot {
  /** The commit of main it was made from. */
  commit: string
  records: SnapshotRecord[]
}

/**
 * The objects in the response, or undefined if there is no usable snapshot: not found, not what it should be, or cut off
 * (the header says how many objects follow). `progress` is told how many bytes of the download have arrived, and how many there are (0 if unknown).
 */
export async function readSnapshot(response: Response, progress?: (bytes: number, total: number) => void): Promise<Snapshot | undefined> {
  if (!response.ok || !response.body) return undefined
  const total = Number(response.headers.get('content-length')) || 0
  let bytes = 0
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.length
      progress?.(bytes, total)
      controller.enqueue(chunk)
    },
  })
  // The file is gzip, but a server (or a development server) may have unpacked it already on the way: the first bytes tell.
  const source = response.body.pipeThrough(counting).getReader()
  const first = await source.read()
  const gzip = !first.value || first.value.length < 2 || (first.value[0] === 0x1f && first.value[1] === 0x8b)
  const joined = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.value) controller.enqueue(first.value)
      if (first.done) controller.close()
    },
    async pull(controller) {
      const next = await source.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
  })
  const unpacked = gzip ? joined.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : joined
  const reader = unpacked.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader()

  let header: ReturnType<typeof parseSnapshotHeader>
  const records: SnapshotRecord[] = []
  // Returns false for a line that is not what it should be.
  const take = (line: string): boolean => {
    if (line === '') return true
    if (!header) return !!(header = parseSnapshotHeader(line))
    const record = parseSnapshotLine(line)
    if (record) records.push(record)
    return !!record
  }

  try {
    let rest = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += value
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        if (!take(rest.slice(0, end))) return undefined
        rest = rest.slice(end + 1)
      }
    }
    if (!take(rest)) return undefined
  } catch {
    return undefined
  }
  return header && header.count === records.length ? { commit: header.commit, records } : undefined
}
