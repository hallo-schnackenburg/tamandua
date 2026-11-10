// The chat request to the model: what we send, and how the answer becomes tool calls.
// Nothing here touches the network, so it can be tested on its own.

import { ENTITY_TYPES, EXTERNAL_TYPES, OBJECT_TYPES, type ObjectType } from '@tamandua/core/archive'

/** What the browser sends. The YAML texts come without the `files` list (hashes are noise for the model). */
export interface ChatRequest {
  message: string
  files: { name: string; object?: number }[]
  objects: { number: number; text: string; issues: string[] }[]
  history: { role: 'user' | 'assistant'; text: string }[]
}

/** One place outside of our store where an object's content can be found. */
export interface ExternalPlace {
  uri?: string
  site?: string
  type?: string
  reference?: string
  note?: string
  retrieved?: string
}

/** The same calls the app's agent interface returns. */
export type ToolCall =
  | { tool: 'create_object'; type: ObjectType; subtype?: string; together?: boolean; fields?: Record<string, unknown>; external?: ExternalPlace[] }
  | { tool: 'patch'; object: number; field: string; value: unknown; old?: unknown }
  | { tool: 'say'; text: string }
  /** The model asks for a lookup; the Worker resolves it into `set_geocode` before it answers the browser. */
  | { tool: 'geocode'; object: number; for: GeocodeFor; subject?: string; query: string }
  | { tool: 'set_geocode'; object: number; for: GeocodeFor; subject?: string; lat: number; lon: number; precision: 'exact' | 'street' | 'town' | 'region'; label: string; source: string }

/** Which place of an object gets the point: its own location, origin, holder, owner, or one of its subjects. */
export type GeocodeFor = 'object' | 'origin' | 'holder' | 'owner' | 'subject'
const GEOCODE_FOR: readonly GeocodeFor[] = ['object', 'origin', 'holder', 'owner', 'subject']

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

Context you get with each message: the files the message is about, and the objects it is about (those of the files, or an open object that has no files) with their current YAML. "(none)" means there is no such object.

Tools:
- create_object: for files that belong to no object yet, or for an object that lives somewhere else (see below). type is one of: ${TYPE_LIST}. An image is always one object per file. A document takes all files as pages of ONE object (together true); set together false only if the user clearly means separate documents ("drei Briefe", "jeweils ein Brief"). Set subtype only when it is clear; otherwise leave it out. Put everything the user said into fields.
- create_object with external: for an object that lives somewhere else and has no files of ours: a film on YouTube, an entry in another archive's catalogue. Use it only when NO object is part of the context and the user describes a NEW object that is external, with details of its own (what it is, a title, a link: "Foto; Mühle am Aland; extern: https://..."). Words that refer to an object that exists ("das Objekt", "dieses Objekt", "es", "das ist extern") are never a reason to create one: patch the object in the context. If there is no object in the context and the message refers to one, create nothing and ask with say which object is meant; it has to be opened first, or a "+" above the objects adds a new one. If the user does not say what kind of object it is (image or document), do not guess: ask with say. external is a list; each place has, as far as the user said it, uri (the web address), site (name of the archive or platform), type, reference (call number or id there) and note (free text about this place, e.g. which page) and retrieved (a day, "2026-11-09"). None of them is required, in particular not the web address: if the user names only the archive or platform, create the place with site alone and do not ask for the address. Everything else the user said goes into fields. It needs no selected files. If the user describes an object without files and does not say that it is external, do not create anything: use say to explain that a "+" above the objects adds an empty object, and that for scans the files have to be selected first.
- patch: change one field of an existing object (by its number). Pass the value you saw as "old" (leave it out if the field was not there), so that nothing the user typed in the meantime is overwritten.
- geocode: look up the coordinates of a place on the map. The app sets the result and tells the user, so do not repeat it. Use it only when the user asks for coordinates or the exact position.
- say: answer or ask a short question. Use it when something is unclear, when the user asks something, or in addition to other calls if you must point something out. The app itself confirms every object created and every field set, so do not repeat that; say something only for assumptions, hints or questions.

