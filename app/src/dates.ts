// A date is kept as EDTF ("1963-07", "196X", "1960/1969", "1963?"); people read it as text: "Juli 1963", "1960er", "1960 – 1969".

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

// year (1963, 196X, 19XX), then month and day (digits, or XX: not known)
const POINT = /^(?<year>\d{4}|\d{3}X|\d{2}XX)(?:-(?<month>\d{2}|XX)(?:-(?<day>\d{2}|XX))?)?(?<mark>[?~%])?$/

function point(text: string): string | undefined {
  const m = POINT.exec(text)
  if (!m?.groups) return undefined
  const { year, month, day, mark } = m.groups
  let words: string
  if (year.endsWith('XX')) words = `${Number(year.slice(0, 2)) + 1}. Jahrhundert` // 19XX: 1900 to 1999
  else if (year.endsWith('X')) words = `${year.slice(0, 3)}0er`
  else {
    const monthNumber = month && month !== 'XX' ? Number(month) : 0
    if (monthNumber < 0 || monthNumber > 12) return undefined
    const dayNumber = monthNumber > 0 && day && day !== 'XX' ? Number(day) : 0
    if (dayNumber > 31) return undefined
    words = `${dayNumber ? `${dayNumber}. ` : ''}${monthNumber ? `${MONTHS[monthNumber - 1]} ` : ''}${year}`
  }
  // ~ is about, ? is uncertain, % is both
  return `${mark === '~' || mark === '%' ? 'ca. ' : ''}${words}${mark === '?' || mark === '%' ? ' (unsicher)' : ''}`
}

/** The date as a person reads it. Something that is not (yet) a date of this kind comes back as it is. */
export function formatDate(edtf: string): string {
  const parts = edtf.trim().split('/')
  if (parts.length > 2) return edtf
  const words = parts.map(point)
  if (words.some((w) => w === undefined)) return edtf
  return words.length === 2 ? `${words[0]} – ${words[1]}` : (words[0] as string)
}
