import { describe, expect, it } from 'vitest'
import { migrateHolder } from '../scripts/migrate-holder.js'
import { validateObjectYaml } from '../src/index.js'

const before = `id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: image
title: Fähre
origin:
  name: Karl Lemke
  type: person
holder:
  name: Stadtarchiv Schnackenburg
  type: business
  location: Schnackenburg
owner:
  name: Familie Müller
`

describe('migrateHolder', () => {
  it('moves the holder into original, in the same place, and changes nothing else', () => {
    expect(migrateHolder(before)).toBe(`id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: image
title: Fähre
origin:
  name: Karl Lemke
  type: person
original:
  holder:
    name: Stadtarchiv Schnackenburg
    type: business
    location: Schnackenburg
owner:
  name: Familie Müller
`)
  })

  it('leaves an object without holder alone, and the result of a migration', () => {
    expect(migrateHolder('id: x\ntitle: y\n')).toBeUndefined()
    expect(migrateHolder(migrateHolder(before)!)).toBeUndefined()
  })

  it('refuses an object that has both', () => {
    expect(() => migrateHolder('holder:\n  name: a\noriginal:\n  reference: b\n')).toThrow(/both/)
  })

  it('keeps the long lines as they are', () => {
    const long = `title: x\ndescription: ${'word '.repeat(40).trim()}\nholder:\n  name: a\n`
    expect(migrateHolder(long)).toContain(`description: ${'word '.repeat(40).trim()}\n`)
  })

  it('makes the object schema-valid where holder was the only problem', () => {
    const text = `id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D\ntype: group\ntitle: Album\nholder:\n  name: Stadtarchiv\n`
    expect(validateObjectYaml(text).map((i) => i.message)).toContain('unknown field "holder"')
    expect(validateObjectYaml(migrateHolder(text)!)).toEqual([])
  })
})
