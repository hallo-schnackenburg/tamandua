import { describe, expect, it } from 'vitest'
import { BadRequest, buildModelRequest, parseChatRequest, toToolCalls, type ChatRequest } from '../src/chat.js'

const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  message: 'Brief, Autor Volker H.',
  files: [{ name: 'seite1.jpg' }, { name: 'seite2.jpg' }],
  objects: [],
  history: [],
  ...extra,
})

describe('parseChatRequest', () => {
  it('accepts a good request', () => {
    expect(parseChatRequest(request())).toEqual({
      ...request(),
      files: [{ name: 'seite1.jpg', object: undefined }, { name: 'seite2.jpg', object: undefined }],
    })
  })

  it.each([
    ['no object', null],
    ['empty message', { ...request(), message: '' }],
    ['huge message', { ...request(), message: 'x'.repeat(4001) }],
    ['files not a list', { ...request(), files: 'a' }],
    ['too many files', { ...request(), files: Array(101).fill({ name: 'a' }) }],
    ['bad history role', { ...request(), history: [{ role: 'system', text: 'x' }] }],
    ['object without text', { ...request(), objects: [{ number: 1 }] }],
  ])('rejects %s', (_, body) => {
    expect(() => parseChatRequest(body)).toThrow(BadRequest)
  })
})

