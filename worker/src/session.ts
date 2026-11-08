// The session: who is signed in and the GitHub token to act for them. It lives in a cookie, encrypted
// (AES-GCM) with a key from SESSION_SECRET, so the Worker needs no database and the browser can neither
// read nor change it. The cookie is HttpOnly: scripts on the page never see it either.

export interface Auth {
  login: string
  name: string
  avatar: string
  /** `admin` may also review and merge; `write` may capture. */
  role: 'admin' | 'write'
  access: string
  /** Milliseconds since 1970 when the access token stops working. */
  accessExpires: number
  refresh?: string
  refreshExpires?: number
}

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (text: string): Uint8Array => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function key(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Encrypts anything that survives JSON into a string that is safe in a cookie. */
export async function seal(data: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), encoder.encode(JSON.stringify(data))))
  const out = new Uint8Array(iv.length + encrypted.length)
  out.set(iv)
  out.set(encrypted, iv.length)
  return toBase64Url(out)
}

/** The opposite of `seal`; null for anything that was not sealed with this secret. */
export async function unseal<T>(value: string, secret: string): Promise<T | null> {
  try {
    const bytes = fromBase64Url(value)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(secret), bytes.slice(12))
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } catch {
    return null
  }
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function challengeOf(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
}

/** A Set-Cookie value. `Secure` only on https: Safari refuses it on http://localhost. */
export function setCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

export const SESSION_COOKIE = 'tamandua_session'
export const LOGIN_COOKIE = 'tamandua_login'
export const SESSION_DAYS = 30
