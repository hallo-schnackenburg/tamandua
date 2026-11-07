// Looks up coordinates for a place with OpenStreetMap's Nominatim. The model never
// writes coordinates itself; it asks for a lookup and the point comes from here.
//
// Nominatim's usage policy: at most one request per second, and a User-Agent that
// names the application. Data is © OpenStreetMap contributors (ODbL).

import type { ToolCall } from './chat.js'

export interface GeocodeEnv {
  /** Comma separated country codes to search in, e.g. "de". Empty: everywhere. Default "de". */
  GEOCODE_COUNTRIES?: string
  /** What to send as User-Agent; name the application and how to reach its operator. */
  GEOCODE_USER_AGENT?: string
}

export type Precision = 'exact' | 'street' | 'town' | 'region'

export interface Place {
  lat: number
  lon: number
  precision: Precision
  /** What was found, in a few words, so that a wrong hit is noticed. */
  label: string
}

const BUILDINGS = new Set(['building', 'house', 'amenity', 'tourism', 'historic', 'man_made', 'leisure', 'shop', 'office', 'craft'])
const SETTLEMENTS = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter', 'locality', 'isolated_dwelling', 'municipality', 'borough', 'city_district'])

/** How exact a hit is, from what kind of thing Nominatim found. */
export function precisionOf(hit: { category?: string; type?: string; addresstype?: string }): Precision {
  const kinds = [hit.category, hit.type, hit.addresstype]
  if (kinds.some((k) => k && BUILDINGS.has(k))) return 'exact'
  if (hit.category === 'highway' || hit.addresstype === 'road') return 'street'
  if (hit.category === 'place' && hit.type && SETTLEMENTS.has(hit.type)) return 'town'
  return 'region'
}

const MAX_LABEL_PARTS = 3

/** The first hit for `query`, or undefined. Throws if the service cannot be reached. */
export async function lookup(query: string, env: GeocodeEnv, fetchFn: typeof fetch): Promise<Place | undefined> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  url.searchParams.set('accept-language', 'de')
  const countries = (env.GEOCODE_COUNTRIES ?? 'de').trim()
  if (countries) url.searchParams.set('countrycodes', countries)

  const response = await fetchFn(url.toString(), { headers: { 'user-agent': env.GEOCODE_USER_AGENT ?? 'tamandua' } })
  if (!response.ok) throw new Error(`Geocoding failed (${response.status}).`)
  const hits = (await response.json()) as { lat?: string; lon?: string; display_name?: string; category?: string; type?: string; addresstype?: string }[]
  const hit = hits[0]
  const lat = Number(hit?.lat)
  const lon = Number(hit?.lon)
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined
  const label = (hit.display_name ?? query).split(', ').slice(0, MAX_LABEL_PARTS).join(', ')
  return { lat, lon, precision: precisionOf(hit), label }
}

const MAX_LOOKUPS = 3
const PAUSE_MS = 1100

/** Replaces the model's `geocode` calls by `set_geocode` calls (or a `say` if nothing was found). */
export async function resolveGeocodes(
  calls: ToolCall[],
  env: GeocodeEnv,
  fetchFn: typeof fetch,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ToolCall[]> {
  const result: ToolCall[] = []
  let done = 0
  for (const call of calls) {
    if (call.tool !== 'geocode') {
      result.push(call)
      continue
    }
    if (done >= MAX_LOOKUPS) {
      result.push({ tool: 'say', text: `Ich suche höchstens ${MAX_LOOKUPS} Orte auf einmal. „${call.query}“ bitte noch einmal anfragen.` })
      continue
    }
    if (done > 0) await pause(PAUSE_MS) // one request per second
    done++
    try {
      const place = await lookup(call.query, env, fetchFn)
      if (!place) {
        result.push({ tool: 'say', text: `Zu „${call.query}“ habe ich auf der Karte nichts gefunden. Magst du den Ort genauer beschreiben?` })
      } else {
        result.push({ tool: 'set_geocode', object: call.object, for: call.for, subject: call.subject, ...place, source: 'osm' })
      }
    } catch {
      result.push({ tool: 'say', text: 'Der Kartendienst ist gerade nicht erreichbar. Versuch es gleich noch einmal.' })
    }
  }
  return result
}
