import { describe, expect, it } from 'vitest'
import { validateObject } from '../src/schema.js'
import { clone, file, letter, photo, preview, sha } from './fixtures.js'

type Obj = Record<string, any>

/** Valid object -> one change -> the messages the schema reports. */
function messages(base: Obj, change: (o: Obj) => void): string[] {
  const o = clone(base)
  change(o)
  return validateObject(o).map((i) => `${i.path}: ${i.message}`)
}

describe('valid objects', () => {
  it('accepts a photo', () => expect(validateObject(photo())).toEqual([]))
  it('accepts a multi-page letter', () => expect(validateObject(letter())).toEqual([]))
})

describe('image', () => {
  it('needs exactly one file', () => {
    expect(messages(photo(), (o) => o.files.push(file('main', 'e'))).length).toBeGreaterThan(0)
    expect(messages(photo(), (o) => (o.files = [])).length).toBeGreaterThan(0)
  })

  it('wants the role "main"', () => {
    expect(messages(photo(), (o) => (o.files[0].role = 'page'))).toContain('/files/0/role: must be "main"')
  })

  it('does not take document fields', () => {
    expect(messages(photo(), (o) => (o.recipient = 'x'))).toContain('/recipient: unknown field "recipient"')
  })
})

describe('document', () => {
  it('does not need a subtype', () => {
    expect(messages(letter(), (o) => delete o.subtype)).toEqual([])
  })

  it('does not take the author, that is the origin', () => {
    expect(messages(letter(), (o) => (o.author = 'x'))).toContain('/author: unknown field "author"')
  })

  it('needs seq on every page', () => {
    expect(messages(letter(), (o) => delete o.files[0].seq)).toContain('/files/0: missing field "seq"')
  })
})

describe('common fields', () => {
  it('reports a misspelled field instead of ignoring it', () => {
    expect(messages(photo(), (o) => (o.titel = 'x'))).toContain('/titel: unknown field "titel"')
  })

  it('wants a ULID as id', () => {
    expect(messages(photo(), (o) => (o.id = 'abc')).length).toBeGreaterThan(0)
  })

  it('knows only the types image and document', () => {
    expect(messages(photo(), (o) => (o.type = 'book'))[0]).toMatch(/must be one of: image, document/)
  })

  it('does not accept an empty subtype', () => {
    expect(messages(photo(), (o) => (o.subtype = '')).length).toBeGreaterThan(0)
  })

  it('wants lat, lon and precision in a geocode', () => {
    expect(messages(photo(), (o) => delete o.geocode.precision)).toContain('/geocode: missing field "precision"')
    expect(messages(photo(), (o) => (o.geocode.lat = 200)).length).toBeGreaterThan(0)
  })
})

describe('dates', () => {
  it.each(['1963', '1963-07', '1963-07-14', '196X', '19XX', '1963?', '1963~', '1963-07~', '1960/1969'])(
    'accepts %s',
    (date) => expect(messages(photo(), (o) => (o.date = date))).toEqual([]),
  )

  it.each(['um 1960', '63', '1963-7', '1963-07-14T10:00'])('rejects %s', (date) =>
    expect(messages(photo(), (o) => (o.date = date)).length).toBeGreaterThan(0),
  )

  it('explains an invalid date without showing the pattern', () => {
    expect(messages(photo(), (o) => (o.date = 'um 1960'))).toEqual([
      '/date: not a valid date; use e.g. "1963", "1963-07-14", "196X", "1960/1969"',
    ])
  })

  it('explains an unquoted year (YAML reads it as a number)', () => {
    expect(messages(photo(), (o) => (o.date = 1963))).toEqual([
      '/date: date must be text; put it in quotes, e.g. date: "1963"',
    ])
  })
})

describe('files and variants', () => {
  it('rejects a path in the old layout', () => {
    const old = `originals/aa/aa/${sha('a')}.tif`
    expect(messages(photo(), (o) => (o.files[0].path = old)).length).toBeGreaterThan(0)
  })

  it('rejects a path that is not a store path', () => {
    expect(messages(photo(), (o) => (o.files[0].path = 'foo/bar.tif')).length).toBeGreaterThan(0)
  })

  it('wants a generator on every variant', () => {
    expect(messages(photo(), (o) => delete o.files[0].variants[0].generator)).toContain(
      '/files/0/variants/0: missing field "generator"',
    )
  })

  it('knows only certain variant kinds', () => {
    expect(messages(photo(), (o) => (o.files[0].variants[0].kind = 'big'))[0]).toMatch(/must be one of: preview/)
  })

  it('accepts more variants, e.g. OCR text', () => {
    const ocr: Obj = { ...preview('a', 'c'), kind: 'ocr_text', mime: 'text/plain' }
    delete ocr.width
    delete ocr.height
    expect(messages(photo(), (o) => o.files[0].variants.push(ocr))).toEqual([])
  })
})

describe('origin and subjects', () => {
  it('need a name', () => {
    expect(messages(photo(), (o) => delete o.origin.name)).toContain('/origin: missing field "name"')
    expect(messages(photo(), (o) => delete o.subjects[1].name)).toContain('/subjects/1: missing field "name"')
  })

  it('take a place and a geocode', () => {
    const geocode = { lat: 52.99, lon: 11.57, precision: 'exact' }
    expect(messages(photo(), (o) => (o.subjects[0] = { name: 'Haus', type: 'building', location: 'Markt 3', geocode }))).toEqual([])
    expect(messages(photo(), (o) => (o.origin.geocode = { lat: 1 }))).toContain('/origin/geocode: missing field "lon"')
  })

  it('report a misspelled field', () => {
    expect(messages(photo(), (o) => (o.subjects[0].nme = 'x'))).toContain('/subjects/0/nme: unknown field "nme"')
  })

  it('are not lists of plain names', () => {
    expect(messages(photo(), (o) => (o.subjects = ['Heinrich'])).length).toBeGreaterThan(0)
  })

  it('are not accepted in the old form', () => {
    expect(messages(photo(), (o) => (o.people = ['A']))).toContain('/people: unknown field "people"')
    expect(messages(photo(), (o) => (o.photographer = 'A'))).toContain('/photographer: unknown field "photographer"')
  })
})
