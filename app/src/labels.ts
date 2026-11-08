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