describe('buildModelRequest', () => {
  it('takes the types from archive.yaml', () => {
    const built = buildModelRequest(request(), 'm')
    const create = built.tools.find((tool) => tool.name === 'create_object') as any
    expect(create.input_schema.properties.type.enum).toEqual(['image', 'document'])
    expect(create.input_schema.properties.subtype.enum).toContain('photo')
    expect(built.system).toContain('building')
  })

  it('names the fields to fill in from archive.yaml', () => {
    const { system } = buildModelRequest(request(), 'm')
    expect(system).toContain('Fields (YAML keys, in English): title, description, date, location, origin, original, owner, subjects, notes; documents also recipient and language (e.g. "de").')
  })

  it("tells the model today's date in the archive's time zone", () => {
    // 23:30 UTC on 8 November is already 9 November in Schnackenburg
    const built = buildModelRequest(request(), 'm', new Date('2026-11-08T23:30:00Z'))
    expect(built.messages[built.messages.length - 1].content).toContain('Today is 2026-11-09.')
  })

  it('forces a tool call and offers the three tools', () => {
    const built = buildModelRequest(request(), 'claude-haiku-5-5')
    expect(built.model).toBe('claude-haiku-5-5')
    expect(built.tool_choice).toEqual({ type: 'any' })
    expect(built.tools.map((t) => t.name)).toEqual(['create_object', 'patch', 'geocode', 'say'])
  })

  it('sends no sampling parameters, which Haiku 5.5 rejects', () => {
    const built = buildModelRequest(request(), 'claude-haiku-5-5') as Record<string, unknown>
    for (const name of ['temperature', 'top_p', 'top_k']) expect(built).not.toHaveProperty(name)
  })

  it('puts the files, the objects and the message into the last user turn', () => {
    const built = buildModelRequest(
      request({ files: [{ name: 'a.jpg', object: 3 }, { name: 'b.jpg' }], objects: [{ number: 3, text: 'title: X\n', issues: ['/date invalid'] }] }),
      'm',
    )
    const last = built.messages[built.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('a.jpg: belongs to Objekt 3')
    expect(last.content).toContain('b.jpg: no object yet')
    expect(last.content).toContain('Objekt 3 (open: /date invalid)')
    expect(last.content).toContain('title: X')
    expect(last.content).toContain('Brief, Autor Volker H.')
  })

  it('keeps the conversation alternating, starting with the user', () => {
    const built = buildModelRequest(
      request({
        history: [
          { role: 'assistant', text: 'status first' },
          { role: 'user', text: 'one' },
          { role: 'assistant', text: 'two' },
          { role: 'assistant', text: 'three' },
          { role: 'user', text: 'four' },
        ],
      }),
      'm',
    )
    expect(built.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(built.messages[1].content).toBe('two\n\nthree')
    expect(built.messages[2].content).toContain('four') // merged with the new message
  })
})

describe('toToolCalls', () => {
  const answer = (...content: unknown[]) => ({ content })

  it('drops placeholders the model made up for unknown values', () => {
    const calls = toToolCalls(
      answer(
        { type: 'tool_use', name: 'create_object', input: { type: 'document', fields: { title: 'test', date: '<UNKNOWN>' } } },
        { type: 'tool_use', name: 'patch', input: { object: 1, field: 'date', value: 'unbekannt' } },
      ),
    )
    const [create] = calls
    expect(create).toMatchObject({ tool: 'create_object', fields: { title: 'test' } })
    expect((create as { fields: object }).fields).not.toHaveProperty('date')
    expect(calls).toHaveLength(1) // the patch with a placeholder value is dropped
  })

  it('converts tool calls', () => {
    expect(
      toToolCalls(
        answer(
          { type: 'tool_use', name: 'create_object', input: { type: 'document', subtype: 'letter', together: true, fields: { origin: { name: 'Volker H.' } } } },
          { type: 'tool_use', name: 'patch', input: { object: 3, field: 'title', value: 'X', old: 'Y' } },
          { type: 'tool_use', name: 'say', input: { text: 'Hallo' } },
        ),
      ),
    ).toEqual([
      { tool: 'create_object', type: 'document', subtype: 'letter', together: true, fields: { origin: { name: 'Volker H.' } } },
      { tool: 'patch', object: 3, field: 'title', value: 'X', old: 'Y' },
      { tool: 'say', text: 'Hallo' },
    ])
  })

  it('converts a geocode call and drops one that is incomplete', () => {
    expect(
      toToolCalls(
        answer(
          { type: 'tool_use', name: 'geocode', input: { object: 3, for: 'object', query: ' Aussichtsturm, Schnackenburg ' } },
          { type: 'tool_use', name: 'geocode', input: { object: 3, for: 'subject', subject: 'Turm', query: 'Turm' } },
          { type: 'tool_use', name: 'geocode', input: { object: 3, for: 'subject', query: 'Turm' } }, // no name of the subject
          { type: 'tool_use', name: 'geocode', input: { object: 3, for: 'somewhere', query: 'Turm' } },
          { type: 'tool_use', name: 'say', input: { text: 'ok' } },
        ),
      ),
    ).toEqual([
      { tool: 'geocode', object: 3, for: 'object', subject: undefined, query: 'Aussichtsturm, Schnackenburg' },
      { tool: 'geocode', object: 3, for: 'subject', subject: 'Turm', query: 'Turm' },
      { tool: 'say', text: 'ok' },
    ])
  })

  it('leaves out a subtype that does not belong to the type', () => {
    const calls = toToolCalls(answer({ type: 'tool_use', name: 'create_object', input: { type: 'image', subtype: 'letter' } }))
    expect(calls).toEqual([{ tool: 'create_object', type: 'image', subtype: undefined, together: undefined, fields: undefined }])
  })

  it('passes objects and lists of objects as values', () => {
    const value = [{ name: 'Haus', type: 'building' }]
    const calls = toToolCalls(answer({ type: 'tool_use', name: 'patch', input: { object: 1, field: 'subjects', value, old: [] } }))
    expect(calls).toEqual([{ tool: 'patch', object: 1, field: 'subjects', value, old: [] }])
  })

  it('turns plain text into a say call', () => {
    expect(toToolCalls(answer({ type: 'text', text: ' Hi ' }))).toEqual([{ tool: 'say', text: 'Hi' }])
  })

  it('drops calls that make no sense and falls back to a question', () => {
    const calls = toToolCalls(
      answer(
        { type: 'tool_use', name: 'create_object', input: { type: 'book' } },
        { type: 'tool_use', name: 'patch', input: { object: 'one', field: 'title', value: 'x' } },
        { type: 'tool_use', name: 'delete_everything', input: {} },
      ),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('say')
  })

  it('survives garbage', () => {
    expect(toToolCalls(null)[0].tool).toBe('say')
    expect(toToolCalls({ content: 'x' })[0].tool).toBe('say')
  })
})

describe('objects that live elsewhere', () => {
  const answer = (...content: unknown[]) => ({ content })
  const place = { uri: 'https://www.deutsche-digitale-bibliothek.de/item/ABC', site: 'Deutsche Digitale Bibliothek', type: 'archive' }

  it('takes the places of a created object', () => {
    const calls = toToolCalls(
      answer({ type: 'tool_use', name: 'create_object', input: { type: 'image', subtype: 'photo', fields: { title: 'Mühle am Aland' }, external: [place] } }),
    )
    expect(calls).toEqual([{ tool: 'create_object', type: 'image', subtype: 'photo', fields: { title: 'Mühle am Aland' }, external: [place] }])
  })

  it('leaves out an address that is none and values that are made up, but keeps the rest of a place', () => {
    const calls = toToolCalls(
      answer({
        type: 'tool_use',
        name: 'create_object',
        input: {
          type: 'image',
          external: [
            { uri: 'Arcinsys Nr. 5' },
            { uri: 'https://example.org/a', site: '<UNKNOWN>', reference: ' Hann. 180 ', retrieved: 'gestern' },
            { site: 'Wendlandarchiv', type: 'archive' },
          ],
        },
      }),
    )
    expect((calls[0] as any).external).toEqual([
      { uri: 'https://example.org/a', reference: 'Hann. 180' },
      { site: 'Wendlandarchiv', type: 'archive' },
    ])
  })

  it('has no places when none are usable', () => {
    const calls = toToolCalls(answer({ type: 'tool_use', name: 'create_object', input: { type: 'image', external: [{ uri: 'nope' }] } }))
    expect((calls[0] as any).external).toBeUndefined()
  })

  it('lets the model know about them', () => {
    const built = buildModelRequest(request({ files: [], message: 'extern: https://example.org/a' }), 'm')
    expect(built.system).toContain('lives somewhere else')
    expect(built.system).toContain('archive, platform, website')
    const create = built.tools.find((tool) => tool.name === 'create_object') as any
    expect(create.input_schema.properties.external.items.required).toBeUndefined() // not even the address is required
  })

  it('says plainly when no object is part of the context, and warns against creating one for "das Objekt"', () => {
    const none = buildModelRequest(request({ files: [], objects: [], message: 'Das Objekt ist extern' }), 'm')
    expect(String(none.messages[none.messages.length - 1].content)).toContain('Objects this message is about:\n(none)')
    expect(none.system).toContain('NO object is part of the context')
    expect(none.system).toContain('never a reason to create one')
    const some = buildModelRequest(request({ files: [], objects: [{ number: 2, text: 'id: x', issues: [] }] }), 'm')
    expect(String(some.messages[some.messages.length - 1].content)).toContain('Objekt 2')
  })

  it('lets an object come without a type (no files), and keeps the prompt soft', () => {
    const external = [{ site: 'YouTube', type: 'platform' }]
    const kept = toToolCalls(answer({ type: 'tool_use', name: 'create_object', input: { fields: { title: 'Schützenfest 1963' }, external } }))
    expect(kept[0]).toMatchObject({ tool: 'create_object', fields: { title: 'Schützenfest 1963' }, external })
    expect((kept[0] as any).type).toBeUndefined()
    const empty = toToolCalls(answer({ type: 'tool_use', name: 'create_object', input: { fields: { title: 'x' } } }))
    expect(empty[0]).toMatchObject({ tool: 'create_object', fields: { title: 'x' } })
    const { system } = buildModelRequest(request(), 'm')
    expect(system).toContain('Never point the user to a "+" button')
    expect(system).toContain('never demand')
    expect(system).not.toContain('adds an empty object')
    const create = buildModelRequest(request(), 'm').tools.find((tool) => tool.name === 'create_object') as any
    expect(create.input_schema.required).toBeUndefined()
  })

  it('tells the model to act at once and to leave old out for empty fields', () => {
    const { system } = buildModelRequest(request(), 'm')
    expect(system).toContain('Do what you can at once')
    expect(system).toContain('leave "old" out')
  })
})
