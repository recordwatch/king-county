import axios from 'axios';
import * as cheerio from 'cheerio';

// SCORE (South Correctional Entity) — regional jail serving Auburn, Burien,
// Des Moines, Normandy Park, SeaTac, and Tukwila. Server-rendered HTML, no
// JS/API call and no session/cookie gate needed — confirmed via direct GET.
const ROSTER_URL = 'https://jils.scorejail.org/roster';
const VIEW_URL = 'https://jils.scorejail.org/view';
const RECENT_RELEASES_URL = 'https://jils.scorejail.org/recentreleases';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// SCORE runs a nightly/periodic full rebuild during which every page
// (including /roster) briefly serves an "Updating Information!" placeholder
// instead of real content — confirmed live, lasting a few minutes. Treat it
// as an unusable response rather than parsing it as 0 real records.
function isUpdatingPlaceholder(html) {
  return /Updating Information/i.test(html);
}

function cleanText(s) {
  return (s || '').replace(/ /g, ' ').trim();
}

function parseField($, row) {
  const label = cleanText($(row).find('b').first().text()).replace(/:\s*$/, '').toLowerCase();
  const value = cleanText($(row).find('li').first().text());
  return [label, value];
}

// Generic parser for SCORE's repeating "list of .uk-panel rows" markup,
// used by the roster, recentreleases, and per-person view pages alike.
function parsePanels($, scope) {
  const out = [];
  scope.find('> div.uk-panel').not('.sc-heading-container').each((_, el) => {
    const fields = {};
    $(el).find('> .row').each((__, row) => {
      const [label, value] = parseField($, row);
      if (label) fields[label] = value;
    });
    out.push(fields);
  });
  return out;
}

// A single roster GET timing out (confirmed 2026-09-28 04:00 UTC, "timeout of
// 30000ms exceeded", recovered by the next run) shouldn't cost a whole run,
// so a failed request is retried once after a short pause. Only the request
// itself is retried: an "Updating Information" response is a successful
// request and still skips the run below, since the rebuild lasts minutes.
const ROSTER_RETRY_DELAY_MS = 12000;

async function getRosterPage() {
  try {
    return await axios.get(ROSTER_URL, { headers: HEADERS, timeout: 30000 });
  } catch (err) {
    console.log(`  SCORE roster request failed (${err.message}) -- retrying once in ${ROSTER_RETRY_DELAY_MS / 1000}s`);
    await new Promise(resolve => setTimeout(resolve, ROSTER_RETRY_DELAY_MS));
    return axios.get(ROSTER_URL, { headers: HEADERS, timeout: 30000 });
  }
}

export async function scrapeRoster() {
  const res = await getRosterPage();
  if (isUpdatingPlaceholder(res.data)) {
    const err = new Error('SCORE is mid-rebuild ("Updating Information") -- skipping this run.');
    err.expectedEmpty = true;
    throw err;
  }
  const $ = cheerio.load(res.data);

  const inmates = [];
  for (const fields of parsePanels($, $('.list'))) {
    const nameNumber = fields['name number'];
    if (!nameNumber) continue;

    inmates.push({
      idnum: nameNumber,
      bookingNumber: fields['booking number'],
      name: `${fields['last name']}, ${[fields['first name'], fields['middle name']].filter(Boolean).join(' ')}`.trim(),
      facility: 'SCORE',
      bookingDate: fields['date booked'],
      status: 'in_custody',
      charges: [],
    });
  }

  return inmates;
}

// The public roster list has no charge info, but the per-person "view" page
// does -- under "Current Booking" there's an "Offenses" table (confirmed
// live) with Agency/Offense/Cause Number/Offense Status/Bond/Bond Amount
// per charge. Requires one POST per person (nn=<Name Number>), so it's
// batched/rate-limited the same way as Kirkland's per-booking detail fetch.
function parseOffenses($) {
  const charges = [];
  $('h3').filter((_, el) => cleanText($(el).text()) === 'Offenses').each((_, h3) => {
    const panels = parsePanels($, $(h3).next('.list'));
    for (const f of panels) {
      if (!f['offense']) continue;
      charges.push({
        charge: f['offense'],
        arrestAgency: f['agency'] || null,
        causeNumber: f['cause number'] || null,
        disposition: f['offense status'] || null,
        bondType: f['bond'] || null,
        bail: f['bond amount'] || null,
      });
    }
  });
  return charges;
}

// Once someone's released, their view page's "Current Booking" section
// permanently reads "No current custody booking record" instead of having
// an Offenses table at all -- confirmed live 2026-09-26. There's no future
// run where that person will suddenly have charges again, so charges.length
// > 0 can never become true for them; treating that state as complete too
// (rather than perpetually incomplete) stops the backfill pass from wasting
// its fixed per-run slot count re-fetching the same already-hopeless
// records forever, which was starving genuinely-pending in_custody people
// out of ever getting backfilled (confirmed: 131 of 163 SCORE hasDetail:false
// records were exactly this case).
function hasNoCurrentBooking(html) {
  return /No current custody booking record/i.test(html);
}

