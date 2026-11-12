import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { render } from '../scripts/generate.mjs'
import { CAPTURE_FIELDS, ENTITY_NAMES, ENTITY_TYPES, EXTERNAL_NAMES, EXTERNAL_TYPES, FIELD_NAMES, OBJECT_TYPES, SUBTYPE_NAMES, TYPE_NAMES } from '../src/archive.generated.js'
import { validateObject } from '../src/schema.js'
import { album, letter, photo } from './fixtures.js'

const archiveYaml = readFileSync(new URL('../../archive.yaml', import.meta.url), 'utf8')
const generated = render(archiveYaml)
const schema = JSON.parse(generated.schema)

describe('archive.yaml', () => {
  it('is reflected in the generated files; run `npm run generate` in core if not', () => {
    expect(readFileSync(new URL('../src/archive.generated.ts', import.meta.url), 'utf8')).toBe(generated.types)
    expect(readFileSync(new URL('../schema/object.schema.json', import.meta.url), 'utf8')).toBe(generated.schema)
  })

  it('lists the same object types in the schema as in the lists', () => {
    expect(schema.$defs.common.properties.type.enum).toEqual(Object.keys(OBJECT_TYPES))
  })

  it('has the kinds of external places', () => expect(EXTERNAL_TYPES).toEqual(['archive', 'platform', 'website']))
  it('has at least one entity type', () => expect(ENTITY_TYPES.length).toBeGreaterThan(0))

  it('gives every type, subtype, entity and external kind a German name', () => {
    for (const [type, subtypes] of Object.entries(OBJECT_TYPES)) {
      expect(TYPE_NAMES[type]).toBeTruthy()
      for (const subtype of subtypes) expect(SUBTYPE_NAMES[subtype]).toBeTruthy()
    }
    for (const entity of ENTITY_TYPES) expect(ENTITY_NAMES[entity]).toBeTruthy()
    for (const kind of EXTERNAL_TYPES) expect(EXTERNAL_NAMES[kind]).toBeTruthy()
  })

  it('names the fields people see, also those inside of others and the virtual one', () => {
    expect(FIELD_NAMES).toMatchObject({ title: 'Titel', recipient: 'Empfänger', holder: 'Aufbewahrung', reference: 'Signatur', members: 'Enthält' })
  })

  it('says which fields are filled in while capturing', () => {
    expect(CAPTURE_FIELDS.common.map((f) => f.name)).toEqual(['title', 'description', 'date', 'location', 'origin', 'original', 'owner', 'subjects', 'notes'])
    expect(CAPTURE_FIELDS.types.document).toEqual([{ name: 'recipient' }, { name: 'language', hint: 'e.g. "de"' }])
  })

  it('makes a schema that keeps the rules of the object types', () => {
    expect(validateObject(photo())).toEqual([])
    expect(validateObject(letter())).toEqual([])
    expect(validateObject(album())).toEqual([])
    expect(validateObject({ ...photo(), recipient: 'x' }).map((i) => i.path)).toEqual(['/recipient']) // only documents have it
    expect(schema.$comment).toMatch(/Generated from archive.yaml/)
  })

  it('makes the rules for the files from the types', () => {
    expect(schema.$defs.image_files).toMatchObject({ minItems: 1, maxItems: 1 })
    expect(schema.$defs.document_files.maxItems).toBeUndefined()
    expect(schema.$defs.document_files.items.allOf[1]).toEqual({ properties: { role: { const: 'page' } }, required: ['num'] })
    expect(schema.$defs.group.properties).toEqual({ files: false, storage: false, external: false })
  })

  describe('refuses', () => {
    const bad = (change: (text: string) => string) => () => render(change(archiveYaml))
    it('a file without object types', () => expect(() => render('entity_types: {person: Person}\n')).toThrow(/object_types/))
    it('a type without a German name', () => expect(bad((t) => t.replace('    label: Bild\n', ''))).toThrow(/image/))
    it('a bad subtype name', () => expect(bad((t) => t.replace('photo: Foto', 'Foto!: Foto'))).toThrow(/subtypes/))
    it('a subtype without a German name', () => expect(bad((t) => t.replace('photo: Foto', 'photo: ""'))).toThrow(/photo/))
    it('no entity types', () => expect(bad((t) => t.replace(/entity_types:[\s\S]*?\nexternal_types:/, 'external_types:'))).toThrow(/entity_types/))
    it('no external types', () => expect(bad((t) => t.replace(/external_types:[\s\S]*?\nvirtual_fields:/, 'virtual_fields:'))).toThrow(/external_types/))
    it('a type whose files have no role', () => expect(bad((t) => t.replace('role: main', 'rolle: main'))).toThrow(/files/))
    it('fields without a title', () => expect(bad((t) => t.replace(/\n  title:\n    label: Titel[\s\S]*?\n  description:/, '\n  description:'))).toThrow(/title/))
  })
})
