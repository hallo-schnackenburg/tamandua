// Small valid objects, built with the real path functions so that they are
// consistent. Tests change one thing at a time and check the result.

import { originalPath, variantPath } from '../src/paths.js'

export const sha = (c: string): string => c.repeat(64)

type Obj = Record<string, any>

export function file(role: string, c: string, extra: Obj = {}): Obj {
  return {
    role,
    path: originalPath(sha(c), 'tif'),
    sha256: sha(c),
    mime: 'image/tiff',
    bytes: 18204331,
    width: 4961,
    height: 7016,
    ...extra,
  }
}

export function preview(originalChar: string, c: string): Obj {
  return {
    kind: 'preview',
    path: variantPath(sha(originalChar), { name: 'preview-400', sha256: sha(c), ext: 'jpg' }),
    sha256: sha(c),
    mime: 'image/jpeg',
    bytes: 48211,
    width: 400,
    height: 566,
    generator: { name: 'browser-canvas', version: '1' },
  }
}

export function photo(): Obj {
  return {
    id: '01JC8Z3Q7M5K2V9X4T6R1B0N8D',
    type: 'photo',
    title: 'Schützenumzug am Marktplatz',
    date: '1963-07',
    location: 'Schnackenburg, Marktplatz',
    geocode: { lat: 52.9928, lon: 11.5689, precision: 'street' },
    people: ['Heinrich Meyer', 'Erna Schulz'],
    files: [file('main', 'a', { variants: [preview('a', 'b')] })],
  }
}

export function letter(): Obj {
  return {
    id: '01JC8Z4A2P0H7W3E5S9Y6F1G2C',
    type: 'document',
    subtype: 'letter',
    title: 'Brief an die Schwester',
    date: '1923-05-14',
    language: 'de',
    files: [file('page', 'c', { seq: 1 }), file('page', 'd', { seq: 2 })],
  }
}

export const clone = <T>(x: T): T => structuredClone(x)