Fields (YAML keys, in English): title, description, date, location, origin, holder, owner, subjects, notes; documents also recipient and language (e.g. "de").
- date is EDTF text: "1965", "1965-01", "1965-01-03", "196X" (decade), "1960/1969" (range), a trailing "?" for uncertain, "~" for approximate. Always as text.
- location is the place the object relates to for the archive, shown on the map: where a photo was taken, where a shown thing stands today. Free text, e.g. "Schnackenburg, Marktplatz".
- origin is who made the object and where, as an object {name, type, location}: for a photo the photographer and the place, for a letter the sender and the place, for a brochure the company and its seat. Example: {"name": "Max Ketterer", "type": "business", "location": "Leipzig-Reudnitz"}. It is not where the object was found; put that into notes.
- holder is who has the original now and where, same shape as origin: the town archive, a family, a collector, a gallery. owner is who it belongs to. Fill only what the user says; never infer one from the other. Examples: "Leihgabe der Familie Müller, liegt jetzt im Stadtarchiv" gives holder {"name": "Stadtarchiv Schnackenburg", "type": "business"} and owner {"name": "Familie Müller", "type": "person"}; "Gemälde gehört Herrn Zenziper, hängt in der Galerie Elbe 5" gives owner {"name": "Zenziper", "type": "person"} and holder {"name": "Galerie Elbe 5", "type": "business"}. Without such a statement leave both out.
- subjects is a list of the things the object shows or mentions, each {name, type, note, location}: people, places, buildings, businesses, events, things. type is one of: ${ENTITY_TYPES.join(', ')}. Example: [{"name": "Konditorei Müller", "type": "business", "note": "am Markt"}]. To add one, send the whole list as value and the current list as old.
- An object that lives elsewhere has storage "external" and the list external of places {uri, site, type, reference, note, retrieved}. type of a place is one of: ${EXTERNAL_TYPES.join(', ')} (archive: archive, library, museum with catalogue entries; platform: video, photo or audio platform; website: any other page). site is the name, e.g. "Deutsche Digitale Bibliothek", "YouTube". Do not take holder from it unless the user says who has the original. To add or change a place, patch the field external with the whole list as value and the current list as old. An empty object that was added with the "+" has nothing yet, neither a type nor files: as soon as the user says what it is, set type and the other fields with patch; if it lives elsewhere (the user says so, with or without a web address), also set storage to "external" and external to the list of places, as far as known, e.g. [{"site": "Wendlandarchiv", "type": "archive"}].
- notes is only for what the user explicitly says and that fits no other field (e.g. where it was found, how it came into the archive). Never write file names, upload details or your own remarks into notes, and never use notes when another field fits. File names may hint at a date; mention that with a say call instead of writing it anywhere.
- The message context starts with today's date. Turn "heute" and "gestern" into that concrete date ("2026-11-09" style, or the German form the user gave); other relative dates ("letzten Sommer") are not guessed, ask with a say call.
- Never write a placeholder such as "<UNKNOWN>", "unbekannt" or "?" into a field. If you do not know a value, leave the field out.
- A two-digit year such as "65" means 1965 in this archive; say so briefly with a say call when you assume it.
- Write names and places as the user gave them. Do not invent facts (no guessed dates, names or titles). Leave out what the user did not say.
- Several objects at once: if the user's message applies to all of them, issue one patch per object.
- Always answer in German, short and friendly, addressing the user with "du". Say "Objekt" (never "Object") and give its number, e.g. "Objekt 3".`

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
        external: {
          type: 'array',
          description: 'Only for an object that lives somewhere else and has no files: where it can be found.',
          items: {
            type: 'object',
            properties: {
              uri: { type: 'string', description: 'The web address (http or https), if the user gave one.' },
              site: { type: 'string', description: 'Name of the archive or platform.' },
              type: { type: 'string', enum: [...EXTERNAL_TYPES] },
              reference: { type: 'string', description: 'Call number or id at that place.' },
              note: { type: 'string', description: 'Free text about this place, e.g. which page.' },
              retrieved: { type: 'string', description: 'The day somebody saw it there, YYYY-MM-DD.' },
            },
          },
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
    name: 'geocode',
    description:
      'Look up the coordinates of a place on the map (OpenStreetMap) and set them on the object. Use it when the user asks for coordinates or the exact position of a place. Never write coordinates yourself.',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'integer', description: 'The number of the object.' },
        for: { enum: GEOCODE_FOR, description: 'object: the object\'s own location; origin, holder, owner: that entity\'s place; subject: one of the subjects (give its name).' },
        subject: { type: 'string', description: 'Only for "subject": the name of the subject as it is in the object.' },
        query: { type: 'string', description: 'What to search for, with the town, e.g. "Aussichtsturm, Schnackenburg".' },
      },
      required: ['object', 'for', 'query'],
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
/** A value the model made up for something it does not know ("<UNKNOWN>"): it must not end up in the YAML. */
const isPlaceholder = (value: unknown): boolean => typeof value === 'string' && /^\s*(<[^>]*>|\[[^\]]*\]|unknown|unbekannt|\?)\s*$/i.test(value)
const withoutPlaceholders = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => !isPlaceholder(value)))

function addTurn(turns: Turn[], role: Turn['role'], content: string) {
  const last = turns[turns.length - 1]
  if (last && last.role === role) last.content += `\n\n${content}`
  else if (last || role === 'user') turns.push({ role, content })
  // an assistant turn at the very start is dropped
}

/** Today's date in the archive's time zone, as "2026-11-09". */
export function todayIn(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function describeContext(request: ChatRequest, now: Date): string {
  const files = request.files.map((f) => `- ${f.name}: ${f.object ? `belongs to Objekt ${f.object}` : 'no object yet'}`).join('\n')
  const objects = request.objects
    .map((o) => {
      const notes = [o.issues.length > 0 && `open: ${o.issues.join('; ')}`].filter(Boolean)
      return `Objekt ${o.number}${notes.length ? ` (${notes.join('; ')})` : ''}:\n\`\`\`yaml\n${o.text.trim()}\n\`\`\``
    })
    .join('\n\n')
  return [`Today is ${todayIn(now)}.`, `Files this message is about:\n${files || '(none)'}`, `Objects this message is about:\n${objects || '(none)'}`, `Message from the user:\n${request.message}`]
    .filter(Boolean)
    .join('\n\n')
}

