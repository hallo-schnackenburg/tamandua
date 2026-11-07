import { describe, expect, it } from 'vitest'
import { originalPath, parseFilePath, variantPath } from '../src/paths.js'

const hash = '9f2c' + '0'.repeat(60)
const other = 'ab' + '1'.repeat(62)

describe('parseFilePath', () => {
  it('recognizes what originalPath and variantPath produce', () => {
    expect(parseFilePath(originalPath(hash, 'tif'))).toEqual({ sha256: hash, kind: 'original' })
    const variant = variantPath(hash, { name: 'preview-400', sha256: other, ext: 'jpg' })
    expect(parseFilePath(variant)).toEqual({ sha256: hash, kind: 'variant' })
  })

  it('refuses anything else', () => {
    expect(parseFilePath(`files/9f/2c/${hash}/../../evil.tif`)).toBeNull()
    expect(parseFilePath(`other/9f/2c/${hash}/original.tif`)).toBeNull()
    expect(parseFilePath(`files/aa/2c/${hash}/original.tif`)).toBeNull() // directory does not belong to the hash
    expect(parseFilePath(`files/9f/2c/${hash}/notes.txt`)).toBeNull()
    expect(parseFilePath(`files/9f/2c/${hash}/original.tar.gz`)).toBeNull()
    expect(parseFilePath(`files/9f/2c/${hash}/preview-400.zzz.jpg`)).toBeNull() // not 12 hex characters
    expect(parseFilePath('')).toBeNull()
  })
})
