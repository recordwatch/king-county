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
    // Shown wherever this source's in-custody/released status appears --
    // the Socrata feed it comes from is republished roughly every 1-2 weeks,
    // so a status can be stale by that much (see CLAUDE.md's KC DAJD quirks).
    lagNote: 'Status from a county dataset that runs 1–2 weeks behind' },
]

export function sourceLabel(id) {
  return SOURCES.find(s => s.id === id)?.label || id
}

export function sourceLagNote(id) {
  return SOURCES.find(s => s.id === id)?.lagNote || null
}

// For totals that sum every source's in-custody count -- names whichever
// sources carry a lagNote so the combined number isn't read as fully live.
export function combinedLagNote() {
  const lagging = SOURCES.filter(s => s.lagNote).map(s => s.label)
  return lagging.length ? `Includes ${lagging.join(', ')}, whose status runs 1–2 weeks behind` : null
}
