import { describe, expect, it } from 'vitest'
import { entryOf } from '../src/database.svelte.js'

const record = (text: string, data?: Record<string, unknown>) => ({ path: 'objects/ZH/X.yaml', id: 'X', sha: 's', text, data })

describe('entryOf', () => {
  it('takes what the list shows from the parsed data', () => {
    const entry = entryOf(record('', { type: 'image', subtype: 'print', title: 'Fähre über die Elbe', date: 1790, storage: 'external', external: [{ site: 'Archiv X' }] }))
    expect(entry).toMatchObject({ type: 'image', subtype: 'print', title: 'Fähre über die Elbe', date: '1790', external: true, folded: 'fahre uber die elbe' })
    expect(entry.place).toBe('Archiv X')
  })

  it('parses the text only when there is no data, and copes with text that is not YAML', () => {
    expect(entryOf(record('title: Brief\ntype: letter\n')).title).toBe('Brief')
    expect(entryOf(record(': : :\n\t- [')).title).toBe('')
  })
})
