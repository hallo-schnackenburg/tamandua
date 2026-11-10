import { describe, expect, it } from 'vitest'
import { validateObject } from '../src/schema.js'
import { clone, external, file, letter, photo, preview, sha } from './fixtures.js'

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
  it('accepts an object that lives elsewhere', () => expect(validateObject(external())).toEqual([]))
})

describe('storage', () => {
  it('is local by default, and then the files are needed', () => {
    expect(messages(photo(), (o) => delete o.files)).toContain('/: missing field "files"')
    expect(messages(photo(), (o) => (o.storage = 'local'))).toEqual([])
  })

  it('knows local and external', () => {
    expect(messages(photo(), (o) => (o.storage = 'remote'))[0]).toMatch(/must be one of: local, external/)
  })

  it('does not allow "external" on a local object', () => {
    const entry = external().external
    expect(messages(photo(), (o) => (o.external = entry))).toContain('/external: only allowed when storage is "external"')
  })
})

describe('external', () => {
  it('needs the list of places', () => {
    expect(messages(external(), (o) => delete o.external)).toContain('/: missing field "external"')
  })

  it('needs at least one place', () => {
    expect(messages(external(), (o) => (o.external = [])).length).toBeGreaterThan(0)
  })

  it('may have several places', () => {
    expect(
      messages(external(), (o) => o.external.push({ type: 'platform', site: 'YouTube', uri: 'https://www.youtube.com/watch?v=x' })),
    ).toEqual([])
  })

  it('needs no particular detail of a place, the address may not be known', () => {
    expect(messages(external(), (o) => (o.external = [{ uri: 'https://example.org/a' }]))).toEqual([])
    expect(messages(external(), (o) => (o.external = [{ site: 'Wendlandarchiv' }]))).toEqual([])
    expect(messages(external(), (o) => delete o.external[0].uri)).toEqual([])
  })

  it('takes a note on a place', () => {
    expect(messages(external(), (o) => (o.external[0].note = 'Seite 12, unter „Fähre“'))).toEqual([])
    expect(messages(external(), (o) => (o.external[0].note = '')).length).toBeGreaterThan(0)
  })

  it('does not take an empty place', () => {
    expect(messages(external(), (o) => (o.external = [{}])).length).toBeGreaterThan(0)
  })

  it('wants a web address', () => {
    expect(messages(external(), (o) => (o.external[0].uri = 'Arcinsys Nr. 5'))).toEqual([
      '/external/0/uri: must be a web address starting with http:// or https://',
    ])
  })

  it('wants a real day for retrieved', () => {
    expect(messages(external(), (o) => (o.external[0].retrieved = '2026-13-40')).length).toBeGreaterThan(0)
    expect(messages(external(), (o) => (o.external[0].retrieved = 'gestern')).length).toBeGreaterThan(0)
  })

  it('reports a misspelled field of a place', () => {
    expect(messages(external(), (o) => (o.external[0].url = 'x'))).toContain('/external/0/url: unknown field "url"')
  })

  it('takes a thumbnail or a screenshot as files, but not a main file', () => {
    expect(messages(external(), (o) => (o.files = [file('screenshot', 'a')]))).toEqual([])
    expect(messages(external(), (o) => (o.files = [file('thumbnail', 'a')]))).toEqual([])
    expect(messages(external(), (o) => (o.files = [file('main', 'a')]))).toContain(
      '/files/0/role: must be one of: thumbnail, screenshot',
    )
  })

  it('still wants the document fields to be right', () => {
    expect(messages(external(), (o) => (o.recipient = 'x'))).toContain('/recipient: unknown field "recipient"')
    const doc = () => ({ ...external(), type: 'document', subtype: 'letter', recipient: 'Anna', language: 'de' })
    expect(messages(doc(), () => {})).toEqual([])
  })
})

describe('original_name', () => {
  it('may name the file the way it was captured', () => {
    expect(messages(photo(), (o) => (o.files[0].original_name = 'DJI_20260105143012_0001_D.JPG'))).toEqual([])
  })

  it('is not empty and not a number', () => {
    expect(messages(photo(), (o) => (o.files[0].original_name = '')).length).toBeGreaterThan(0)
    expect(messages(photo(), (o) => (o.files[0].original_name = 5)).length).toBeGreaterThan(0)
  })
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

  it('needs num on every page', () => {
    expect(messages(letter(), (o) => delete o.files[0].num)).toContain('/files/0: missing field "num"')
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

describe('holder and owner', () => {
  it('are entities with a name', () => {
    expect(messages(photo(), (o) => (o.holder = { name: 'Stadtarchiv', type: 'business' }))).toEqual([])
    expect(messages(photo(), (o) => (o.owner = { type: 'person' }))).toContain('/owner: missing field "name"')
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
    expect(messages(photo(), (o) => (o.geocode = { lat: 52.99, lon: 11.57, precision: 'exact', source: 'osm' }))).toEqual([])
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
