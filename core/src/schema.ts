// Checks one object (already parsed from YAML) against the JSON Schema and turns
// the validator's errors into short, readable issues.

import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import schema from '../schema/object.schema.json'
import type { Issue } from './types.js'

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(schema)

function child(path: string, key: string): string {
  return path === '/' ? `/${key}` : `${path}/${key}`
}

function toIssue(error: ErrorObject): Issue {
  const path = error.instancePath || '/'
  const params = error.params as Record<string, unknown>
  switch (error.keyword) {
    case 'unevaluatedProperties':
      return { path: child(path, String(params.unevaluatedProperty)), message: `unknown field "${params.unevaluatedProperty}"` }
    case 'additionalProperties':
      return { path: child(path, String(params.additionalProperty)), message: `unknown field "${params.additionalProperty}"` }
    case 'required':
      return { path, message: `missing field "${params.missingProperty}"` }
    case 'enum':
      return { path, message: `must be one of: ${(params.allowedValues as unknown[]).join(', ')}` }
    case 'const':
      return { path, message: `must be "${params.allowedValue}"` }
    case 'type':
      if (path.endsWith('/date')) {
        return { path, message: 'date must be text; put it in quotes, e.g. date: "1963"' }
      }
      return { path, message: `must be ${params.type}` }
    case 'pattern':
      if (path.endsWith('/date')) {
        return { path, message: 'not a valid date; use e.g. "1963", "1963-07-14", "196X", "1960/1969"' }
      }
      return { path, message: error.message ?? 'invalid' }
    default:
      return { path, message: error.message ?? 'invalid' }
  }
}

/** Returns an empty list if the object is valid. */
export function validateObject(data: unknown): Issue[] {
  if (validate(data)) return []
  const errors = (validate.errors ?? []).filter((e) => e.keyword !== 'if')
  return errors.map(toIssue)
}
