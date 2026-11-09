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

// An unknown field stays an error even when it is empty ("titlez:"): it is not a field that waits to be filled in.
const UNKNOWN = /^unknown field /

const unfilled = (text: string, issue: Issue) => MISSING.test(issue.message) || (!UNKNOWN.test(issue.message) && isEmpty(text, issue.path))

type Result = { state: Validity; hint: string }

// The same text is asked for again and again (once per tile, once per row, on every redraw): remember the answers.
const known = new Map<string, Result>()

export function validityOf(text: string): Result {
  const hit = known.get(text)
  if (hit) return hit
  const result = check(text)
  if (known.size >= 300) known.delete(known.keys().next().value as string)
  known.set(text, result)
  return result
}

function check(text: string): Result {
  const issues = validateObjectYaml(text)
  if (issues.length === 0) return { state: 'valid', hint: VALIDITY_NAMES.valid }
  const state: Validity = issues.every((issue) => unfilled(text, issue)) ? 'incomplete' : 'invalid'
  const shown = issues.slice(0, 3).map((issue) => (issue.path === '/' ? issue.message : `${issue.path}: ${issue.message}`))
  return { state, hint: `${VALIDITY_NAMES[state]}: ${shown.join('; ')}${issues.length > 3 ? '; …' : ''}` }
}
