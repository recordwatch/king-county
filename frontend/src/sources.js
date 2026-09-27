// The 4 independently-scraped sources that make up this site. Each has its
// own data/<id>/ directory (separate roster/change_log/status.json) written
// by a separate scraper — see ../../scrapers/*.js and ../../scrape.js.
// Kept in one place since App.jsx, StatBar, and the source filter all need
// the same id/label/cadence info.
export const SOURCES = [
  // scrape.yml's cron is */10, but GitHub drops/delays scheduled runs under
  // load, so the real gap between runs is often longer.
  { id: 'score', label: 'SCORE', cadence: 'Live · runs scheduled every 10 min, actual timing varies' },
  { id: 'kent', label: 'Kent', cadence: 'Live · runs scheduled every 10 min, actual timing varies' },
  { id: 'kirkland', label: 'Kirkland', cadence: 'Live · runs scheduled every 10 min, actual timing varies' },
  { id: 'kc_dajd', label: 'King County DAJD', cadence: 'Periodic · the county republishes this dataset every 1–2 weeks, not live',
    // Per record: only on bookings the DAJD portal hasn't checked yet
    // (entry.statusSource !== 'portal') -- their status still comes from the
    // Socrata feed, republished roughly every 1-2 weeks. Portal-checked
    // records' status is current as of the last portal run.
    lagNote: 'Status from a county dataset that runs 1–2 weeks behind',
    // On counts/totals that include this source.
    totalsNote: "Status from the county's jail lookup, checked about every 2 hours, with some details from a dataset that runs 1–2 weeks behind" },
]

export function sourceLabel(id) {
  return SOURCES.find(s => s.id === id)?.label || id
}

// The note for one record, or null once the DAJD portal has checked it.
export function entryLagNote(entry) {
  if (entry.statusSource === 'portal') return null
  return SOURCES.find(s => s.id === entry.source)?.lagNote || null
}

// For totals that sum every source's in-custody count.
export function combinedLagNote() {
  return SOURCES.filter(s => s.totalsNote)
    .map(s => `${s.label}: ${s.totalsNote.charAt(0).toLowerCase()}${s.totalsNote.slice(1)}`)
    .join(' · ') || null
}
