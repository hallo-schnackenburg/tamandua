import { describe, expect, it } from 'vitest'
import { fileDir, originalPath, variantPath } from '../src/paths.js'
import { sha } from './fixtures.js'

const hash = '9f2c' + '0'.repeat(60)

describe('fileDir', () => {
  it('spreads files over two levels of two hex characters', () => {
    expect(fileDir(hash)).toBe(`files/9f/2c/${hash}`)
  })

  it('rejects anything that is not a sha256', () => {
    expect(() => fileDir('abc')).toThrow()
    expect(() => fileDir(hash.toUpperCase())).toThrow()
  })
})

describe('originalPath', () => {
  it('puts the original into the directory of its hash', () => {
    expect(originalPath(hash, 'tif')).toBe(`files/9f/2c/${hash}/original.tif`)
  })

  it('normalizes the extension', () => {
    expect(originalPath(hash, '.TIF')).toBe(originalPath(hash, 'tif'))
  })

  it('rejects odd extensions', () => {
    expect(() => originalPath(hash, 'tar.gz')).toThrow()
    expect(() => originalPath(hash, '')).toThrow()
  })
})

describe('variantPath', () => {
  const variantHash = '41ab9c03d2e1' + '0'.repeat(52)

  it('lives next to the original and carries 12 characters of its own hash', () => {
    const path = variantPath(hash, { name: 'preview-400', sha256: variantHash, ext: 'jpg' })
    expect(path).toBe(`files/9f/2c/${hash}/preview-400.41ab9c03d2e1.jpg`)
  })

  it('gives the same name for the same content', () => {
    const ref = { name: 'ocr_text', sha256: sha('e'), ext: 'txt' }
    expect(variantPath(hash, ref)).toBe(variantPath(hash, { ...ref }))
  })

  it('gives a new name for changed content', () => {
    const a = variantPath(hash, { name: 'preview-400', sha256: sha('e'), ext: 'jpg' })
    const b = variantPath(hash, { name: 'preview-400', sha256: sha('f'), ext: 'jpg' })
    expect(a).not.toBe(b)
  })

  it('rejects names with dots or slashes', () => {
    expect(() => variantPath(hash, { name: '../x', sha256: sha('e'), ext: 'jpg' })).toThrow()
    expect(() => variantPath(hash, { name: 'a.b', sha256: sha('e'), ext: 'jpg' })).toThrow()
  })
})
