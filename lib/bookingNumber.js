// One normalizer for KC DAJD booking numbers, used identically by the
// Socrata scraper (scrapers/kcdajd.js) and the portal scraper
// (scrapers/kcportal.js) -- a booking is matched across the two sources
// purely by this key, so both sides must produce it the same way.
//
// Two formats exist on the DAJD portal (confirmed 2026-09-26): the current
// "YYYY-NNNNNN" (e.g. 2026-012367) and an older 9-digit form still carried by
// long-running bookings (e.g. 221005753, booked 2021). This deliberately does
// NOT convert between them -- there's no confirmed mapping, and Socrata's
// representation of old-format bookings hasn't been verified (every booking
// our 60-day window has ever held is new-format). Whitespace is the only thing
// normalized; anything matching neither known shape is logged, not rewritten.
const KNOWN_FORMATS = [/^\d{4}-\d{6}$/, /^\d{9}$/];

export function normalizeBookingNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s || null;
}

export function isKnownBookingFormat(bookingNumber) {
  return !!bookingNumber && KNOWN_FORMATS.some(re => re.test(bookingNumber));
}
