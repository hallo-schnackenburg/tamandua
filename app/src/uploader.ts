// The part of the app that puts files into the object store. The rest of the app only
// knows this interface. Until the real store and the Worker exist, FakeStore stands in:
// it needs no network and can pretend a conflict or a failure, so that the whole
// interface can be built and tried out first.

import type { FileEntry } from '@archive/core'

export interface UploadResult {
  status: 'uploaded' | 'conflict'
  /** For a conflict: what to tell the user. */
  message?: string
}

export interface FileStore {
  /** Claims the file and uploads it. Throws an Error if the upload fails. */
  upload(file: File, entry: FileEntry, onProgress: (fraction: number) => void): Promise<UploadResult>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Test stand-in. A file name containing "conflict" gives a conflict, one containing "fail" a failure. */
export class FakeStore implements FileStore {
  async upload(file: File, _entry: FileEntry, onProgress: (fraction: number) => void): Promise<UploadResult> {
    for (let step = 1; step <= 10; step++) {
      await sleep(80)
      onProgress(step / 10)
    }
    if (/fail/i.test(file.name)) throw new Error('Upload fehlgeschlagen (Test).')
    if (/conflict/i.test(file.name)) return { status: 'conflict', message: 'Gehört Anna seit 3 Tagen (Test).' }
    return { status: 'uploaded' }
  }
}
