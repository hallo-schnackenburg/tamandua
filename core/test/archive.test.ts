import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import schema from '../schema/object.schema.json'
import { render } from '../scripts/generate.mjs'
import { ENTITY_TYPES, OBJECT_TYPES } from '../src/archive.generated.js'

const archiveYaml = readFileSync(new URL('../../archive.yaml', import.meta.url), 'utf8')

describe('archive.yaml', () => {
  it('is reflected in the generated file; run `npm run generate` in core if not', () => {
    const generated = readFileSync(new URL('../src/archive.generated.ts', import.meta.url), 'utf8')
    expect(generated).toBe(render(archiveYaml))
  })

  it('lists the same object types as the schema', () => {
    expect(schema.$defs.common.properties.type.enum).toEqual(Object.keys(OBJECT_TYPES))
  })

  it('has at least one entity type', () => expect(ENTITY_TYPES.length).toBeGreaterThan(0))

  it.each([
    ['no types', 'entity_types: [person]\n', /object_types/],
    ['a bad subtype', 'object_types:\n  image: [Foto!]\nentity_types: [person]\n', /image/],
    ['no entity types', 'object_types:\n  image: [photo]\n', /entity_types/],
  ])('refuses %s', (_name, text, message) => expect(() => render(text)).toThrow(message))
})
