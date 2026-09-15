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
- **Confirmed genuine source lag, not a bug**: as of 2026-09-14 the feed's newest `booking_date_time` is 2026-08-31 and Socrata's own `rowsUpdatedAt` metadata shows 2026-09-02 — the county republishes roughly every 1-2 weeks, so this monitor will always trail real-world bookings by that much. There's no bulk feed available that does better.
- **No bail/bond field exists anywhere in this dataset** (confirmed against the raw schema) — not something we can add from this feed.
- There's a separate public lookup at `dajd-jms.powerappsportals.us/public/subject-lookup/` that surfaces "booked/released in the last 24 hours" and "booked in the last year" views, which could in principle be much fresher than the Socrata feed and might carry bail — but it's a Power Pages "Entity List" widget (Dynamics 365 portal), which fetches results via an internal AJAX/JSON contract (view id + anti-forgery token), not a simple GET/POST form. Investigated far enough to see it's an `EntityList` grid, not far enough to confirm the request contract works for bulk pulls. Worth a dedicated follow-up if the ~2-week lag becomes a real problem, but don't assume it's a drop-in replacement without testing it end to end first.
- Runs on its own daily GitHub Actions schedule (`scrape-kcdajd.yml`), not the 30-min loop — labeled "Periodic" in the frontend's `sources.js`/StatBar, distinct from the other 3 sources' "Live" label.
- Resource id `j56h-zgnm` is stable even though Socrata's public dataset title/date-range gets renamed every year — don't chase the renamed title, the resource id is the permalink.
- **`current_facility` is a real column** (King County Correctional Facility / Maleng Regional Justice Center / Electronic Home Detention / Community Correction Division) — an earlier version of this scraper wrongly assumed no facility field existed and hardcoded a generic "KCCF/MRJC" label. It's blank on most rows (~31k of ~40k), so the generic label is still the fallback, but `kcdajd.js` now uses the real value whenever a charge row on the booking has one.
- Pulls a rolling 60-day window (`WINDOW_DAYS` in `kcdajd.js`), not the full ~13-month/40k-row archive — this is a monitor, not a backfill of the county's whole history (which stays queryable live at data.kingcounty.gov).
- A booking is only marked `released` once *every* charge row on it has a release timestamp — one open charge keeps the whole booking `in_custody` (see `explicitStatus` handling in `lib/runScraper.js`).
- Uses `explicitStatus: true` in `runScrape()` — status/releasedAt come authoritatively from the source data every run, rather than being inferred from an id disappearing off a live roster (the norm for the other 3 sources).

### SCORE (`scrapers/score.js`)
- Static server-rendered HTML, no session/cookie/CAPTCHA gate — confirmed via plain GET.
- **Charges ARE published** — an earlier version of this scraper concluded otherwise and was wrong. The per-person "view" page (POST to `/view` with `nn=<id>`) has a "Current Booking" section with an `<h3>Offenses</h3>` table (Agency/Offense/Cause Number/Offense Status/Bond/Bond Amount per charge) — that's the real current-charge data. What's actually a booking-history-only list is the separate "Booking List" section further down the same page (past booking numbers + release types) — don't confuse the two when reading the markup.
- `scrapeDetailBatch()` fetches the Offenses table per person, same batched/rate-limited pattern as Kirkland. `detailBatchLimit: 40` / `backfillBatch: 50` in `scrape.js` — with ~450 people in custody at a time, the initial backlog takes several 30-min runs to fully backfill after a deploy, which is expected and fine.
- **Release timestamps come from `/recentreleases`, not scrape-detection time.** That page publishes each booking's actual official release timestamp; `fetchReleaseTimes()` builds an `nn -> releasedAt` map from it and `runScrape()` prefers that over "now" when marking someone released, since an id can sit off the roster for up to 30 min before we'd otherwise notice.
- **SCORE periodically goes into a multi-minute "Updating Information!" rebuild window** (confirmed live, hit it repeatedly during testing) where every page -- roster, view, recentreleases -- serves a placeholder instead of real content. `isUpdatingPlaceholder()` detects this (checks for that exact banner text) and the scraper treats it as an empty/unusable response rather than parsing 0 real records or garbage.
- `nn` (Name Number) is the stable per-person id, used as `idnum`.

