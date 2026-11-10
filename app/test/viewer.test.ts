import { describe, expect, it } from 'vitest'
import { addressOf, sourceOf, viewable } from '../src/viewer.js'

const BASE = 'https://archiv.example'
const SHA = 'a'.repeat(64)
const original = `files/aa/aa/${SHA}/original.jpg`
const webPath = `files/aa/aa/${SHA}/web-2000.0123456789ab.jpg`
const blob = (text: string) => new Blob([text])

const file = (over: object = {}, entry: object = {}) => ({
  name: 'a.jpg',
  entry: { path: original, mime: 'image/jpeg', width: 4000, height: 3000, variants: [{ kind: 'preview', path: 'p' }, { kind: 'web', path: webPath }], ...entry },
  preview: blob('preview'),
  ...over,
})

describe('which picture the detail view shows', () => {
  it('takes the one that was made in the browser as long as it is there', () => {
    const web = blob('web')
    expect(sourceOf(file({ web }), BASE).large).toBe(web)
    expect(sourceOf(file({ web })).large).toBe(web) // also without a bucket
  })

  it('then the picture for the detail view from the bucket', () => {
    expect(sourceOf(file(), BASE).large).toBe(`${BASE}/${webPath}`)
  })

  it('and for a picture that is not bigger than that, the original', () => {
    const small = file({}, { variants: [], width: 1500, height: 1000 })
    expect(sourceOf(small, BASE).large).toBe(`${BASE}/${original}`)
    // but not for what the browser cannot show
    expect(sourceOf(file({}, { variants: [], mime: 'image/tiff' }), BASE).large).toBeUndefined()
  })

  it('shows only the preview without a bucket address', () => {
    const source = sourceOf(file())
    expect(source.large).toBeUndefined()
    expect(source.original).toBeUndefined()
    expect(source.preview).toBeDefined()
  })

  it('offers the original to open for what a browser shows, and gives the shape of the picture', () => {
    const source = sourceOf(file(), BASE)
    expect(source.original).toBe(`${BASE}/${original}`)
    expect([source.width, source.height]).toEqual([4000, 3000])
    expect(sourceOf(file({}, { mime: 'application/pdf' }), BASE).original).toBe(`${BASE}/${original}`)
    expect(sourceOf(file({}, { mime: 'video/mp4' }), BASE).original).toBeUndefined()
  })

  it('knows whether there is anything to show', () => {
    expect(viewable(file())).toBe(true)
    expect(viewable(file({ preview: undefined }))).toBe(false)
    expect(viewable(file({ preview: undefined, web: blob('w') }))).toBe(true)
  })

  it('joins an address without doubling the slash', () => {
    expect(addressOf('https://x.example/', 'files/a')).toBe('https://x.example/files/a')
  })
})
