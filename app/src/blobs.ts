// Pictures are kept in the browser as plain bytes, not as `Blob`s: Safari cannot store a `Blob` in IndexedDB
// in a private window (the transaction is aborted without an error), but it stores bytes everywhere.

/** The pictures of a file record. */
const KEYS = ['preview', 'web'] as const

interface Packed {
  packed: true
  type: string
  bytes: ArrayBuffer
}

const isPacked = (value: unknown): value is Packed => typeof value === 'object' && value !== null && (value as Packed).packed === true && (value as Packed).bytes instanceof ArrayBuffer

type Pictures = { preview?: Blob; web?: Blob }

/** A copy of the record whose pictures are bytes; the record itself is not changed. */
export async function packBlobs<T extends Pictures>(file: T): Promise<T> {
  const out: Record<string, unknown> = { ...file }
  for (const key of KEYS) {
    const value = file[key]
    if (value instanceof Blob) out[key] = { packed: true, type: value.type, bytes: await value.arrayBuffer() } satisfies Packed
  }
  return out as T
}

/** The record as it was before `packBlobs`. Records stored earlier, with real `Blob`s, pass unchanged. */
export function unpackBlobs<T extends Pictures>(record: T): T {
  const out: Record<string, unknown> = { ...record }
  for (const key of KEYS) {
    const value: unknown = out[key]
    if (isPacked(value)) out[key] = new Blob([value.bytes], { type: value.type })
  }
  return out as T
}

/** A copy of the record without its pictures. */
export function withoutBlobs<T extends Pictures>(file: T): T {
  const out: Record<string, unknown> = { ...file }
  for (const key of KEYS) delete out[key]
  return out as T
}

export const hasBlobs = (file: Pictures) => KEYS.some((key) => file[key] instanceof Blob)
