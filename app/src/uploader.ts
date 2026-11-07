// The part of the app that puts files into the object store. The rest of the app only
// knows this interface. S3Store is the real one (via the Worker); FakeStore stands in
// without a Worker: it needs no network and can pretend a conflict or a failure.

import type { FileEntry } from '@tamandua/core'
import { jsonOf, request } from './api.js'

export interface UploadResult {
  status: 'uploaded' | 'conflict'
  /** For a conflict: what to tell the user. */
  message?: string
}

export interface FileStore {
  /**
   * Claims the file and uploads it, with its preview if there is one. Throws an Error if
   * the upload fails; trying again only sends what is still missing.
   */
  upload(file: File, entry: FileEntry, onProgress: (fraction: number) => void, preview?: Blob): Promise<UploadResult>
}

interface Part {
  path: string
  mime: string
  body: Blob
}

interface Answer {
  path: string
  exists: boolean
  url?: string
  headers?: Record<string, string>
}

/** PUT with progress; `fetch` cannot report how much of the body has been sent. */
function put(url: string, headers: Record<string, string>, body: Blob, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.upload.onprogress = (event) => onProgress(event.loaded)
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`Der Speicher hat den Upload abgelehnt (${request.status}).`))
    request.onerror = () => reject(new Error('Der Speicher ist nicht erreichbar.'))
    request.send(body)
  })
}

/**
 * Uploads straight from the browser to the bucket. The Worker only says what is missing and signs
 * the URLs; it never sees the files.
 */
export class S3Store implements FileStore {
  #url: string

  constructor(workerUrl: string) {
    this.#url = workerUrl.replace(/\/$/, '')
  }

  async upload(file: File, entry: FileEntry, onProgress: (fraction: number) => void, preview?: Blob): Promise<UploadResult> {
    const parts: Part[] = [{ path: entry.path as string, mime: entry.mime as string, body: file }]
    // The preview is only uploaded if we still have it; the entry in the YAML names it either way.
    const variant = ((entry.variants ?? []) as { kind: string; path: string; mime: string }[]).find((v) => v.kind === 'preview')
    if (variant && preview) parts.push({ path: variant.path, mime: variant.mime, body: preview })

    const answers = await this.#plan(parts)
    const missing = parts.filter((part) => answers.get(part.path)?.exists === false)
    const total = missing.reduce((sum, part) => sum + part.body.size, 0)

    let done = 0
    onProgress(total === 0 ? 1 : 0)
    for (const part of missing) {
      const { url, headers } = answers.get(part.path)!
      await put(url!, headers ?? {}, part.body, (sent) => onProgress((done + sent) / total))
      done += part.body.size
    }
    return { status: 'uploaded' }
  }

  async #plan(parts: Part[]): Promise<Map<string, Answer>> {
    const response = await request(`${this.#url}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: parts.map((part) => ({ path: part.path, mime: part.mime, bytes: part.body.size })) }),
    })
    const data = await jsonOf<{ files?: Answer[] }>(response)
    if (!response.ok || !data.files) throw new Error(data.error ?? `Fehler ${response.status}`)
    return new Map(data.files.map((answer) => [answer.path, answer]))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Test stand-in. A file name containing "conflict" gives a conflict, one containing "fail" a failure. */
export class FakeStore implements FileStore {
  async upload(file: File, _entry: FileEntry, onProgress: (fraction: number) => void, _preview?: Blob): Promise<UploadResult> {
    for (let step = 1; step <= 10; step++) {
      await sleep(80)
      onProgress(step / 10)
    }
    if (/fail/i.test(file.name)) throw new Error('Upload fehlgeschlagen (Test).')
    if (/conflict/i.test(file.name)) return { status: 'conflict', message: 'Gehört Anna seit 3 Tagen (Test).' }
    return { status: 'uploaded' }
  }
}
