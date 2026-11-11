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
  brochure: 'Broschüre',
  album: 'Album',
  collection: 'Sammlung',
}

export const TYPE_NAMES: Record<string, string> = { image: 'Bild', document: 'Dokument', group: 'Gruppe' }

export const FIELD_NAMES: Record<string, string> = {
  title: 'Titel',
  date: 'Datum',
  subtype: 'Untertyp',
  origin: 'Herkunft',
  original: 'Original',
  holder: 'Aufbewahrung',
  reference: 'Signatur',
  parents: 'Gehört zu',
  members: 'Enthält',
  owner: 'Eigentümer',
  subjects: 'Bezüge',
  recipient: 'Empfänger',
  location: 'Ort',
  geocode: 'Koordinaten',
  description: 'Beschreibung',
  notes: 'Notizen',
  language: 'Sprache',
  storage: 'Ablage',
  external: 'Externe Fundstelle',
}

export const ENTITY_NAMES: Record<string, string> = {
  person: 'Person',
  place: 'Ort',
  building: 'Gebäude',
  business: 'Betrieb',
  event: 'Ereignis',
  thing: 'Sache',
}

export const EXTERNAL_NAMES: Record<string, string> = { archive: 'Archiv', platform: 'Plattform', website: 'Webseite' }

/** Where an object that lives elsewhere can be found: the name of the first place, else its host. */
export function placeOf(list: unknown): string {
  const first = Array.isArray(list) ? (list[0] as { site?: unknown; uri?: unknown } | null) : undefined
  if (typeof first?.site === 'string' && first.site) return first.site
  if (typeof first?.uri === 'string') {
    try {
      return new URL(first.uri).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  return ''
}

/** "Brief" for a letter, "Bild" for an image without subtype. */
export const objectLabel = (type?: string, subtype?: string): string =>
  (subtype && SUBTYPE_NAMES[subtype]) || (type && TYPE_NAMES[type]) || subtype || type || 'Objekt'
