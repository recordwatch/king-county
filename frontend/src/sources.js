// The 4 independently-scraped sources that make up this site. Each has its
// own data/<id>/ directory (separate roster/change_log/status.json) written
// by a separate scraper — see ../../scrapers/*.js and ../../scrape.js.
// Kept in one place since App.jsx, StatBar, and the source filter all need
// the same id/label/cadence info.
export const SOURCES = [
  { id: 'score', label: 'SCORE', cadence: 'Live · every 30 min' },
  { id: 'kent', label: 'Kent', cadence: 'Live · every 30 min' },
  { id: 'kirkland', label: 'Kirkland', cadence: 'Live · every 30 min' },
  { id: 'kc_dajd', label: 'King County DAJD', cadence: 'Periodic · updated by the county every few days, not live' },
]

export function sourceLabel(id) {
  return SOURCES.find(s => s.id === id)?.label || id
}
