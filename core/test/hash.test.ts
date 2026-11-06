import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashBlob, hashChunks } from '../src/hash.js'

const reference = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function bytesOf(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Array.from({ length }, (_, i) => (i * 31 + 7) % 256))
}

describe('hashBlob', () => {
  it('knows the hash of the empty file', async () => {
    expect(await hashBlob(new Blob([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  // The result must not depend on how the file is cut into chunks.
  for (const size of [0, 1, 6, 7, 8, 1000, 1024, 1025, 5000]) {
    for (const chunkSize of [1, 7, 1024]) {
      it(`matches Node's hash for ${size} bytes in chunks of ${chunkSize}`, async () => {
        const bytes = bytesOf(size)
        expect(await hashBlob(new Blob([bytes]), chunkSize)).toBe(reference(bytes))
      })
    }
  }

  it('refuses a chunk size below 1', async () => {
    await expect(hashBlob(new Blob([bytesOf(3)]), 0)).rejects.toThrow()
  })
})

describe('hashChunks', () => {
  it('accepts plain arrays and async generators', async () => {
    const bytes = bytesOf(100)
    const parts = [bytes.slice(0, 30), bytes.slice(30)]
    async function* generated() {
      for (const part of parts) yield part
    }
    expect(await hashChunks(parts)).toBe(reference(bytes))
    expect(await hashChunks(generated())).toBe(reference(bytes))
  })
})
