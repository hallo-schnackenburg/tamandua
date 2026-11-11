import { describe, expect, it } from 'vitest'
import { formatDate } from '../src/dates.js'

describe('formatDate', () => {
  it.each([
    ['1963', '1963'],
    ['1963-07', 'Juli 1963'],
    ['1963-07-14', '14. Juli 1963'],
    ['1923-05-04', '4. Mai 1923'],
    ['1963-XX-XX', '1963'],
    ['1963-07-XX', 'Juli 1963'],
    ['196X', '1960er'],
    ['19XX', '20. Jahrhundert'],
    ['1963?', '1963 (unsicher)'],
    ['1963-05~', 'ca. Mai 1963'],
    ['1963%', 'ca. 1963 (unsicher)'],
    ['1960/1969', '1960 – 1969'],
    ['1963-05/1963-08', 'Mai 1963 – August 1963'],
    ['1950?/1970', '1950 (unsicher) – 1970'],
  ])('%s is read as "%s"', (edtf, words) => expect(formatDate(edtf)).toBe(words))

  it('gives back what it does not know', () => {
    for (const odd of ['um 1900', '1963-13', '1963-07-45', '', '1960/1965/1970', 'nach 1950']) expect(formatDate(odd)).toBe(odd)
  })
})
