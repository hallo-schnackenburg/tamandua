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
