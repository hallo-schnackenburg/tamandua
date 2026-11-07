// Every call to the Worker goes through here. A 401 means the session is over (the cookie
// expired or was revoked): the app is told so it can show the sign-in again.

export class SignedOut extends Error {
  constructor() {
    super('Du bist nicht mehr angemeldet.')
  }
}

const SIGNED_OUT = 'tamandua:signed-out'

export const onSignedOut = (listener: () => void): (() => void) => {
  window.addEventListener(SIGNED_OUT, listener)
  return () => window.removeEventListener(SIGNED_OUT, listener)
}

/** `fetch` for the Worker: a network failure becomes a readable error, a 401 becomes `SignedOut`. */
export async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('Der Server ist nicht erreichbar. Läuft der Worker (npm run dev:worker)?')
  }
  if (response.status === 401) {
    window.dispatchEvent(new Event(SIGNED_OUT))
    throw new SignedOut()
  }
  return response
}

export const jsonOf = async <T>(response: Response): Promise<T & { error?: string }> =>
  (await response.json().catch(() => ({}))) as T & { error?: string }
