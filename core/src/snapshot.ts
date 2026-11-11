// The snapshot: all objects of the archive in one file, so that a browser that has nothing yet can read them
// with one download instead of one request per object. The data repository's CI builds it on every push to
// main (core/scripts/build-snapshot.ts) and keeps it on the branch `snapshot`; the browser reads it from there.
//
// Format: newline-delimited JSON, gzip-compressed. The first line is the header, every other line is one object.
//   {"snapshot":1,"commit":"<commit of main it was made from>","count":20039}
//   {"path":"objects/Z/H/01M3….yaml","id":"01M3…","sha":"<git blob hash>","text":"id: 01M3…\n…"}

export const SNAPSHOT_BRANCH = 'snapshot'
export const SNAPSHOT_FILE = 'snapshot.ndjson.gz'

export interface SnapshotRecord {
  /** Where the object is in the repository: objects/<a>/<b>/<id>.yaml. */
  path: string
  id: string
  /** The hash git has for the file: equal hash, equal text. */
  sha: string
  text: string
}

export interface SnapshotHeader {
  /** The commit of main the snapshot was made from. */
  commit: string
  /** How many objects follow (a file that was cut off is recognized by it). */
  count: number
}

export const snapshotHeader = (header: SnapshotHeader): string => JSON.stringify({ snapshot: 1, ...header })

export const snapshotLine = (record: SnapshotRecord): string => JSON.stringify({ path: record.path, id: record.id, sha: record.sha, text: record.text })

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export function parseSnapshotHeader(line: string): SnapshotHeader | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.snapshot !== 1 || !isText(value.commit) || typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 0) return undefined
    return { commit: value.commit, count: value.count }
  } catch {
    return undefined
  }
}

export function parseSnapshotLine(line: string): SnapshotRecord | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (!isText(value.path) || !isText(value.id) || !isText(value.sha) || typeof value.text !== 'string') return undefined
    return { path: value.path, id: value.id, sha: value.sha, text: value.text }
  } catch {
    return undefined
  }
}
