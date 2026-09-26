// King County DAJD's Socrata feed publishes bookingDate/releasedAt with no
// timezone marker (e.g. "2026-07-16T16:14:55.000"), but the values are UTC --
// confirmed 2026-09-26 against the DAJD lookup portal's own UTC epoch values
// (booking 2026-009861's release: Socrata 16:14:55 == portal 16:14:55Z, same
// exact match on 2026-009929). A bare `new Date()` on a marker-less ISO string
// reads it as the *viewer's* local time instead, so KC DAJD times were shown
// 7-8 hours off. Every other source publishes Pacific wall-clock strings (and
// firstSeen is our own nowPST()), which keep their existing handling.
const UTC_NAIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/

const pacificParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function isUtcNaive(source, raw) {
  return source === 'kc_dajd' && typeof raw === 'string' && UTC_NAIVE_ISO.test(raw)
}

export function parseEntryDate(source, raw) {
  if (!raw) return new Date(NaN)
  return new Date(isUtcNaive(source, raw) ? `${raw}Z` : raw)
}

// { year, month, day, hour, minute } -- in Pacific time for KC DAJD's UTC
// values, otherwise the same local-getter reading every other source already
// used. null if the value doesn't parse.
export function entryDateParts(source, raw) {
  const d = parseEntryDate(source, raw)
  if (isNaN(d.getTime())) return null
  if (!isUtcNaive(source, raw)) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() }
  }
  const p = Object.fromEntries(pacificParts.formatToParts(d).map(x => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute }
}

// Display string for a raw bookingDate/releasedAt/firstSeen value. KC DAJD's
// UTC values become Pacific "MM/DD/YYYY hh:mm AM" (same shape SCORE already
// shows); every other value is returned exactly as stored.
export function displayEntryDate(source, raw) {
  if (!isUtcNaive(source, raw)) return raw
  const p = entryDateParts(source, raw)
  if (!p) return raw
  const pad = n => String(n).padStart(2, '0')
  const h12 = p.hour % 12 || 12
  return `${pad(p.month)}/${pad(p.day)}/${p.year} ${pad(h12)}:${pad(p.minute)} ${p.hour >= 12 ? 'PM' : 'AM'}`
}
