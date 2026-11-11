import { describe, expect, it } from 'vitest'
import { formatRoute, parseRoute, type Route } from '../src/route.js'

const ID = '01JC8Z3Q7M5K2V9X4T6R1B0N8D'

describe('route', () => {
  it.each<[string, Route]>([
    ['#/erfassen', { tab: 'capture' }],
    ['#/erfassen/dachbodenfund-postkarten', { tab: 'capture', session: 'dachbodenfund-postkarten' }],
    ['#/datenbank', { tab: 'database' }],
    [`#/datenbank/${ID}`, { tab: 'database', id: ID }],
    [`#/datenbank?gruppe=${ID}`, { tab: 'database', group: ID }],
    [`#/datenbank/${ID}?gruppe=${ID}`, { tab: 'database', id: ID, group: ID }],
    ['#/datenbank?gruppe=keine', { tab: 'database', group: 'keine' }],
  ])('%s is read and written back as it is', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route)
    expect(formatRoute(route)).toBe(hash)
  })

  it('escapes a session whose id has unusual characters', () => {
    const route: Route = { tab: 'capture', session: 'Erfassung vom 10.11.2026/2' }
    expect(formatRoute(route)).toBe('#/erfassen/Erfassung%20vom%2010.11.2026%2F2')
    expect(parseRoute(formatRoute(route))).toEqual(route)
  })

  it('knows nothing of other addresses, and takes only real object ids', () => {
    for (const odd of ['', '#', '#/', '#/foo', '#login', '#/constructor', '#/__proto__/x']) expect(parseRoute(odd)).toBeUndefined()
    expect(parseRoute('#/datenbank/nicht-eine-id')).toEqual({ tab: 'database' })
    expect(parseRoute('#/datenbank?gruppe=irgendwas')).toEqual({ tab: 'database' })
    expect(parseRoute('#/erfassen/%E0%A4%A')).toEqual({ tab: 'capture' }) // a broken escape does not break the page
  })

  it('also reads the address without the slash', () => expect(parseRoute('#datenbank')).toEqual({ tab: 'database' }))
})
