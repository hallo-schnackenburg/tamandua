import { describe, expect, it, vi } from 'vitest'
import { lookup, precisionOf, resolveGeocodes } from '../src/geocode.js'
import type { ToolCall } from '../src/chat.js'

const asFetch = (fn: unknown) => fn as typeof fetch
const hits = (list: unknown[]) => vi.fn(async () => new Response(JSON.stringify(list), { status: 200 }))
const tower = { lat: '53.0409', lon: '11.5586', display_name: 'Aussichtsturm, Schnackenburg, Landkreis Lüchow-Dannenberg, Niedersachsen', category: 'man_made', type: 'tower' }
const no = async () => {}

describe('precisionOf', () => {
  it('knows buildings, streets, settlements and the rest', () => {
    expect(precisionOf({ category: 'man_made', type: 'tower' })).toBe('exact')
    expect(precisionOf({ category: 'building', type: 'yes' })).toBe('exact')
    expect(precisionOf({ category: 'highway', type: 'residential' })).toBe('street')
    expect(precisionOf({ category: 'place', type: 'village' })).toBe('town')
    expect(precisionOf({ category: 'boundary', type: 'administrative' })).toBe('region')
  })
})

describe('lookup', () => {
  it('asks Nominatim politely and returns the first hit', async () => {
    const fake = hits([tower])
    const place = await lookup('Aussichtsturm, Schnackenburg', {}, asFetch(fake))
    expect(place).toEqual({ lat: 53.0409, lon: 11.5586, precision: 'exact', label: 'Aussichtsturm, Schnackenburg, Landkreis Lüchow-Dannenberg' })

    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit]
    const params = new URL(url).searchParams
    expect(new URL(url).host).toBe('nominatim.openstreetmap.org')
    expect(params.get('q')).toBe('Aussichtsturm, Schnackenburg')
    expect(params.get('limit')).toBe('1')
    expect(params.get('countrycodes')).toBe('de')
    expect((init.headers as Record<string, string>)['user-agent']).toBe('tamandua')
  })

  it('takes country and user agent from the settings; an empty country list searches everywhere', async () => {
    const fake = hits([tower])
    await lookup('x', { GEOCODE_COUNTRIES: '', GEOCODE_USER_AGENT: 'my-archive' }, asFetch(fake))
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(url).searchParams.has('countrycodes')).toBe(false)
    expect((init.headers as Record<string, string>)['user-agent']).toBe('my-archive')
  })

  it('returns nothing when nothing was found, and throws when the service fails', async () => {
    expect(await lookup('Nirgendwo', {}, asFetch(hits([])))).toBeUndefined()
    await expect(lookup('x', {}, asFetch(vi.fn(async () => new Response('', { status: 503 }))))).rejects.toThrow('503')
  })
})

describe('resolveGeocodes', () => {
  const ask = (query: string): ToolCall => ({ tool: 'geocode', object: 3, for: 'object', query })

  it('turns a geocode call into set_geocode and leaves other calls alone', async () => {
    const say: ToolCall = { tool: 'say', text: 'ok' }
    const out = await resolveGeocodes([say, ask('Turm')], {}, asFetch(hits([tower])), no)
    expect(out[0]).toBe(say)
    expect(out[1]).toMatchObject({ tool: 'set_geocode', object: 3, for: 'object', lat: 53.0409, lon: 11.5586, precision: 'exact', source: 'osm' })
  })

  it('says so when nothing is found or the service is down', async () => {
    const [none] = await resolveGeocodes([ask('Nirgendwo')], {}, asFetch(hits([])), no)
    expect(none).toMatchObject({ tool: 'say' })
    expect((none as { text: string }).text).toContain('Nirgendwo')
    const [down] = await resolveGeocodes([ask('x')], {}, asFetch(vi.fn(async () => { throw new Error('offline') })), no)
    expect((down as { text: string }).text).toContain('nicht erreichbar')
  })

  it('looks up a few places at most, one second apart', async () => {
    const fake = hits([tower])
    const pause = vi.fn(async () => {})
    const out = await resolveGeocodes([ask('a'), ask('b'), ask('c'), ask('d')], {}, asFetch(fake), pause)
    expect(fake).toHaveBeenCalledTimes(3)
    expect(pause).toHaveBeenCalledTimes(2)
    expect(pause).toHaveBeenCalledWith(1100)
    expect(out[3]).toMatchObject({ tool: 'say' })
  })
})
