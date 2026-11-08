import { readValue, validateObjectYaml, type Issue } from '@tamandua/core'

/**
 * How far an object is from being fit to submit:
 * - valid: passes the schema and the consistency checks,
 * - incomplete: the only problems are missing or empty fields (normal while capturing),
 * - invalid: something is wrong (broken YAML, wrong type, unknown field, ...).
 */
export type Validity = 'valid' | 'incomplete' | 'invalid'

export const VALIDITY_NAMES: Record<Validity, string> = { valid: 'Gültig', incomplete: 'Unvollständig', invalid: 'Fehlerhaft' }

const MISSING = /^missing field |fewer than \d+ (characters|items)/

// A field that is there but left empty ("title:") counts as not filled in yet, just like a missing one.
function isEmpty(text: string, path: string): boolean {
  const [first, ...rest] = path.split('/').filter(Boolean)
  if (!first) return false
  let value = readValue(text, first)
  for (const part of rest) {
    if (value === null || typeof value !== 'object') break
    value = (value as Record<string, unknown>)[part]
  }
  // readValue gives undefined for a field that is there but empty, so undefined counts too (a type error cannot come from a missing field).
  return value === null || value === undefined || value === ''
}

const unfilled = (text: string, issue: Issue) => MISSING.test(issue.message) || isEmpty(text, issue.path)

export function validityOf(text: string): { state: Validity; hint: string } {
  const issues = validateObjectYaml(text)
  if (issues.length === 0) return { state: 'valid', hint: VALIDITY_NAMES.valid }
  const state: Validity = issues.every((issue) => unfilled(text, issue)) ? 'incomplete' : 'invalid'
  const shown = issues.slice(0, 3).map((issue) => (issue.path === '/' ? issue.message : `${issue.path}: ${issue.message}`))
  return { state, hint: `${VALIDITY_NAMES[state]}: ${shown.join('; ')}${issues.length > 3 ? '; …' : ''}` }
}
