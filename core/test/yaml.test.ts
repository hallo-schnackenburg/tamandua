import { describe, expect, it } from 'vitest'
import { validateObjectYaml } from '../src/yaml.js'
import { file, sha } from './fixtures.js'
import { stringify } from 'yaml'

describe('validateObjectYaml', () => {
  const yaml = (extra: string): string => `
id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: photo
title: Schützenumzug
${extra}
files:
${stringify([file('main', 'a')]).replace(/^/gm, '  ')}`

  it('accepts a quoted date', () => {
    expect(validateObjectYaml(yaml('date: "1963-07-14"'))).toEqual([])
  })

  it('explains an unquoted year', () => {
    const issues = validateObjectYaml(yaml('date: 1963'))
    expect(issues.map((i) => i.message)).toEqual(['date must be text; put it in quotes, e.g. date: "1963"'])
  })

  it('reports broken syntax as one issue', () => {
    const issues = validateObjectYaml('title: [unclosed')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/^YAML syntax error/)
  })

  it('reports consistency problems once the shape is valid', () => {
    const text = yaml('').replace(`files/aa/aa/${sha('a')}`, `files/bb/bb/${sha('a')}`)
    const issues = validateObjectYaml(text)
    expect(issues[0].message).toMatch(/path does not match sha256/)
  })
})
