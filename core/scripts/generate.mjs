// Turns archive.yaml (in the repository root) into the files the rest of the code reads:
//   schema/object.schema.json    the JSON Schema of an object (checked with Ajv in src/schema.ts)
//   src/archive.generated.ts     the lists of types, the German names, the fields that are filled in while capturing
// so that the app, the worker, the checks and the tests all share one model. Run it with `npm run generate`
// after changing archive.yaml.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const SOURCE = new URL('../../archive.yaml', import.meta.url)
const TYPES = new URL('../src/archive.generated.ts', import.meta.url)
const SCHEMA = new URL('../schema/object.schema.json', import.meta.url)

const NAME = /^[a-z][a-z0-9_]*$/
const isRecord = (x) => typeof x === 'object' && x !== null && !Array.isArray(x)
const fail = (message) => {
  throw new Error(`archive.yaml: ${message}`)
}

/** A map of lower-case names to German names (the names alone are not enough: people see the German ones). */
function names(value, where) {
  if (!isRecord(value) || Object.keys(value).length === 0) fail(`${where} must list names with their German names.`)
  for (const [key, label] of Object.entries(value)) {
    if (!NAME.test(key)) fail(`${where}: "${key}" must be a lower-case name.`)
    if (typeof label !== 'string' || !label) fail(`${where}.${key} needs a German name.`)
  }
  return value
}

/** The schema of a field or of a part of one: the keys that only serve people (`label`) are left out, everywhere inside. */
function clean(node) {
  if (Array.isArray(node)) return node.map(clean)
  if (!isRecord(node)) return node
  return Object.fromEntries(Object.entries(node).filter(([key, value]) => !(key === 'label' && typeof value === 'string')).map(([key, value]) => [key, clean(value)]))
}

/** Every `label` inside the schema of a definition, by the name of the property it is on. */
function propertyLabels(node, found = {}) {
  if (Array.isArray(node)) node.forEach((n) => propertyLabels(n, found))
  else if (isRecord(node)) {
    if (isRecord(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) if (isRecord(value) && typeof value.label === 'string') found[key] = value.label
    }
    Object.values(node).forEach((n) => propertyLabels(n, found))
  }
  return found
}

const ref = (name) => ({ $ref: `#/$defs/${name}` })
const isType = (type) => ({ if: { properties: { type: { const: type } }, required: ['type'] } })

/** The checked content of archive.yaml. */
export function read(yamlText) {
  const data = parse(yamlText)
  if (!isRecord(data)) fail('the file must be a mapping.')
  if (!isRecord(data.object_types) || Object.keys(data.object_types).length === 0) fail('object_types must list the object types, each with its subtypes.')
  const types = {}
  for (const [type, entry] of Object.entries(data.object_types)) {
    if (!NAME.test(type) || !isRecord(entry) || typeof entry.label !== 'string') fail(`object_types.${type} needs a lower-case name and a label.`)
    const subtypes = entry.subtypes === undefined ? {} : isRecord(entry.subtypes) ? names(entry.subtypes, `object_types.${type}.subtypes`) : fail(`object_types.${type}.subtypes must list names with their German names.`)
    if (entry.files !== false && !(isRecord(entry.files) && typeof entry.files.role === 'string')) fail(`object_types.${type}.files must name the role of its files, or be false.`)
    for (const [field, spec] of Object.entries(entry.fields ?? {})) {
      if (!NAME.test(field) || !isRecord(spec) || !isRecord(spec.schema)) fail(`object_types.${type}.fields.${field} needs a schema.`)
    }
    types[type] = { ...entry, subtypes }
  }
  const fields = data.fields
  if (!isRecord(fields) || !['id', 'type', 'title'].every((f) => isRecord(fields[f]))) fail('fields must at least have id, type and title.')
  for (const [field, spec] of Object.entries(fields)) if (!NAME.test(field) || !isRecord(spec.schema)) fail(`fields.${field} needs a schema.`)
  if (!isRecord(data.defs)) fail('defs must hold the building blocks of the fields.')
  return {
    schema: isRecord(data.schema) ? data.schema : fail('schema needs an id, a title and a description.'),
    types,
    entities: names(data.entity_types, 'entity_types'),
    externals: names(data.external_types, 'external_types'),
    virtual: data.virtual_fields === undefined ? {} : names(data.virtual_fields, 'virtual_fields'),
    fields,
    defs: data.defs,
  }
}

