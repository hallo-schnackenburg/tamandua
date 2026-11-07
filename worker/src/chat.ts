// The chat request to the model: what we send, and how the answer becomes tool calls.
// Nothing here touches the network, so it can be tested on its own.

import { ENTITY_TYPES, OBJECT_TYPES, type ObjectType } from '@archive/core/archive'

/** What the browser sends. The YAML texts come without the `files` list (hashes are noise for the model). */
export interface ChatRequest {
  message: string
  files: { name: string; object?: number }[]
  objects: { number: number; text: string; issues: string[] }[]
  history: { role: 'user' | 'assistant'; text: string }[]
}

/** The same calls the app's agent interface returns. */
export type ToolCall =
  | { tool: 'create_object'; type: ObjectType; subtype?: string; together?: boolean; fields?: Record<string, unknown> }
  | { tool: 'patch'; object: number; field: string; value: unknown; old?: unknown }
  | { tool: 'say'; text: string }

export class BadRequest extends Error {}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Checks what the browser sent. Also keeps a request from becoming very expensive. */
export function parseChatRequest(data: unknown): ChatRequest {
  if (!isRecord(data)) throw new BadRequest('Body must be a JSON object.')
  const { message, files, objects, history } = data
  if (typeof message !== 'string' || message.length === 0 || message.length > 4000) throw new BadRequest('message: text of 1 to 4000 characters expected.')
  if (!Array.isArray(files) || files.length > 100) throw new BadRequest('files: list of at most 100 expected.')
  if (!Array.isArray(objects) || objects.length > 100) throw new BadRequest('objects: list of at most 100 expected.')
  if (!Array.isArray(history) || history.length > 30) throw new BadRequest('history: list of at most 30 expected.')

  return {
    message,
    files: files.map((f) => {
      if (!isRecord(f) || typeof f.name !== 'string') throw new BadRequest('files: {name, object?} expected.')
      return { name: f.name.slice(0, 200), object: typeof f.object === 'number' ? f.object : undefined }
    }),
    objects: objects.map((o) => {
      if (!isRecord(o) || typeof o.number !== 'number' || typeof o.text !== 'string' || o.text.length > 20000) {
        throw new BadRequest('objects: {number, text, issues} expected.')
      }
      const issues = Array.isArray(o.issues) ? o.issues.filter((i): i is string => typeof i === 'string').slice(0, 20) : []
      return { number: o.number, text: o.text, issues }
    }),
    history: history.map((h) => {
      if (!isRecord(h) || (h.role !== 'user' && h.role !== 'assistant') || typeof h.text !== 'string') {
        throw new BadRequest('history: {role, text} expected.')
      }
      return { role: h.role, text: h.text.slice(0, 2000) }
    }),
  }
}

const TYPE_LIST = Object.entries(OBJECT_TYPES)
  .map(([type, subtypes]) => `"${type}"${subtypes.length ? ` (subtypes: ${subtypes.join(', ')})` : ''}`)
  .join(', ')
const SUBTYPES = [...new Set(Object.values(OBJECT_TYPES).flat())]

export const SYSTEM_PROMPT = `You help volunteers of a town archive (Stadtarchiv Schnackenburg) to describe scanned images and documents.
For every message you answer ONLY by calling tools. The app carries them out; you never change anything yourself.

Context you get with each message: the files the message is about, and for files that already belong to an object, that object's current YAML.

Tools:
- create_object: for files that belong to no object yet. type is one of: ${TYPE_LIST}. An image is always one object per file. A document takes all files as pages of ONE object (together true); set together false only if the user clearly means separate documents ("drei Briefe", "jeweils ein Brief"). Set subtype only when it is clear; otherwise leave it out. Put everything the user said into fields.
- patch: change one field of an existing object (by its number). Pass the value you saw as "old" (leave it out if the field was not there), so that nothing the user typed in the meantime is overwritten.
- say: answer or ask a short question. Use it when something is unclear, when the user asks something, or in addition to other calls if you must point something out.

Fields (YAML keys, in English): title, description, date, location, origin, subjects, notes; documents also recipient and language (e.g. "de").
- date is EDTF text: "1965", "1965-01", "1965-01-03", "196X" (decade), "1960/1969" (range), a trailing "?" for uncertain, "~" for approximate. Always as text.
- location is the place the object relates to for the archive, shown on the map: where a photo was taken, where a shown thing stands today. Free text, e.g. "Schnackenburg, Marktplatz".
- origin is who made the object and where, as an object {name, type, location}: for a photo the photographer and the place, for a letter the sender and the place, for a brochure the company and its seat. Example: {"name": "Max Ketterer", "type": "business", "location": "Leipzig-Reudnitz"}. It is not where the object was found; put that into notes.
- subjects is a list of the things the object shows or mentions, each {name, type, note, location}: people, places, buildings, businesses, events, things. type is one of: ${ENTITY_TYPES.join(', ')}. Example: [{"name": "Konditorei Müller", "type": "business", "note": "am Markt"}]. To add one, send the whole list as value and the current list as old.
- A two-digit year such as "65" means 1965 in this archive; say so briefly with a say call when you assume it.
- Write names and places as the user gave them. Do not invent facts (no guessed dates, names or titles). Leave out what the user did not say.
- Several objects at once: if the user's message applies to all of them, issue one patch per object.
- Always answer in German, short and friendly, addressing the user with "du".`

