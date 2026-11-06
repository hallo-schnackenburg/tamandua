// ULID: 26 characters, sortable by creation time. 10 characters of time
// (milliseconds) and 16 of randomness, written in Crockford base32 (no I, L, O, U).
// The id is created once, when a draft is started, and never derived from content.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(
  now: number = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  let time = ''
  let rest = now
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[rest % 32] + time
    rest = Math.floor(rest / 32)
  }
  const bytes = random(new Uint8Array(16))
  let tail = ''
  for (const byte of bytes) tail += ALPHABET[byte % 32]
  return time + tail
}
