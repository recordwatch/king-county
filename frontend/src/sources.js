import { entryDateParts } from './dates.js'

// The 5 independently-scraped sources that make up this site. Each has its
// own data/<id>/ directory (separate roster/change_log/status.json) written
// by a separate scraper — see ../../scrapers/*.js and ../../scrape.js.
// Kept in one place since App.jsx, StatBar, and the source filter all need
// the same id/label/cadence info.
export const SOURCES = [
  // scrape.yml is started every 30 minutes by an external scheduler
  // (cron-job.org), not GitHub's own cron -- see CLAUDE.md.
  { id: 'score', label: 'SCORE', cadence: 'Live · checked every 30 min' },
  { id: 'kent', label: 'Kent', cadence: 'Live · checked every 30 min' },
  { id: 'kirkland', label: 'Kirkland', cadence: 'Live · checked every 30 min' },
  { id: 'issaquah', label: 'Issaquah', cadence: 'Live · checked every 30 min' },
  { id: 'kc_dajd', label: 'King County DAJD', cadence: 'Periodic · the county republishes this dataset every 1–2 weeks, not live',
    // Per record: only on in-custody bookings the DAJD portal hasn't checked
    // yet (entry.statusSource !== 'portal') and that the portal's last full
    // check didn't miss (those get entryLagNote()'s "Not found" note
    // instead) -- "in custody" there still comes
    // from the Socrata feed, republished roughly every 1-2 weeks, so it may
    // no longer be true. A release is a settled fact either way, and
    // portal-checked records are current as of the last portal run.
    lagNote: 'Status from a county dataset that runs 1–2 weeks behind',
    // On counts/totals that include this source.
    totalsNote: "Status from the county's jail lookup, checked about every 2 hours, with some details from a dataset that runs 1–2 weeks behind" },
]

export function sourceLabel(id) {
  return SOURCES.find(s => s.id === id)?.label || id
}

// "MM/DD/YYYY" in Pacific time for a KC portalMissing timestamp (marker-less
// UTC ISO); null if it doesn't parse, so no date is claimed.
function portalMissingDate(raw) {
  const p = entryDateParts('kc_dajd', raw)
  if (!p) return null
  const pad = n => String(n).padStart(2, '0')
  return `${pad(p.month)}/${pad(p.day)}/${p.year}`
}

// The note for one in-custody record (null for released ones):
// - the portal's last full check didn't list it (portalMissing), portal-
//   checked or not: "Not found on the county's jail lookup since <date>",
//   since its status may be out of date whichever side set it;
// - otherwise, not yet checked by the DAJD portal: the Socrata lag note;
// - portal-checked and still listed: none.
export function entryLagNote(entry) {
  if (entry.status !== 'in_custody') return null
  if (entry.source === 'kc_dajd' && entry.portalMissing) {
    const since = portalMissingDate(entry.portalMissing)
    return since
      ? `Not found on the county's jail lookup since ${since}; status may be out of date`
      : "Not found on the county's jail lookup; status may be out of date"
  }
  if (entry.statusSource === 'portal') return null
  return SOURCES.find(s => s.id === entry.source)?.lagNote || null
}

// For totals that sum every source's in-custody count.
export function combinedLagNote() {
  return SOURCES.filter(s => s.totalsNote)
    .map(s => `${s.label}: ${s.totalsNote.charAt(0).toLowerCase()}${s.totalsNote.slice(1)}`)
    .join(' · ') || null
}
