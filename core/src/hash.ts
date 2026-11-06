// SHA-256 in chunks. Videos can be several GB, so a file is never held in memory
// as a whole. WebCrypto cannot do this (it needs the complete buffer), which is
// why we use @noble/hashes, which runs the same way in browsers, Workers and Node.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

type Chunks = AsyncIterable<Uint8Array> | Iterable<Uint8Array>

/** Hash a sequence of chunks. Returns 64 lowercase hex characters. */
export async function hashChunks(chunks: Chunks): Promise<string> {
  const hasher = sha256.create()
  for await (const chunk of chunks) hasher.update(chunk)
  return bytesToHex(hasher.digest())
}

/** Read a Blob (or File) piece by piece. */
export async function* blobChunks(
  blob: Blob,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<Uint8Array> {
  if (chunkSize < 1) throw new Error('chunkSize must be at least 1')
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    yield new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer())
  }
}

export function hashBlob(blob: Blob, chunkSize?: number): Promise<string> {
  return hashChunks(blobChunks(blob, chunkSize))
}
