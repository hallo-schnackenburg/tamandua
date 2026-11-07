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
  holder: 'Aufbewahrung',
  owner: 'Eigentümer',
  subjects: 'Bezüge',
  recipient: 'Empfänger',
  location: 'Ort',
  geocode: 'Koordinaten',
  description: 'Beschreibung',
  notes: 'Notizen',
  language: 'Sprache',
}

/** "Brief" for a letter, "Bild" for an image without subtype. */
export const objectLabel = (type?: string, subtype?: string): string =>
  (subtype && SUBTYPE_NAMES[subtype]) || (type && TYPE_NAMES[type]) || subtype || type || 'Objekt'

// One color per object.
// Soft, desaturated colors in the spirit of the chat bubbles.
const PALETTE = ['#7ea6e0', '#e0957a', '#86b894', '#b58ac4', '#d98aa6', '#7fb5bf', '#d9b06a', '#9a8ad1']

export const colorOf = (number: number): string => PALETTE[(number - 1) % PALETTE.length]