export function buildModelRequest(request: ChatRequest, model: string, now: Date = new Date()) {
  const turns: Turn[] = []
  for (const entry of request.history) addTurn(turns, entry.role, entry.text)
  addTurn(turns, 'user', describeContext(request, now))
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

/** The places the model sent for an object that lives elsewhere; entries without a web address or with made-up values are left out. */
function externalPlaces(value: unknown): ExternalPlace[] | undefined {
  if (!Array.isArray(value)) return undefined
  const places: ExternalPlace[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const place: ExternalPlace = {}
    // An address that is not one is left out; the rest of the place is still of use.
    if (typeof entry.uri === 'string' && /^https?:\/\/\S+$/.test(entry.uri.trim())) place.uri = entry.uri.trim()
    for (const key of ['site', 'type', 'reference', 'note', 'retrieved'] as const) {
      const text = entry[key]
      if (typeof text === 'string' && text.trim() && !isPlaceholder(text)) place[key] = text.trim()
    }
    if (place.retrieved && !/^\d{4}-\d{2}-\d{2}$/.test(place.retrieved)) delete place.retrieved
    if (Object.keys(place).length > 0) places.push(place)
  }
  return places.length > 0 ? places : undefined
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
        fields: isRecord(input.fields) ? withoutPlaceholders(input.fields) : undefined,
        external: externalPlaces(input.external),
      })
    } else if (
      block.name === 'geocode' &&
      Number.isInteger(input.object) &&
      typeof input.query === 'string' &&
      input.query.trim() &&
      typeof input.for === 'string' &&
      (GEOCODE_FOR as readonly string[]).includes(input.for) &&
      (input.for !== 'subject' || typeof input.subject === 'string')
    ) {
      calls.push({
        tool: 'geocode',
        object: input.object as number,
        for: input.for as GeocodeFor,
        subject: typeof input.subject === 'string' ? input.subject : undefined,
        query: input.query.trim(),
      })
    } else if (block.name === 'patch' && Number.isInteger(input.object) && typeof input.field === 'string' && 'value' in input && !isPlaceholder(input.value)) {
      calls.push({ tool: 'patch', object: input.object as number, field: input.field, value: input.value, old: input.old })
    }
  }
  return calls.length > 0 ? calls : [{ tool: 'say', text: 'Das habe ich nicht verstanden. Magst du es anders sagen?' }]
}
