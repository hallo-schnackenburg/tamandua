// Where the user is, as the address of the page: `#/erfassen/<session>`, or `#/datenbank/<object>?gruppe=<group>`. It lets back and forward
// work and the address be passed on. The hash is used (not a path), so that no server has to answer for these addresses.

/** In the database: `group` is the group the list is limited to, or `NO_GROUP` for the objects that are in none. */
export type Route = { tab: 'capture'; session?: string } | { tab: 'database'; id?: string; group?: string }

export const NO_GROUP = 'keine'

const TABS = { erfassen: 'capture', datenbank: 'database' } as const
const ULID = /^[0-9A-Z]{26}$/

/** The route of an address (`location.hash`); undefined if it says nothing the app knows. */
export function parseRoute(hash: string): Route | undefined {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?', 2)
  const [place, rest] = path.split('/', 2)
  if (!Object.hasOwn(TABS, place)) return undefined
  let value: string | undefined
  try {
    value = rest ? decodeURIComponent(rest) : undefined
  } catch {
    value = undefined // not a valid escape: the page is still known
  }
  if (TABS[place as keyof typeof TABS] === 'capture') return { tab: 'capture', session: value || undefined }
  const group = new URLSearchParams(query).get('gruppe') ?? undefined
  return { tab: 'database', id: value && ULID.test(value) ? value : undefined, group: group && (group === NO_GROUP || ULID.test(group)) ? group : undefined }
}

/** The address of a route. */
export function formatRoute(route: Route): string {
  if (route.tab === 'capture') return `#/erfassen${route.session ? `/${encodeURIComponent(route.session)}` : ''}`
  return `#/datenbank${route.id ? `/${route.id}` : ''}${route.group ? `?gruppe=${route.group}` : ''}`
}
