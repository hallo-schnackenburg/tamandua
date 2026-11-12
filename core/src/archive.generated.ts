// Generated from archive.yaml by `npm run generate` in core. Do not edit.

export const OBJECT_TYPES = {
  image: ['photo', 'drawing', 'print', 'plan'],
  document: ['letter', 'note', 'protocol', 'brochure'],
  group: ['album', 'collection'],
} as const

export type ObjectType = keyof typeof OBJECT_TYPES

export const ENTITY_TYPES = ['person', 'place', 'building', 'business', 'event', 'thing'] as const

export const EXTERNAL_TYPES = ['archive', 'platform', 'website'] as const

// The German names people see.
export const TYPE_NAMES: Record<string, string> = {
  image: 'Bild',
  document: 'Dokument',
  group: 'Gruppe',
}

export const SUBTYPE_NAMES: Record<string, string> = {
  photo: 'Foto',
  drawing: 'Zeichnung',
  print: 'Druckgrafik',
  plan: 'Karte / Plan',
  letter: 'Brief',
  note: 'Notiz',
  protocol: 'Protokoll',
  brochure: 'Broschüre',
  album: 'Album',
  collection: 'Sammlung',
}

export const FIELD_NAMES: Record<string, string> = {
  members: 'Enthält',
  parents: 'Gehört zu',
  subtype: 'Untertyp',
  title: 'Titel',
  description: 'Beschreibung',
  date: 'Datum',
  location: 'Ort',
  geocode: 'Koordinaten',
  origin: 'Herkunft',
  original: 'Original',
  owner: 'Eigentümer',
  subjects: 'Bezüge',
  notes: 'Notizen',
  storage: 'Ablage',
  external: 'Externe Fundstelle',
  recipient: 'Empfänger',
  language: 'Sprache',
  holder: 'Aufbewahrung',
  reference: 'Signatur',
}

export const ENTITY_NAMES: Record<string, string> = {
  person: 'Person',
  place: 'Ort',
  building: 'Gebäude',
  business: 'Betrieb',
  event: 'Ereignis',
  thing: 'Sache',
}

export const EXTERNAL_NAMES: Record<string, string> = {
  archive: 'Archiv',
  platform: 'Plattform',
  website: 'Webseite',
}

/** The fields that are filled in while capturing: those of every object, and those only some types have. */
export interface CaptureField {
  name: string
  hint?: string
}

export const CAPTURE_FIELDS: { common: CaptureField[]; types: Record<string, CaptureField[]> } = {
  common: [{ name: 'title' }, { name: 'description' }, { name: 'date' }, { name: 'location' }, { name: 'origin' }, { name: 'original' }, { name: 'owner' }, { name: 'subjects' }, { name: 'notes' }],
  types: {
    document: [{ name: 'recipient' }, { name: 'language', hint: 'e.g. "de"' }],
  },
}
