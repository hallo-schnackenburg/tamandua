// What the user sees: German names and the color of an object. The keys (types,
// subtypes, fields) are English and come from archive.yaml and the schema.

export const SUBTYPE_NAMES: Record<string, string> = {
  photo: 'Foto',
  drawing: 'Zeichnung',
  print: 'Druckgrafik',
  plan: 'Karte / Plan',
  letter: 'Brief',
  protocol: 'Protokoll',
  note: 'Notiz',
}

export const TYPE_NAMES: Record<string, string> = { image: 'Bild', document: 'Dokument' }

export const FIELD_NAMES: Record<string, string> = {
  title: 'Titel',
  date: 'Datum',
  subtype: 'Untertyp',
  origin: 'Herkunft',
  subjects: 'Bezüge',
  recipient: 'Empfänger',
  location: 'Ort',
  description: 'Beschreibung',
  notes: 'Notizen',
  language: 'Sprache',
}

/** "Brief" for a letter, "Bild" for an image without subtype. */
export const objectLabel = (type?: string, subtype?: string): string =>
  (subtype && SUBTYPE_NAMES[subtype]) || (type && TYPE_NAMES[type]) || subtype || type || 'Objekt'

// One color per object.
const PALETTE = ['#1c7ed6', '#d9480f', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5f3dc4']

export const colorOf = (number: number): string => PALETTE[(number - 1) % PALETTE.length]
