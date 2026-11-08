// Everything the browser can find out about a dropped file without a server:
// the SHA-256 (the file's identity), size, image dimensions and a small preview.
// Nothing is uploaded here.

import { blobChunks, hashBlob, hashChunks, originalPath, variantPath, type FileEntry } from '@tamandua/core'

const PREVIEW_SIZE = 400

export interface Prepared {
  /** The entry for `files` in the YAML, including the preview as a variant. */
  entry: FileEntry
  /** The preview image, for showing it in the list (later: for uploading). */
  preview?: Blob
}

/** Hashes the file piece by piece and reports how far it is (0 to 1). */
async function hashWithProgress(file: File, onProgress: (fraction: number) => void): Promise<string> {
  async function* chunks() {
    let done = 0
    for await (const chunk of blobChunks(file)) {
      done += chunk.length
      onProgress(done / file.size)
      yield chunk
    }
  }
  return hashChunks(chunks())
}

interface Decoded {
  width: number
  height: number
  preview: Blob
  previewWidth: number
  previewHeight: number
}

/** Decodes the image and scales it down. Returns null for what the browser cannot decode (TIFF, PDF, video). */
async function decode(file: File): Promise<Decoded | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, PREVIEW_SIZE / Math.max(bitmap.width, bitmap.height))
    const previewWidth = Math.max(1, Math.round(bitmap.width * scale))
    const previewHeight = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(previewWidth, previewHeight)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, previewWidth, previewHeight)
    const preview = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
    const { width, height } = bitmap
    bitmap.close()
    return { width, height, preview, previewWidth, previewHeight }
  } catch {
    return null
  }
}

export async function prepareFile(file: File, onProgress: (fraction: number) => void): Promise<Prepared> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (!/^[a-z0-9]+$/.test(ext) || ext === file.name.toLowerCase()) {
    throw new Error(`"${file.name}" has no usable file name extension.`)
  }

  const sha256 = await hashWithProgress(file, onProgress)
  const entry: FileEntry = {
    original_name: file.name,
    path: originalPath(sha256, ext),
    sha256,
    mime: file.type || 'application/octet-stream',
    bytes: file.size,
  }

  const decoded = await decode(file)
  if (!decoded) return { entry }

  entry.width = decoded.width
  entry.height = decoded.height
  const previewHash = await hashBlob(decoded.preview)
  entry.variants = [
    {
      kind: 'preview',
      path: variantPath(sha256, { name: `preview-${PREVIEW_SIZE}`, sha256: previewHash, ext: 'jpg' }),
      sha256: previewHash,
      mime: 'image/jpeg',
      bytes: decoded.preview.size,
      width: decoded.previewWidth,
      height: decoded.previewHeight,
      generator: { name: 'browser-canvas', version: '1' },
    },
  ]
  return { entry, preview: decoded.preview }
}