const VALUE = {
  anyOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: true },
    { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } },
  ],
}

export const TOOLS = [
  {
    name: 'create_object',
    description: 'Create an object from the files that have none yet.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: Object.keys(OBJECT_TYPES) },
        subtype: { type: 'string', enum: SUBTYPES, description: 'Only if clear. Must belong to the type.' },
        together: { type: 'boolean', description: 'Documents: all files are pages of one object (default true).' },
        fields: {
          type: 'object',
          description: 'Initial fields, e.g. {"title": "...", "date": "1965-01-03", "origin": {"name": "..."}}.',
          additionalProperties: true,
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'patch',
    description: 'Change one field of an existing object.',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'integer', description: 'The number of the object.' },
        field: { type: 'string' },
        value: VALUE,
        old: { ...VALUE, description: 'The current value, if the field had one.' },
      },
      required: ['object', 'field', 'value'],
    },
  },
  {
    name: 'say',
    description: 'Answer or ask the user something.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
]

type Turn = { role: 'user' | 'assistant'; content: string }

/** The model wants alternating turns that start with the user; merge neighbours with the same role. */
function addTurn(turns: Turn[], role: Turn['role'], content: string) {
  const last = turns[turns.length - 1]
  if (last && last.role === role) last.content += `\n\n${content}`
  else if (last || role === 'user') turns.push({ role, content })
  // an assistant turn at the very start is dropped
}

function describeContext(request: ChatRequest): string {
  const files = request.files.map((f) => `- ${f.name}: ${f.object ? `belongs to object ${f.object}` : 'no object yet'}`).join('\n')
  const objects = request.objects
    .map((o) => {
      const notes = [o.issues.length > 0 && `open: ${o.issues.join('; ')}`].filter(Boolean)
      return `Object ${o.number}${notes.length ? ` (${notes.join('; ')})` : ''}:\n\`\`\`yaml\n${o.text.trim()}\n\`\`\``
    })
    .join('\n\n')
  return [`Files this message is about:\n${files || '(none)'}`, objects && `Their objects:\n${objects}`, `Message from the user:\n${request.message}`]
    .filter(Boolean)
    .join('\n\n')
}

export function buildModelRequest(request: ChatRequest, model: string) {
  const turns: Turn[] = []
  for (const entry of request.history) addTurn(turns, entry.role, entry.text)
  addTurn(turns, 'user', describeContext(request))
  return {
    model,
    max_tokens: 1024,
    // No temperature, top_p or top_k: Haiku 5.5 rejects them.
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    tool_choice: { type: 'any' }, // always answer with a tool call
    messages: turns,
  }
}

/** Turns the model's answer into tool calls. Calls that do not make sense are dropped. */
export function toToolCalls(response: unknown): ToolCall[] {
  const content = isRecord(response) && Array.isArray(response.content) ? response.content : []
  const calls: ToolCall[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      calls.push({ tool: 'say', text: block.text.trim() })
      continue
    }
    if (block.type !== 'tool_use' || !isRecord(block.input)) continue
    const input = block.input

    if (block.name === 'say' && typeof input.text === 'string') {
      calls.push({ tool: 'say', text: input.text })
    } else if (block.name === 'create_object' && typeof input.type === 'string' && input.type in OBJECT_TYPES) {
      const type = input.type as ObjectType
      const subtypes: readonly string[] = OBJECT_TYPES[type]
      calls.push({
        tool: 'create_object',
        type,
        // a subtype that does not belong to the type is left out rather than written into the YAML
        subtype: typeof input.subtype === 'string' && subtypes.includes(input.subtype) ? input.subtype : undefined,
        together: typeof input.together === 'boolean' ? input.together : undefined,
        fields: isRecord(input.fields) ? input.fields : undefined,
      })
    } else if (block.name === 'patch' && Number.isInteger(input.object) && typeof input.field === 'string' && 'value' in input) {
      calls.push({ tool: 'patch', object: input.object as number, field: input.field, value: input.value, old: input.old })
    }
  }
  return calls.length > 0 ? calls : [{ tool: 'say', text: 'Das habe ich nicht verstanden. Magst du es anders sagen?' }]
}