### Kent (`scrapers/kent.js`)
- ASP.NET MVC app. A plain form `POST /` with `Search.BrowseSelection=All&action:Browse=Browse` returns the full "everyone in custody" table — **no anti-forgery token required**, confirmed via curl.
- The visible 10/25-per-page "pager" is client-side JS (tablesorter) — every row is already in the HTML response, no real pagination to handle.
- Charges come back inline in the table (comma-separated string) as a fallback, but `scrapeDetailBatch()` (below) supplies richer per-charge data whenever it succeeds -- see `runScraper.js`'s `hasDetail`/`complete` handling.
- The "Custody Facility" column is a real, meaningful field, not just a housing-unit label — values include internal unit codes (A/B/C/D/E/F-UNIT) *and* `MRJC/KCCF`, meaning some Kent-booked people are actually housed at King County's facility. Don't collapse this to a generic "Kent Corrections Facility" label.
- One table column is labeled "Release Type" in the header but actually shows a bail dollar amount when the person is still in custody — Kent's own markup quirk, not a scraper bug. Handled by checking for a `$` prefix (`isBail` in `kent.js`).
- `personId` (from the hidden `Search.InmateSearchResults[N].InmateId` fields) is used as the `detailId` for the History endpoint below. Careful: each row also has an unrelated `History.InmateId` hidden field inside its own form — the person-id selector must be scoped to `Search.InmateSearchResults` specifically or the two get misaligned.
- **`POST /` with `History.InmateId=<personId>&action:History=` (empty value -- ASP.NET MVC's multi-submit-button pattern, the key just needs to be present) returns a much richer view**, confirmed live: a Bootstrap accordion (`#inmateCharges > .panel`) with one panel per booking -- `.panel-success` for the current booking, `.panel-default` for every prior booking that person has had at Kent, each going back years. Every panel has a full per-charge breakdown (Warrant/Citation No, RCW/ORD, Charge, Court, Bail) in `.panel-body .row .col-md-6` blocks, not just the roster table's flat comma-joined string.
- `scrapeDetailBatch()` fetches this History endpoint per person (personId is always available fresh every run since Kent's roster page lists everyone currently in custody, unlike Kirkland's small rolling window). Returns `{ charges, priorBookings, complete }` -- `charges` is the current booking's per-charge detail, `priorBookings` is the *full* list of that person's previous Kent bookings with their own per-charge detail (per explicit user request 2026-09-14 -- "I want the data, the HISTORY, and I want all of it we can get" -- not summarized or truncated). `detailBatchLimit: 30` / `backfillBatch: 40` in `scrape.js`.
- Surfaced on `BookingCard.jsx` as a "Booking History (N prior)" section under the current charges, each prior booking shown with its own dates and full charge list -- this is public information already independently searchable on Kent's own site by anyone, just not previously aggregated here.

### Kirkland (`scrapers/kirkland.js`)
- Static HTML table, no charges in the list view — a separate GET per booking to `/jailregister/BookingDetail/<id>` is needed (same rate-limited batching pattern as Pierce/Thurston's detail-page fetch).
- **The roster table's "Release Date" column is overloaded — it is NOT proof of an actual release.** Confirmed live: most populated values are weeks in the future (e.g. a booking date of 8/12 with a "Release Date" of 12/10) -- it's a projected/scheduled release date for someone still serving time, not a release event. An earlier version of this scraper treated any populated value as "already released," which produced future-dated entries on the Released/History tabs. Fixed: `scrapeRoster()` now only treats it as a real release if the parsed date is `<=` now; otherwise the person stays `in_custody` and the value is stored as `scheduledReleaseDate` (shown on the card, not treated as an outcome).
- The internal detail-page id (e.g. `-45140`) is only exposed in the roster list's link `href`, keyed by booking number in a module-level `Map` (`detailIdCache` in `kirkland.js`) populated during `scrapeRoster()` and consumed by `scrapeDetailBatch()` within the same run. It's also persisted onto each roster entry's `detailId` field (via `runScraper.js`) so backfill can still resolve it once a booking scrolls off Kirkland's small ~15-30 row rolling window and stops appearing in the in-memory cache.
- "Location" is a real multi-facility field — Kirkland PD books people into its own "KPD Jail" holding, King County's "KCJ", or "Score" depending on the case.
- A bond amount can be set before any charge description is published — if the charge table is empty but a bond amount exists, a placeholder `{ charge: 'Charge pending', bail }` entry is created rather than silently dropping the bail info (zero-dollar bonds are filtered out as not meaningful).
- **A detail fetch that only returns the bail placeholder (no real charge yet) must NOT be treated as done.** `parseDetail()` returns `complete: charges.some(c => c.charge !== 'Charge pending')`; `runScraper.js` only sets `hasDetail: true` when `complete` is true, so people whose formal charges haven't been filed yet keep getting retried on later runs instead of being frozen with empty/placeholder data forever (this was a real production bug -- several in-custody people were stuck showing only "Charge pending" indefinitely). Same `complete` convention is used by SCORE's detail fetch.
- Only shows a small rolling window of recent activity (~15-30 rows), not full history — the archive only grows from whenever polling started, like every other county's cold-start.

### WA DOC Incarcerated Search (`scrapers/wadoc.js`, source id `wadoc`)
- Used only for cross-referencing county releases against WA DOC custody (see "WA DOC Cross-Reference" below) -- not one of the 4 jail sources, not in `frontend/src/sources.js`'s source filter, no in-custody count of its own.
- **Correction (2026-09-15): an earlier investigation wrongly concluded this required VINE/headless-browser automation. It does not.** `https://doc.wa.gov/records/incarcerated-data-search/incarcerated-search` is a plain Drupal Views page -- a real, simple, paginated HTML `<table>` (DOC Number, Name, Age, Location/facility, Housing Assignment), no JS/session/auth required, confirmed via plain `curl`. The mistake: a WebFetch summary of the page conflated an unrelated "sign up for VINE notifications" callout elsewhere on the page with the actual search tool, and that summary was trusted instead of reading the raw HTML directly -- exactly the failure mode [[feedback_jail_roster_workflow]] warns about. Each name links out to a VINE offender-detail page for supplementary info, but the bulk browsable listing itself is not VINE.
- **Fully bulk-browsable, not search-only**: `?page=0..~141` (confirmed via the page's own pager, ~100 rows/page) walks the entire statewide incarcerated population, roughly 14,000 people, with no name/DOC-number filter needed. Optional GET params for a targeted lookup: `field_doc_number_value`, `field_first_name_value`, `field_last_name_value` on the same URL.
- **A "receiving unit" is identifiable from the facility/Location string alone** -- confirmed with the user: `"Washington Corrections Center - RC"` (men) and `"Washington Corrections Center for Women - Receiving"` (women) are the two receiving-facility values. `RECEIVING_FACILITY` regex in `lib/crossReferenceDOC.js`.
- Runs on its own daily schedule (`scrape-wadoc.yml`), after KCDAJD's daily refresh -- not a live roster to diff, so it doesn't go through `runScrape()`; `scrape.js`'s `runWADOC()` just writes a flat snapshot (`data/wadoc/roster.json`) and then runs the cross-reference.

## WA DOC Cross-Reference (`lib/crossReferenceDOC.js`)
Detects jail-to-prison transfers: someone who disappears from a county's live custody list and later shows up in WA DOC custody almost certainly wasn't "released" in the everyday sense. Built 2026-09-15 per explicit user direction, with a specific matching policy designed to avoid publicly misattributing someone's DOC record based on a coincidental same name. A match is only ever recorded if **all** of:
1. The person disappeared from a county's live custody list (existing diff-based release detection) at least `THRESHOLD_DAYS` (3) ago -- gives real transfer paperwork time to show up in DOC's system.
2. The county's own release reason, when available, isn't an obvious non-transfer (`BAIL_LIKE` regex: bond/bail/personal recognizance) -- people released on bail don't show up in DOC the next day, so there's no reason to even check those. **Only reliably available for KC DAJD** (explicit `release_reason` field in the Socrata data) **and SCORE** (one extra per-release fetch of that person's Booking List "Release Type", added to `score.js`'s `fetchReleaseTimes()`). Kent and Kirkland don't expose a usable release-reason signal (Kirkland's `BookingDetail` page goes empty once someone is actually released -- confirmed live; Kent has no clean release-outcome field) -- for those two sources this pre-filter is skipped entirely and steps 1/3/4 carry the full weight of avoiding false positives.
3. The name match against the DOC roster is **exact and unambiguous** -- if more than one DOC inmate shares that normalized name, it's recorded as `ambiguous: true` and deliberately NOT published as a match.
4. The matched DOC record's facility is a **receiving unit** (see WA DOC quirks above) -- that's where someone freshly transferred in from county custody actually shows up. Tested and confirmed against a real case (KC DAJD booking 2026-009974, "Transfer of Custody" release, later found in DOC's general population at Washington State Penitentiary) -- receiving-only is a real precision/recall trade-off (it can miss transfers who've already moved past intake by the time we check), but the user confirmed receiving units typically hold someone 3 weeks to 3 months, which comfortably covers the ~2-week KC DAJD lag + 3-day threshold in most cases, so this was kept as originally specified rather than loosened.
- Checked once, at the 3-day mark, not continuously -- results (match or no-match) are cached in `data/wadoc/matches.json` keyed by `{ [source]: { [idnum]: {...} } }` and never re-checked.
- Kept as its own file rather than mutating each source's own `roster.json`/`change_log.json`, so this never risks conflicting with the 30-min live-source workflow's writes -- same "independent files, merge client-side" pattern as the other 4 sources. `App.jsx`'s `loadCombinedLog()` fetches `data/wadoc/matches.json` and attaches `entry.docMatch` to any log entry with an unambiguous match; `BookingCard.jsx` shows a "Now in WA DOC custody" banner when present.

## Key files
- `scrape.js` — CLI entrypoint: `node scrape.js <score|kent|kirkland|kcdajd|wadoc|all>` (`all` = the 3 live sources only; `wadoc` runs the DOC scrape + cross-reference and ignores any other sources listed alongside it)
- `lib/runScraper.js` — shared diff/release-detection/file-write engine used by the 4 jail scrapers; see `explicitStatus`, `fetchDetailBatch`, and `fetchReleaseTimes` params for how each source's differences are handled
- `lib/crossReferenceDOC.js` — WA DOC cross-reference matching logic, see the section above
- `scrapers/*.js` — one fetch module per source, see quirks above (`wadoc.js` is the reference-dataset scraper, not a jail roster)
- `utils.js` — `nowPST()` helper (same as every sibling repo)
- `data/<source>/{roster,change_log,status}.json` — per-source state; `roster.json` is scraper-internal only, the frontend only reads `change_log.json` + `status.json`. `data/wadoc/` instead has `roster.json` (flat DOC snapshot), `status.json`, and `matches.json` (cross-reference results).
- `.github/workflows/scrape.yml` — 30-min cron for score/kent/kirkland
- `.github/workflows/scrape-kcdajd.yml` — daily cron for King County DAJD
- `.github/workflows/scrape-wadoc.yml` — daily cron for the WA DOC scrape + cross-reference
- `frontend/src/sources.js` — the 4-source registry (id/label/cadence) shared by `App.jsx`, `StatBar.jsx`, `BookingCard.jsx` (WA DOC is intentionally not in this list -- it's not a jail roster)
- `frontend/src/App.jsx` — fetches + merges all 4 sources' JSON, adds the source filter dropdown on top of the standard search/status tabs, and merges in `data/wadoc/matches.json` as `entry.docMatch`
- `frontend/src/components/StatBar.jsx` — combined in-custody total plus a per-source breakdown row (each with its own last-updated timestamp, since King County DAJD updates far less often than the other 3)

## Data format
- Same shared shape as every sibling county, plus a few extra fields: `source` (`score`/`kent`/`kirkland`/`kc_dajd`), a real per-entry `facility` string, `scheduledReleaseDate` (a projected/future release date some sources publish for people still in custody -- NOT evidence of an actual release, see Kirkland/SCORE quirks above), `detailId` (Kirkland/Kent, the internal detail-page id or personId used for that source's detail fetch), `priorBookings` (Kent-only, that person's full previous-booking history at Kent, each with its own per-charge breakdown -- `null` for every other source), and `releaseReason` (KC DAJD/SCORE only, used by the WA DOC cross-reference -- `null` for Kent/Kirkland).
- Full shape: `{ idnum, source, facility, bookingNumber, name, status, firstSeen, releasedAt, releaseReason, scheduledReleaseDate, detailId, bookingDate, charges[], priorBookings, hasDetail }`
- Roster keys (`idnum`) are booking numbers for Kent/Kirkland/King County DAJD, but SCORE's "Name Number" (`nn`) for SCORE — none of these id spaces overlap across sources, and entries are always looked up as `${source}:${idnum}` in the frontend (see `BookingLog`'s React `key`).
- `hasDetail` means "we have real, formally-filed charge data" for sources with a separate detail fetch (Kirkland, SCORE, Kent) -- not just "we attempted a fetch." An attempt that only turns up a bail placeholder or nothing yet leaves `hasDetail: false` so later runs keep retrying instead of freezing incomplete data in permanently.
- `docMatch` (frontend-only, attached by `App.jsx`, not stored in the source's own files) -- present only on released entries with a confirmed, unambiguous WA DOC cross-reference match: `{ docNumber, facility, housingAssignment, ambiguous: false, ... }`.

## Color scheme
- Steel/brass theme — dark charcoal background (#14181C), brass/gold accent (#C9A227), distinct from every sibling county (Kitsap=blue, Pierce=green, Thurston=amber/bronze, Whatcom=violet/storm, Grays Harbor=teal/harbor).

## Related projects
- **Whatcom Jail Monitor** — https://theonlytacocat.github.io/whatcom-jail-monitor/ (the structural template this repo is based on)
- **Kitsap / Pierce / Thurston / Mason / Grays Harbor / Clallam** — see `~/.claude/projects/-home-alexa-projects/memory/project_jail_roster_monitors.md` for the full sibling list
- **Washington Jail Data hub** — https://wajaildata.org — linked from `mason-jail-roster/server.js`'s `.nav-section`

## Live
- Repo: https://github.com/recordwatch/king-county (note: not `king-county-jail-roster` -- the user asked to use the already-existing empty `king-county` repo name instead)
- Site: https://recordwatch.github.io/king-county/

## Known open items (raised by the user 2026-09-14/15, not yet built)
These are real product/scope decisions, not bugs -- flagged here so future work doesn't have to rediscover them:
- **More Snohomish/King-county-adjacent sources**: Issaquah (`jailroster.issaquahwa.gov/jail/index.html`), Lynnwood/Snohomish County/Marysville (all three served off the same `jailregister.sno911.org/<City>` platform, likely one scraper pattern covers all three). Issaquah is a King County city (could extend this repo); Lynnwood/Snohomish/Marysville are Snohomish County (probably a new sibling repo following this repo's multi-agency template, per [[project_jail_roster_monitors]]). Not investigated yet -- treat like SCORE/Kirkland were at the start of this repo: check the actual markup before assuming anything.
- **Cross-source/cross-county identity matching** (same person appearing in King County + another county's monitor). The user acknowledged common names make this hard and wants "contextual clues" -- no design proposed yet.
- **King County DAJD's subject-lookup portal** (`dajd-jms.powerappsportals.us/public/subject-lookup/`) as a fresher/richer replacement for the laggy Socrata feed -- see the KCDAJD quirks section above for what's been confirmed so far (it's a Power Pages Entity List, not a simple form).