/** The JSON Schema of an object. */
export function schemaOf(model) {
  const { types, fields, defs } = model
  const stored = Object.entries(types).filter(([, t]) => t.files)
  const grouped = Object.entries(types).filter(([, t]) => t.files === false)
  const withFields = Object.entries(types).filter(([, t]) => t.fields && Object.keys(t.fields).length > 0)

  const $defs = {
    common: {
      properties: Object.fromEntries(
        Object.entries(fields).map(([name, spec]) => [name, name === 'type' ? { ...clean(spec.schema), enum: Object.keys(types) } : clean(spec.schema)]),
      ),
    },
  }
  for (const [type, t] of grouped) {
    $defs[type] = { description: t.description, properties: { files: false, storage: false, external: false } }
  }
  $defs.stored_here = {
    description: 'The content lives in our object store (storage: local, the default): the files are the object.',
    required: ['files'],
    properties: { external: false },
    allOf: stored.map(([type]) => ({ ...isType(type), then: { properties: { files: ref(`${type}_files`) } } })),
  }
  $defs.stored_elsewhere = clean(defs.stored_elsewhere)
  for (const [type, t] of withFields) {
    $defs[type] = { properties: Object.fromEntries(Object.entries(t.fields).map(([name, spec]) => [name, clean(spec.schema)])) }
  }
  for (const [type, t] of stored) {
    const { role, max, numbered, description } = t.files
    $defs[`${type}_files`] = {
      description,
      type: 'array',
      minItems: 1,
      ...(max ? { maxItems: max } : {}),
      items: { allOf: [ref('file'), { properties: { role: { const: role } }, ...(numbered ? { required: ['num'] } : {}) }] },
    }
  }
  for (const [name, def] of Object.entries(defs)) if (!(name in $defs)) $defs[name] = clean(def)

  const storage = {
    if: { properties: { storage: { const: 'external' } }, required: ['storage'] },
    then: ref('stored_elsewhere'),
    else: ref('stored_here'),
  }
  const allOf = [ref('common')]
  if (grouped.length === 1) allOf.push({ ...isType(grouped[0][0]), then: ref(grouped[0][0]), else: storage })
  else allOf.push(storage)
  for (const [type] of withFields) allOf.push({ ...isType(type), then: ref(type) })

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: model.schema.id,
    $comment: 'Generated from archive.yaml by `npm run generate` in core. Do not edit.',
    title: model.schema.title,
    description: model.schema.description,
    type: 'object',
    required: Object.entries(fields).filter(([, spec]) => spec.required).map(([name]) => name),
    allOf,
    unevaluatedProperties: false,
    $defs,
  }
}

const list = (items) => `[${items.map((n) => `'${n}'`).join(', ')}]`
const text = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const record = (map) => `{\n${Object.entries(map).map(([key, label]) => `  ${key}: ${text(label)},`).join('\n')}\n}`

/** The text of the generated TypeScript file. */
export function typesOf(model) {
  const { types, entities, externals, virtual, fields } = model
  const subtypeNames = Object.assign({}, ...Object.values(types).map((t) => t.subtypes))
  const typeNames = Object.fromEntries(Object.entries(types).map(([type, t]) => [type, t.label]))
  const fieldNames = { ...virtual }
  const typeFields = Object.entries(types).flatMap(([type, t]) => Object.entries(t.fields ?? {}).map(([name, spec]) => ({ type, name, spec })))
  for (const [name, spec] of Object.entries(fields)) if (typeof spec.label === 'string') fieldNames[name] = spec.label
  for (const { name, spec } of typeFields) if (typeof spec.label === 'string') fieldNames[name] = spec.label
  Object.assign(fieldNames, propertyLabels(model.defs))
  const capture = ({ name, spec }) => `{ name: '${name}'${spec.hint ? `, hint: ${text(spec.hint)}` : ''} }`
  const common = Object.entries(fields).filter(([, spec]) => spec.capture).map(([name, spec]) => ({ name, spec }))
  const own = Object.entries(types)
    .map(([type, t]) => [type, Object.entries(t.fields ?? {}).filter(([, spec]) => spec.capture).map(([name, spec]) => ({ name, spec }))])
    .filter(([, list]) => list.length > 0)

  return `// Generated from archive.yaml by \`npm run generate\` in core. Do not edit.

export const OBJECT_TYPES = {
${Object.entries(types).map(([type, t]) => `  ${type}: ${list(Object.keys(t.subtypes))},`).join('\n')}
} as const

export type ObjectType = keyof typeof OBJECT_TYPES

export const ENTITY_TYPES = ${list(Object.keys(entities))} as const

export const EXTERNAL_TYPES = ${list(Object.keys(externals))} as const

// The German names people see.
export const TYPE_NAMES: Record<string, string> = ${record(typeNames)}

export const SUBTYPE_NAMES: Record<string, string> = ${record(subtypeNames)}

export const FIELD_NAMES: Record<string, string> = ${record(fieldNames)}

export const ENTITY_NAMES: Record<string, string> = ${record(entities)}

export const EXTERNAL_NAMES: Record<string, string> = ${record(externals)}

/** The fields that are filled in while capturing: those of every object, and those only some types have. */
export interface CaptureField {
  name: string
  hint?: string
}

export const CAPTURE_FIELDS: { common: CaptureField[]; types: Record<string, CaptureField[]> } = {
  common: [${common.map(capture).join(', ')}],
  types: {
${own.map(([type, fields]) => `    ${type}: [${fields.map(capture).join(', ')}],`).join('\n')}
  },
}
`
}

/** Both generated files, as text, for the text of archive.yaml. */
export function render(yamlText) {
  const model = read(yamlText)
  return { types: typesOf(model), schema: `${JSON.stringify(schemaOf(model), null, 2)}\n` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { types, schema } = render(readFileSync(SOURCE, 'utf8'))
  writeFileSync(TYPES, types)
  writeFileSync(SCHEMA, schema)
  console.log('Wrote core/src/archive.generated.ts and core/schema/object.schema.json')
}
