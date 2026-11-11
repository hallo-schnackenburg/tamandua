import { describe, expect, it } from 'vitest'
import { hasBlobs, packBlobs, unpackBlobs, withoutBlobs } from '../src/blobs.js'

const file = () => ({ sha256: 'abc', name: 'a.jpg', preview: new Blob(['preview'], { type: 'image/webp' }), web: new Blob(['web!'], { type: 'image/jpeg' }) })

describe('pictures as bytes', () => {
  it('stores no Blob and brings the same pictures back', async () => {
    const original = file()
    const packed = await packBlobs(original)
    expect(packed.preview).not.toBeInstanceOf(Blob)
    expect(packed.web).not.toBeInstanceOf(Blob)
    expect(original.preview).toBeInstanceOf(Blob) // the record in memory is not changed

    const back = unpackBlobs(packed)
    expect(back.preview).toBeInstanceOf(Blob)
    expect(back.preview!.type).toBe('image/webp')
    expect(await back.preview!.text()).toBe('preview')
    expect(await back.web!.text()).toBe('web!')
    expect(back.name).toBe('a.jpg')
  })

  it('leaves records without pictures and records stored with real Blobs as they are', async () => {
    expect(await packBlobs({ sha256: 'x' })).toEqual({ sha256: 'x' })
    const old = file()
    expect(unpackBlobs(old).preview).toBe(old.preview)
  })

  it('can drop the pictures', () => {
    const plain = withoutBlobs(file())
    expect(hasBlobs(plain)).toBe(false)
    expect(plain.name).toBe('a.jpg')
    expect(hasBlobs(file())).toBe(true)
  })
})
