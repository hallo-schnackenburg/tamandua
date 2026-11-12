// Where the user is, as the address of the page: `#/erfassen/<session>`, `#/datenbank/<object>?gruppe=<group>` or `#/pruefen/<pull request>/<object>`. It lets back and forward
// work and the address be passed on. The hash is used (not a path), so that no server has to answer for these addresses.

/** In the database: `group` is the group the list is limited to, or `NO_GROUP` for the objects that are in none. */
export type Route =
  | { tab: 'capture'; session?: string }
  | { tab: 'database'; id?: string; group?: string }
  /** `pull`: the number of the pull request of the session under review; `id`: the object of it that is shown. */
  | { tab: 'review'; pull?: number; id?: string }

export const NO_GROUP = 'keine'

const TABS = { erfassen: 'capture', datenbank: 'database', pruefen: 'review' } as const
const ULID = /^[0-9A-Z]{26}$/

/** The route of an address (`location.hash`); undefined if it says nothing the app knows. */
export function parseRoute(hash: string): Route | undefined {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?', 2)
  const [place, rest, third] = path.split('/', 3)
  if (!Object.hasOwn(TABS, place)) return undefined
  let value: string | undefined
  try {
    value = rest ? decodeURIComponent(rest) : undefined
  } catch {
    value = undefined // not a valid escape: the page is still known
  }
  if (TABS[place as keyof typeof TABS] === 'capture') return { tab: 'capture', session: value || undefined }
  if (TABS[place as keyof typeof TABS] === 'review') {
    return { tab: 'review', pull: value && /^\d{1,9}$/.test(value) ? Number(value) : undefined, id: third && ULID.test(third) ? third : undefined }
  }
  const group = new URLSearchParams(query).get('gruppe') ?? undefined
  return { tab: 'database', id: value && ULID.test(value) ? value : undefined, group: group && (group === NO_GROUP || ULID.test(group)) ? group : undefined }
}

/** The address of a route. */
export function formatRoute(route: Route): string {
  if (route.tab === 'capture') return `#/erfassen${route.session ? `/${encodeURIComponent(route.session)}` : ''}`
  if (route.tab === 'review') return `#/pruefen${route.pull ? `/${route.pull}${route.id ? `/${route.id}` : ''}` : ''}`
  return `#/datenbank${route.id ? `/${route.id}` : ''}${route.group ? `?gruppe=${route.group}` : ''}`
}
