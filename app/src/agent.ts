// The agent turns what the user writes into actions. The rest of the app only knows
// this interface: it sends the message and the files it refers to, and gets back a
// list of tool calls, which the workspace carries out. The agent never changes
// anything itself. FakeAgent stands in until the real one (a model behind the
// Worker) exists; it returns the same kind of calls, so everything behind it is real.

import { readValue, type ObjectType } from '@tamandua/core'

/** One place outside of our store where an object's content can be found. */
export interface ExternalPlace {
  uri?: string
  site?: string
  type?: string
  reference?: string
  note?: string
  retrieved?: string
}

export interface AgentFile {
  sha256: string
  name: string
  /** The number of the object the file belongs to, if any. */
  object?: number
}

export interface AgentObject {
  number: number
  /** The object's YAML as it is now. */
  text: string
  /** What is still wrong with it, e.g. a missing title. */
  issues: string[]
}

export interface AgentRequest {
  message: string
  /** The files the message is about. */
  files: AgentFile[]
  /** The objects those files belong to. */
  objects: AgentObject[]
  /** The conversation so far (oldest first), so that "und das Datum?" has something to refer to. */
  history: { role: 'user' | 'assistant'; text: string }[]
}

export type ToolCall =
  /** Makes objects out of the files that have none yet. An image is always one object per file. */
  | {
      tool: 'create_object'
      /** Missing only for an object that lives elsewhere, when the user did not say what it is. */
      type?: ObjectType
      subtype?: string
      /** Documents: all files are pages of one object (default); false: one object per file. */
      together?: boolean
      fields?: Record<string, unknown>
      /** The object lives elsewhere: it needs no files, only where it can be found. */
      external?: ExternalPlace[]
    }
  /** Changes one field. `old` is the value the agent saw; if the user changed it since, the call is skipped. */
  | { tool: 'patch'; object: number; field: string; value: unknown; old?: unknown }
  /** Sets a point from the map service on the object's location, an entity of it (origin, the holder of the original, owner) or one subject (by name). */
  | {
      tool: 'set_geocode'
      object: number
      for: 'object' | 'origin' | 'holder' | 'owner' | 'subject'
      subject?: string
      lat: number
      lon: number
      precision: 'exact' | 'street' | 'town' | 'region'
      /** What was found, for the user to check. */
      label: string
      source: string
    }
  /** Answers or asks the user something. */
  | { tool: 'say'; text: string }

export interface Agent {
  respond(request: AgentRequest): Promise<ToolCall[]>
}

// --- the stand-in ---

const FIELDS: Record<string, string> = {
  titel: 'title',
  datum: 'date',
  ort: 'location',
  autor: 'origin',
  urheber: 'origin',
  fotograf: 'origin',
  empfänger: 'recipient',
  beschreibung: 'description',
  notizen: 'notes',
}

const KEYS = Object.keys(FIELDS).join('|')
// A value ends at the next "key:", at a date after a comma, at ; or a line break, or at the end.
const DATE = '\\d{1,2}\\.\\s?\\d{1,2}\\.\\s?(?:\\d{4}|\\d{2})|\\d{4}'
const PAIR = new RegExp(`(${KEYS})\\s*:\\s*([^;\\n]*?)(?=,\\s*(?:${KEYS})\\s*:|,\\s*(?:${DATE})\\s*(?:[,;\\n]|$)|;|\\n|$)`, 'giu')

const strip = (value: string) => value.trim().replace(/^["„“'](.*)["“”']$/, '$1')

function findDate(text: string): string | undefined {
  const dmy = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b/.exec(text)
  if (dmy) {
    const year = dmy[3].length === 2 ? `19${dmy[3]}` : dmy[3]
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  }
  return /\b(1\d{3}|20\d{2})\b/.exec(text)?.[1]
}

/** Understands only "Brief, Titel: …, Autor: …, 3.1.65": enough to try the interface. */
export class FakeAgent implements Agent {
  async respond({ message, objects }: AgentRequest): Promise<ToolCall[]> {
    await new Promise((resolve) => setTimeout(resolve, 150))

    const fields: Record<string, unknown> = {}
    for (const match of message.matchAll(PAIR)) {
      const field = FIELDS[match[1].toLowerCase()]
      fields[field] = field === 'origin' ? { name: strip(match[2]) } : strip(match[2])
    }
    if (!fields.date) {
      const date = findDate(message.replace(PAIR, ''))
      if (date) fields.date = date
    }

    const lower = message.toLowerCase()
    const has = (word: RegExp) => word.test(lower)
    const names = /\b(fotos?|bilder?|briefe?|protokolle?|notizen?|dokumente?)\b/
    const patch = (list: AgentObject[]): ToolCall[] =>
      list.flatMap((object) =>
        Object.entries(fields).map(([field, value]): ToolCall => ({
          tool: 'patch',
          object: object.number,
          field,
          value,
          old: readValue(object.text, field),
        })),
      )

    // Selected files that already have an object: change its fields.
    const selected = objects
    if (selected.length > 0) {
      if (Object.keys(fields).length === 0) return [{ tool: 'say', text: 'Ich habe keine Angaben erkannt, z. B. „Titel: …, Autor: …, 3.1.65“.' }]
      return patch(selected)
    }

    if (has(/\b(fotos?|bilder?)\b/)) return [{ tool: 'create_object', type: 'image', subtype: 'photo', fields }]
    if (has(/\bzeichnung(en)?\b/)) return [{ tool: 'create_object', type: 'image', subtype: 'drawing', fields }]
    const documents: [RegExp, RegExp, string | undefined][] = [
      [/\bbrief\b/, /\bbriefe\b/, 'letter'],
      [/\bprotokoll\b/, /\bprotokolle\b/, 'protocol'],
      [/\bnotiz\b/, /\bnotizen\b/, 'note'],
      [/\bdokument\b/, /\bdokumente\b/, undefined],
    ]
    for (const [one, many, subtype] of documents) {
      if (has(many)) return [{ tool: 'create_object', type: 'document', subtype, together: false, fields }]
      if (has(one)) return [{ tool: 'create_object', type: 'document', subtype, together: true, fields }]
    }
    return [{ tool: 'say', text: 'Soll das ein Bild oder ein Dokument (Brief, Protokoll, Notiz) sein?' }]
  }
}