// SCORE renders this literal text in place of a section with zero rows to
// show, rather than an empty-but-well-formed section -- confirmed live: it's
// SCORE's actual "nothing here" state for the Booking List, not a rare
// glitch (all 58 of SCORE's then-empty bookingHistory records showed it,
// alongside an otherwise-intact page). Whether an empty Booking List is
// trustworthy depends on custody status, not on this text alone: an
// in_custody person can genuinely have zero prior bookings (a first-time
// booking -- confirmed via nn recency, see scrapeDetailBatch), but a
// released person can never legitimately have zero bookings at all (their
// own most-recent one would always be listed) -- confirmed on EMERY/RIVERO,
// whose page also failed to render the Person-details block, a released
// person with zero bookings being structurally impossible.
function hasUnableToDisplay(html) {
  return /Unable to display/i.test(html);
}

export async function scrapeDetailBatch(nameNumbers) {
  const results = {};
  for (const nn of nameNumbers) {
    let res;
    try {
      res = await axios.post(VIEW_URL, new URLSearchParams({ nn }), { headers: HEADERS, timeout: 20000 });
    } catch (err) {
      console.warn(`  Detail fetch failed for nn=${nn}:`, err.message);
      continue;
    }
    // If SCORE is mid-rebuild, every remaining request in this batch will
    // hit the same placeholder -- stop instead of burning through the rest
    // of the batch one at a time for nothing (confirmed live: a batch this
    // size can span long enough to run into one of SCORE's multi-minute
    // rebuild windows partway through).
    if (isUpdatingPlaceholder(res.data)) {
      console.warn(`  SCORE is mid-rebuild -- stopping detail batch early (${Object.keys(results).length}/${nameNumbers.length} fetched).`);
      break;
    }
    const $ = cheerio.load(res.data);
    const charges = parseOffenses($);
    const noCurrentBooking = hasNoCurrentBooking(res.data);
    // Booking List comes from the same page load as Offenses -- no extra
    // request needed to also store this person's full booking history.
    const parsedHistory = parseBookingList($);
    // "No current custody booking record" is its own independent, reliable
    // signal (matches ground truth for every released record checked, even
    // alongside an "Unable to display" Booking List) -- charges completeness
    // is decided by it alone, regardless of Booking List rendering.
    const complete = charges.length > 0 || noCurrentBooking;
    // A confirmed-empty ("Unable to display") Booking List means something
    // different depending on custody status: in_custody + empty = a genuine
    // first booking, final (store []); released + empty is impossible, so
    // leave it unresolved (null) to be retried rather than stored as final.
    const confirmedEmpty = hasUnableToDisplay(res.data) && parsedHistory.length === 0;
    const bookingHistory = confirmedEmpty ? (noCurrentBooking ? null : []) : parsedHistory;
    results[nn] = { charges, bookingHistory, complete };
  }
  return results;
}

// The per-person view page's "Booking List" section publishes that person's
// full booking history at SCORE -- confirmed live back to 2012+ for at least
// one person -- with all 4 columns: Booking Number, Date Booked, Date
// Released, and Release Type (e.g. "RELEASED - COURT ORDER", "RELEASED -
// SENTENCE COMPLETED", "PERSONAL RECOGNIZANCE"). Still fetchable long after
// someone's released -- confirmed live, the page just shows "No current
// custody booking record" for Current Booking and renders Booking List as
// normal. Used both to store a person's booking history and, in
// recheckDetectedReleases() below, to find the authoritative release time
// for a booking /recentreleases couldn't give us.
function parseBookingList($) {
  const rows = [];
  $('h1').filter((_, el) => cleanText($(el).text()) === 'Booking List').each((_, h1) => {
    for (const f of parsePanels($, $(h1).next('.list'))) {
      if (!f['booking number']) continue;
      rows.push({
        bookingNumber: f['booking number'],
        dateBooked: f['date booked'] || null,
        dateReleased: f['date released'] || null,
        releaseType: f['release type'] || null,
      });
    }
  });
  return rows;
}

