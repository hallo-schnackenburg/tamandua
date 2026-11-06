import { parse } from 'yaml'
import { checkConsistency } from './consistency.js'
import { validateObject } from './schema.js'
import type { Issue } from './types.js'

/**
 * Full check of an object as it is written in a YAML file: syntax, schema, then
 * consistency. Consistency is only checked once the shape is valid, so one mistake
 * does not produce a pile of follow-up messages.
 */
export function validateObjectYaml(text: string): Issue[] {
  let data: unknown
  try {
    data = parse(text)
  } catch (error) {
    return [{ path: '/', message: `YAML syntax error: ${(error as Error).message}` }]
  }
  const shape = validateObject(data)
  return shape.length > 0 ? shape : checkConsistency(data)
}
