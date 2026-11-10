// Everything the browser can find out about a dropped file without a server:
// the SHA-256 (the file's identity), size, image dimensions and a small preview.
// Nothing is uploaded here.

import { blobChunks, hashBlob, hashChunks, originalPath, variantPath, type FileEntry } from '@tamandua/core'

const PREVIEW_SIZE = 400
/** The longer side of the picture for the detail view: big enough to read details, small enough to load fast. */
const WEB_SIZE = 2000

export interface Prepared {
  /** The entry for `files` in the YAML, including the preview as a variant. */
  entry: FileEntry
  /** The preview image, for showing it in the list (and for uploading). */
  preview?: Blob
  /** The picture for the detail view; none if the original is not bigger than that (the original itself is shown then). */
  web?: Blob
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
  web?: { blob: Blob; width: number; height: number }
}

/** Decodes the image and scales it down. Returns null for what the browser cannot decode (TIFF, PDF, video). */
async function decode(file: File): Promise<Decoded | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)

    // The bigger picture first; the preview is made from it (faster, and smoother than from a huge original).
    let web: Decoded['web']
    let source: CanvasImageSource = bitmap
    if (longest > WEB_SIZE) {
      const factor = WEB_SIZE / longest
      const width = Math.max(1, Math.round(bitmap.width * factor))
      const height = Math.max(1, Math.round(bitmap.height * factor))
      const big = new OffscreenCanvas(width, height)
      big.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
      web = { blob: await big.convertToBlob({ type: 'image/jpeg', quality: 0.82 }), width, height }
      source = big
    }

    const scale = Math.min(1, PREVIEW_SIZE / longest)
    const previewWidth = Math.max(1, Math.round(bitmap.width * scale))
    const previewHeight = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(previewWidth, previewHeight)
    canvas.getContext('2d')!.drawImage(source, 0, 0, previewWidth, previewHeight)
    const preview = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
    const { width, height } = bitmap
    bitmap.close()
    return { width, height, preview, previewWidth, previewHeight, web }
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
  const variants: Record<string, unknown>[] = []
  // An image that is not bigger than the preview would get a copy of itself: no variant then (the list still shows the local preview).
  if (Math.max(decoded.width, decoded.height) > PREVIEW_SIZE) {
    const previewHash = await hashBlob(decoded.preview)
    variants.push({
      kind: 'preview',
      path: variantPath(sha256, { name: `preview-${PREVIEW_SIZE}`, sha256: previewHash, ext: 'jpg' }),
      sha256: previewHash,
      mime: 'image/jpeg',
      bytes: decoded.preview.size,
      width: decoded.previewWidth,
      height: decoded.previewHeight,
      generator: { name: 'browser-canvas', version: '1' },
    })
  }
  if (decoded.web) {
    const webHash = await hashBlob(decoded.web.blob)
    variants.push({
      kind: 'web',
      path: variantPath(sha256, { name: `web-${WEB_SIZE}`, sha256: webHash, ext: 'jpg' }),
      sha256: webHash,
      mime: 'image/jpeg',
      bytes: decoded.web.blob.size,
      width: decoded.web.width,
      height: decoded.web.height,
      generator: { name: 'browser-canvas', version: '1' },
    })
  }
  if (variants.length > 0) entry.variants = variants
  return { entry, preview: decoded.preview, web: decoded.web?.blob }
}
