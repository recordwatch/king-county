# King County Jail Roster — Project Context

## What it is
A public jail roster monitor covering King County, WA — but unlike the sibling
county repos, "King County" isn't one sheriff's feed. It's 4 independently
scraped systems combined into one lookup site: King County DAJD (KCCF & MRJC),
SCORE (regional jail for Auburn/Burien/Des Moines/Normandy Park/SeaTac/Tukwila),
Kent's own Corrections Facility, and Kirkland PD (via NORCOM).

## URLs
- **Live site:** (not deployed yet — will be https://recordwatch.github.io/king-county-jail-roster/ once GitHub Pages is enabled)
- **GitHub repo:** not yet created — will live at github.com/recordwatch/king-county-jail-roster
- **Sources:**
  - King County DAJD: https://data.kingcounty.gov/resource/j56h-zgnm.json (Socrata Open Data)
  - SCORE: https://jils.scorejail.org/roster
  - Kent: https://jils.kentwa.gov/
  - Kirkland: https://pd.norcom.org/jailregister/

## Architecture
- **4 independent scrapers**, each writing to its own `data/<source>/{roster,change_log,status}.json` — this avoids any risk of two differently-scheduled GitHub Actions workflows (30-min live sources vs. daily King County sync) clobbering each other's writes to a shared file.
- `scrape.js <source>` runs one source through the shared diff/write engine in `lib/runScraper.js`. `node scrape.js all` runs the 3 live sources (score, kent, kirkland); King County DAJD is invoked separately as `node scrape.js kcdajd`.
- **Frontend:** React + Vite, same as every sibling repo, but `App.jsx` fetches all 4 sources' JSON in parallel and merges the arrays (see `frontend/src/sources.js` and the `loadCombinedLog`/`loadCombinedStatus` helpers) rather than reading one flat file.
- **Data storage:** JSON files committed to git in `data/<source>/` — no server, no database.
- **Hosting cost:** $0.

## Per-source quirks

### King County DAJD (`scrapers/kcdajd.js`, source id `kc_dajd`)
- **Not a live roster.** King County's own public lookup (dajd-jms.powerappsportals.us) is search-by-last-name only — no bulk/browse mode, so it can't be polled like a normal roster. The only bulk source is the Socrata Open Data feed, which is a booking-*event* log (one row per charge) that the county itself only republishes every few days.
- Runs on its own daily GitHub Actions schedule (`scrape-kcdajd.yml`), not the 30-min loop — labeled "Periodic" in the frontend's `sources.js`/StatBar, distinct from the other 3 sources' "Live" label.
- Resource id `j56h-zgnm` is stable even though Socrata's public dataset title/date-range gets renamed every year — don't chase the renamed title, the resource id is the permalink.
- No facility column in this feed — KCCF vs MRJC isn't distinguishable, so every entry is labeled generically "King County DAJD (KCCF/MRJC)".
- Pulls a rolling 60-day window (`WINDOW_DAYS` in `kcdajd.js`), not the full ~13-month/40k-row archive — this is a monitor, not a backfill of the county's whole history (which stays queryable live at data.kingcounty.gov).
- A booking is only marked `released` once *every* charge row on it has a release timestamp — one open charge keeps the whole booking `in_custody` (see `explicitStatus` handling in `lib/runScraper.js`).
- Uses `explicitStatus: true` in `runScrape()` — status/releasedAt come authoritatively from the source data every run, rather than being inferred from an id disappearing off a live roster (the norm for the other 3 sources).

### SCORE (`scrapers/score.js`)
- Static server-rendered HTML, no session/cookie/CAPTCHA gate — confirmed via plain GET.
- **No charge information is published anywhere on the public SCORE JILS site.** The per-person "view" page (POST to `/view` with `nn=<id>`) looked like it might have charges but is actually a *booking history* list (past booking numbers + release types), not current charges. `charges` is permanently `[]` for this source — `BookingCard.jsx` shows a source-specific explanatory message instead of the generic "check back shortly" text.
- `nn` (Name Number) is the stable per-person id, used as `idnum`.

### Kent (`scrapers/kent.js`)
- ASP.NET MVC app. A plain form `POST /` with `Search.BrowseSelection=All&action:Browse=Browse` returns the full "everyone in custody" table — **no anti-forgery token required**, confirmed via curl.
- The visible 10/25-per-page "pager" is client-side JS (tablesorter) — every row is already in the HTML response, no real pagination to handle.
- Charges come back inline in the table (comma-separated string, split into a `charges[]` array) — no separate detail fetch needed, unlike SCORE/Kirkland.
- The "Custody Facility" column is a real, meaningful field, not just a housing-unit label — values include internal unit codes (A/B/C/D/E/F-UNIT) *and* `MRJC/KCCF`, meaning some Kent-booked people are actually housed at King County's facility. Don't collapse this to a generic "Kent Corrections Facility" label.
- One table column is labeled "Release Type" in the header but actually shows a bail dollar amount when the person is still in custody — Kent's own markup quirk, not a scraper bug. Handled by checking for a `$` prefix (`isBail` in `kent.js`).
- `personId` (from the hidden `Search.InmateSearchResults[N].InmateId` fields) is captured separately from `idnum` (booking number) for potential future recidivism tracking. Careful: each row also has an unrelated `History.InmateId` hidden field inside its own form — the person-id selector must be scoped to `Search.InmateSearchResults` specifically or the two get misaligned.

### Kirkland (`scrapers/kirkland.js`)
- Static HTML table, no charges in the list view — a separate GET per booking to `/jailregister/BookingDetail/<id>` is needed (same rate-limited batching pattern as Pierce/Thurston's detail-page fetch).
- The internal detail-page id (e.g. `-45140`) is only exposed in the roster list's link `href`, keyed by booking number in a module-level `Map` (`detailIdCache` in `kirkland.js`) populated during `scrapeRoster()` and consumed by `scrapeDetailBatch()` within the same run.
- "Location" is a real multi-facility field — Kirkland PD books people into its own "KPD Jail" holding, King County's "KCJ", or "Score" depending on the case.
- A bond amount can be set before any charge description is published — if the charge table is empty but a bond amount exists, a placeholder `{ charge: 'Charge pending', bail }` entry is created rather than silently dropping the bail info (zero-dollar bonds are filtered out as not meaningful).
- Only shows a small rolling window of recent activity (~15-30 rows), not full history — the archive only grows from whenever polling started, like every other county's cold-start.

## Key files
- `scrape.js` — CLI entrypoint: `node scrape.js <score|kent|kirkland|kcdajd|all>` (`all` = the 3 live sources only)
- `lib/runScraper.js` — shared diff/release-detection/file-write engine used by all 4 scrapers; see `explicitStatus` and `fetchDetailBatch` params for how each source's differences are handled
- `scrapers/*.js` — one fetch module per source, see quirks above
- `utils.js` — `nowPST()` helper (same as every sibling repo)
- `data/<source>/{roster,change_log,status}.json` — per-source state; `roster.json` is scraper-internal only, the frontend only reads `change_log.json` + `status.json`
- `.github/workflows/scrape.yml` — 30-min cron for score/kent/kirkland
- `.github/workflows/scrape-kcdajd.yml` — daily cron for King County DAJD
- `frontend/src/sources.js` — the 4-source registry (id/label/cadence) shared by `App.jsx`, `StatBar.jsx`, `BookingCard.jsx`
- `frontend/src/App.jsx` — fetches + merges all 4 sources' JSON, adds the source filter dropdown on top of the standard search/status tabs
- `frontend/src/components/StatBar.jsx` — combined in-custody total plus a per-source breakdown row (each with its own last-updated timestamp, since King County DAJD updates far less often than the other 3)

## Data format
- Same shared shape as every sibling county, plus two new fields: `source` (`score`/`kent`/`kirkland`/`kc_dajd`) and a real per-entry `facility` string.
- Full shape: `{ idnum, source, facility, bookingNumber, name, status, firstSeen, releasedAt, bookingDate, charges[], hasDetail }`
- Roster keys (`idnum`) are booking numbers for Kent/Kirkland/King County DAJD, but SCORE's "Name Number" (`nn`) for SCORE — none of these id spaces overlap across sources, and entries are always looked up as `${source}:${idnum}` in the frontend (see `BookingLog`'s React `key`).

## Color scheme
- Steel/brass theme — dark charcoal background (#14181C), brass/gold accent (#C9A227), distinct from every sibling county (Kitsap=blue, Pierce=green, Thurston=amber/bronze, Whatcom=violet/storm, Grays Harbor=teal/harbor).

## Related projects
- **Whatcom Jail Monitor** — https://theonlytacocat.github.io/whatcom-jail-monitor/ (the structural template this repo is based on)
- **Kitsap / Pierce / Thurston / Mason / Grays Harbor / Clallam** — see `~/.claude/projects/-home-alexa-projects/memory/project_jail_roster_monitors.md` for the full sibling list
- **Washington Jail Data hub** — https://wajaildata.org — add a nav entry once this site is live, in `mason-jail-roster/server.js` around the `.nav-section` block

## Setup steps still needed
1. Create the `recordwatch/king-county-jail-roster` GitHub repo, `git remote add origin` + push (scaffolded locally only so far — confirm with the user before creating/pushing per established convention)
2. Enable GitHub Pages (Settings → Pages → deploy from `gh-pages` branch)
3. Trigger both `scrape.yml` and `scrape-kcdajd.yml` once manually (`workflow_dispatch`) to confirm each runs end-to-end in CI
4. Add the King County link to `mason-jail-roster/server.js`'s `.nav-section` (wajaildata.org hub)