function isValidScoreDate(s) {
  return !!s && !isNaN(new Date(s).getTime());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Space out /view requests during the recheck pass below so a backlog of
// pending releases doesn't turn into a burst of simultaneous hits on SCORE.
const RECHECK_DELAY_MS = 400;

// SCORE's own /recentreleases feed publishes the authoritative release
// timestamp for each booking -- using it instead of our own scrape-detection
// time avoids up to 30 min of error from polling cadence alone. Returns
// every release row on the page (not deduped by nn) -- the same nn can
// legitimately appear more than once if that person was released, rebooked,
// and released again, and collapsing to one entry per nn would silently
// lose whichever row didn't win. Callers match by (nn, bookingNumber) first
// and fall back to nn alone. Also looks up the release reason (Booking
// List's "Release Type") for just the ids that were actually released this
// run, since /recentreleases itself doesn't have that column -- one extra
// request per distinct nn, not per row or per person in custody, so volume
// stays low even for someone with two release rows in the same batch.
export async function fetchReleaseTimes(releasedIds = []) {
  const res = await axios.get(RECENT_RELEASES_URL, { headers: HEADERS, timeout: 30000 });
  if (isUpdatingPlaceholder(res.data)) return [];
  const $ = cheerio.load(res.data);

  const rows = [];
  for (const fields of parsePanels($, $('.list'))) {
    const nameNumber = fields['name number'];
    const dateReleased = fields['date released'];
    if (!nameNumber || !dateReleased || dateReleased === 'In SCORE Custody') continue;
    rows.push({ nn: nameNumber, bookingNumber: fields['booking number'], releasedAt: dateReleased });
  }

  const idsSet = new Set(releasedIds);
  const nnsNeedingReason = [...new Set(rows.filter(r => idsSet.has(r.nn)).map(r => r.nn))];
  for (const nn of nnsNeedingReason) {
    try {
      const res2 = await axios.post(VIEW_URL, new URLSearchParams({ nn }), { headers: HEADERS, timeout: 20000 });
      if (isUpdatingPlaceholder(res2.data)) continue;
      const $2 = cheerio.load(res2.data);
      const bookingList = parseBookingList($2);
      for (const row of rows) {
        if (row.nn !== nn) continue;
        const match = bookingList.find(b => b.bookingNumber === row.bookingNumber);
        if (match) row.releaseReason = match.releaseType;
      }
    } catch (err) {
      console.warn(`  Release-reason fetch failed for nn=${nn}:`, err.message);
    }
  }

  return rows;
}

// A release can only be marked 'detected' (our own scrape-detection time,
// not a source-published one) when /recentreleases couldn't supply a real
// timestamp for it -- either the whole page was unusable (e.g. mid-rebuild)
// or that specific booking's row hadn't posted there yet. Either way, that
// same booking's Date Released eventually shows up on the person's own
// Booking List (confirmed live), so later runs keep re-checking pending
// 'detected' releases against it and upgrade to 'county' once it appears.
// `pending` is [{ idnum, bookingNumber }]; idnum may be a compound
// "nn:bookingNumber" rebooking-fork key, so the raw nn is recovered the same
// way runScraper.js does elsewhere. Multiple pending entries for the same nn
// (e.g. an old released booking plus a newer one) are grouped so that nn's
// Booking List is only fetched once. Returns a Map<idnum, { releasedAt?,
// releaseReason?, bookingHistory }> -- callers should only treat an entry as
// upgraded when `releasedAt` is present.
export async function recheckDetectedReleases(pending) {
  const byNn = new Map();
  for (const entry of pending) {
    const nn = entry.idnum.split(':')[0];
    if (!byNn.has(nn)) byNn.set(nn, []);
    byNn.get(nn).push(entry);
  }

  const results = new Map();
  for (const [nn, entries] of byNn) {
    let res;
    try {
      res = await axios.post(VIEW_URL, new URLSearchParams({ nn }), { headers: HEADERS, timeout: 20000 });
    } catch (err) {
      console.warn(`  Detected-release recheck failed for nn=${nn}:`, err.message);
      await sleep(RECHECK_DELAY_MS);
      continue;
    }
    // Same reasoning as scrapeDetailBatch: stop the whole recheck pass
    // rather than continuing to hit every remaining pending nn one at a time
    // during a rebuild window.
    if (isUpdatingPlaceholder(res.data)) {
      console.warn(`  SCORE is mid-rebuild -- stopping detected-release recheck early.`);
      break;
    }
    const $ = cheerio.load(res.data);
    const parsedHistory = parseBookingList($);
    // Every entry here is already known to be released, so -- unlike
    // scrapeDetailBatch, which also handles genuinely-first-time in_custody
    // bookings -- an empty list can never be legitimate regardless of
    // whether "Unable to display" is present; reject on either signal.
    const unreliable = hasUnableToDisplay(res.data) || parsedHistory.length === 0;
    const bookingHistory = unreliable ? null : parsedHistory;
    for (const entry of entries) {
      const match = bookingHistory ? bookingHistory.find(b => b.bookingNumber === entry.bookingNumber) : null;
      const upgrade = { bookingHistory };
      if (match && isValidScoreDate(match.dateReleased)) {
        upgrade.releasedAt = match.dateReleased;
        upgrade.releaseReason = match.releaseType;
      }
      results.set(entry.idnum, upgrade);
    }
    await sleep(RECHECK_DELAY_MS);
  }
  return results;
}
