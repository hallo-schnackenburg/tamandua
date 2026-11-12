// What the user sees of an object's kind and place. The keys (types, subtypes, fields) are English and come from archive.yaml.

// The German names come from archive.yaml (generated into core).
export { ENTITY_NAMES, EXTERNAL_NAMES, FIELD_NAMES, SUBTYPE_NAMES, TYPE_NAMES } from '@tamandua/core/archive'
import { SUBTYPE_NAMES, TYPE_NAMES } from '@tamandua/core/archive'

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
