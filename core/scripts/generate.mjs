// Turns archive.yaml (in the repository root) into src/archive.generated.ts, so that
// the app, the worker and the tests all read the same lists of types.
// Run it with `npm run generate` after changing archive.yaml.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const SOURCE = new URL('../../archive.yaml', import.meta.url)
const TARGET = new URL('../src/archive.generated.ts', import.meta.url)

const isNames = (x) => Array.isArray(x) && x.every((n) => typeof n === 'string' && /^[a-z][a-z0-9_]*$/.test(n))
const list = (names) => `[${names.map((n) => `'${n}'`).join(', ')}]`

/** The text of the generated file for the text of archive.yaml. */
export function render(yamlText) {
  const data = parse(yamlText)
  const types = data?.object_types
  if (typeof types !== 'object' || types === null || Array.isArray(types) || Object.keys(types).length === 0) {
    throw new Error('archive.yaml: object_types must list the object types, each with its subtypes.')
  }
  for (const [type, subtypes] of Object.entries(types)) {
    if (!isNames([type]) || !isNames(subtypes ?? [])) {
      throw new Error(`archive.yaml: object_types.${type} must be a list of lower-case names.`)
    }
  }
  if (!Array.isArray(data.entity_types) || data.entity_types.length === 0 || !isNames(data.entity_types)) {
    throw new Error('archive.yaml: entity_types must be a list of lower-case names.')
  }

  const lines = Object.entries(types).map(([type, subtypes]) => `  ${type}: ${list(subtypes ?? [])},`)
  return `// Generated from archive.yaml by \`npm run generate\` in core. Do not edit.

export const OBJECT_TYPES = {
${lines.join('\n')}
} as const

export type ObjectType = keyof typeof OBJECT_TYPES

export const ENTITY_TYPES = ${list(data.entity_types)} as const
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(TARGET, render(readFileSync(SOURCE, 'utf8')))
  console.log('Wrote core/src/archive.generated.ts')
}
