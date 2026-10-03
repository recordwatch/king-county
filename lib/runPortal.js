import fs from 'fs';
import path from 'path';
import { nowPST } from '../utils.js';
import { normalizeBookingNumber, isKnownBookingFormat } from './bookingNumber.js';
import { mergeCharges, splitOffense } from './kcCharges.js';
import { openPortal, VIEWS } from '../scrapers/kcportal.js';
import { WINDOW_DAYS, FACILITY_LABEL } from '../scrapers/kcdajd.js';

// Keeps KC DAJD's custody status current from the DAJD lookup portal
// (scrapers/kcportal.js), on top of the 1-2-week-lagged Socrata feed
// (scrapers/kcdajd.js). Both write the same data/kc_dajd/ files, one record
// per booking, matched purely by booking number; the workflows share one
// concurrency group so they never write at the same time.
//
// Per booking, the portal is the authority for: custody status, release time
// (labelled 'county' only from the portal's own Bookings sub-table, and only
// when it parses), arresting agency, bail, facility and UCN. Socrata stays the
// source for charge court/cause/RCW details and release reason. Once the
// portal has checked a booking (statusSource: 'portal'), lib/runScraper.js's
// Socrata sync no longer touches its status.
//
// Every run: the two 24-hour views. At most once a day: the full in-custody
// list, which also catches anything the 24-hour views missed across a gap in
// runs. Detail pages only for new bookings, releases, retries and the one-time
// bail backfill, within DETAIL_BUDGET page loads per run.

const DETAIL_BUDGET = 60;
const FULL_CHECK_MIN_HOURS = 20;
// The full in-custody list is ~2,000 current bookings; far fewer means the
// fetch broke, and treating everyone missing from it as released would be a
// mass false release. An absolute floor, not a percentage -- this list is
// always large (unlike the 24-hour views, which can legitimately be tiny).
const FULL_CHECK_MIN_ROWS = 1000;
// An in_custody booking the portal no longer lists, but whose release can't
// be confirmed from its Bookings sub-table, is retried for this long and then
// left alone -- never forced to released.
const PENDING_MAX_DAYS = 14;
const MAX_NAME_CANDIDATES = 3;
// A name-search candidate whose booking number is this close to ours, with an
// arrest time this close to our booking time, is saved as portalNearMatch for
// a person to review. Never auto-matched: a wrong match would put someone
// else's release on this booking.
const NEAR_MATCH_MAX_NUMBER_GAP = 3;
const NEAR_MATCH_MAX_HOURS = 3;

// Kept out of change_log.json. UCN is stored but not displayed; the rest is
// portal bookkeeping only this module needs. portalMissing is NOT in this
// list: the frontend shows the lag note on in-custody records that have it
// (see entryLagNote() in frontend/src/sources.js).
const ROSTER_ONLY_FIELDS = ['ucn', 'portalSubjectId', 'portalCharges', 'socrataCharges', 'portalPending', 'portalDetailAt', 'portalNearMatch'];

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return fallback;
}

// Copies each KC booking's portalMissing (set or cleared) from roster.json to
// its change_log.json entry. Run on every write rather than only where the
// field changes: the full check marks bookings without touching the log,
// and Object.assign in syncLog() can't remove a field that was cleared.
export function syncPortalMissing(roster, log) {
  for (const logEntry of log) {
    if (logEntry.source !== 'kc_dajd') continue;
    const missing = roster[logEntry.idnum]?.portalMissing;
    if (missing) logEntry.portalMissing = missing;
    else delete logEntry.portalMissing;
  }
}

function publicView(entry) {
  const out = { ...entry };
  for (const f of ROSTER_ONLY_FIELDS) delete out[f];
  return out;
}

// A booking still needs a detail page if the portal's never been read for it,
// or it's portal-first and its charges hadn't been filed yet last time.
function needsDetail(e) {
  return !e.portalDetailAt || !e.hasDetail;
}

function isValidDate(s) {
  return !!s && !isNaN(new Date(s).getTime());
}

function formatMoney(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseMoney(s) {
  const m = String(s || '').replace(/,/g, '').match(/\$?\s*(-?[\d.]+)/);
  return m ? Number(m[1]) : null;
}

// "PATTERSON, ZJON' TEYIA TAJANA" -> "PATTERSON, ZJON" -- the portal's grid
// search matched on "LAST, FIRST" in testing.
function searchNameFor(name) {
  const [last, rest = ''] = String(name || '').split(',');
  const first = (rest.trim().split(/\s+/)[0] || '').replace(/[^A-Za-z-]/g, '');
  return first ? `${last.trim()}, ${first}` : last.trim();
}

// "2026-012199" -> { year: '2026', seq: 12199 }; null for any other format.
function splitBookingNumber(bn) {
  const m = /^(\d{4})-(\d{6})$/.exec(bn || '');
  return m ? { year: m[1], seq: Number(m[2]) } : null;
}

// UTC ISO with or without a Z -> epoch ms, or NaN.
function utcMs(s) {
  if (!s) return NaN;
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`).getTime();
}

// Rule 3: a booking on this candidate's page that looks like ours under a
// different number (same year, number within NEAR_MATCH_MAX_NUMBER_GAP,
// arrest within NEAR_MATCH_MAX_HOURS of our booking time). Returns the
// closest one, or null.
export function findNearMatch(entry, bookings) {
  const ours = splitBookingNumber(entry.bookingNumber);
  const ourTime = utcMs(entry.bookingDate);
  if (!ours || isNaN(ourTime)) return null;
  let best = null;
  for (const b of bookings) {
    const theirs = splitBookingNumber(b.bookingNumber);
    if (!theirs || theirs.year !== ours.year || b.bookingNumber === entry.bookingNumber) continue;
    const gap = Math.abs(theirs.seq - ours.seq);
    const hours = Math.abs(utcMs(b.arrestedAt) - ourTime) / 3600000;
    if (gap > NEAR_MATCH_MAX_NUMBER_GAP || !(hours <= NEAR_MATCH_MAX_HOURS)) continue;
    if (!best || gap < best.gap) best = { b, gap, hours };
  }
  return best;
}

export async function runPortal({ dataDir, dryRun = false, outDir = null, priority = [], forceFullCheck = false }) {
  const ROSTER_FILE = path.join(dataDir, 'roster.json');
  const LOG_FILE = path.join(dataDir, 'change_log.json');
  const STATE_FILE = path.join(dataDir, 'portal_state.json');
  if (dryRun && !outDir) throw new Error('dry run needs an output directory (PORTAL_OUT_DIR)');

  console.log(`[${nowPST()}] Running King County DAJD portal check${dryRun ? ' (DRY RUN -- data/ will not be written)' : ''}...`);

  const roster = readJSON(ROSTER_FILE, {});
  const log = readJSON(LOG_FILE, []);
  const state = readJSON(STATE_FILE, {});
  const nowIso = new Date().toISOString().slice(0, 23);
  const now = nowPST();
  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 23);

  const report = {
    dryRun, startedAt: nowIso, views: {}, fullCheck: null,
    created: [], released: [], reversed: [], confirmedInCustody: 0, stillBooked: [], pending: [], removed: [], nearMatches: [],
    detailed: [], detailFailures: [], chargeMerge: { bookings: 0, portal: 0, socrata: 0, matched: 0, unmatchedPortal: 0, unmatchedSocrata: 0 },
    unknownBookingFormats: [], skippedOutsideWindow: 0,
  };

  const byBooking = new Map();
  for (const [key, e] of Object.entries(roster)) {
    if (e.source === 'kc_dajd' && e.bookingNumber) byBooking.set(normalizeBookingNumber(e.bookingNumber), key);
  }

  function syncLog(key) {
    const logEntry = log.find(e => e.idnum === key);
    if (logEntry) Object.assign(logEntry, publicView(roster[key]));
  }

  function noteFormat(bn) {
    if (!isKnownBookingFormat(bn) && !report.unknownBookingFormats.includes(bn)) {
      report.unknownBookingFormats.push(bn);
      console.warn(`  Unrecognized booking number format: "${bn}" (matched as-is, not rewritten)`);
    }
  }

  // --- A booking the portal lists as current (booked-24h view or full list).
  function observeCurrent(row) {
    noteFormat(row.bookingNumber);
    const key = byBooking.get(row.bookingNumber);
    if (!key) {
      if (!row.bookedAt || row.bookedAt < cutoffIso) {
        report.skippedOutsideWindow++;
        return null;
      }
      const entry = {
        idnum: row.bookingNumber,
        source: 'kc_dajd',
        facility: row.facility || FACILITY_LABEL,
        bookingNumber: row.bookingNumber,
        name: row.name,
        status: 'in_custody',
        firstSeen: now,
        releasedAt: null,
        releaseReason: null,
        releaseSource: null,
        releaseReversals: [],
        scheduledReleaseDate: null,
        detailId: null,
        bookingDate: row.bookedAt,
        releaseType: null,
        charges: [],
        priorBookings: null,
        totalBail: null,
        bookingHistory: null,
        detectedReleasedAt: null,
        hasDetail: false,
        arrestingAgency: row.agency || null,
        statusSource: 'portal',
        portalCheckedAt: nowIso,
        ucn: row.ucn,
        portalSubjectId: row.subjectId,
        portalCharges: [],
        socrataCharges: [],
      };
      roster[entry.idnum] = entry;
      byBooking.set(entry.bookingNumber, entry.idnum);
      log.unshift(publicView(entry));
      console.log(`  NEW (portal): ${entry.name} ${entry.bookingNumber}`);
      report.created.push({ bookingNumber: entry.bookingNumber, name: entry.name, bookingDate: entry.bookingDate, agency: entry.arrestingAgency });
      return entry.idnum;
    }

    const e = roster[key];
    if (e.status === 'removed') {
      // A booking we'd marked removed is listed as current again -- the
      // removal was wrong. Put it back and keep what we'd recorded.
      console.log(`  REVERSED (portal lists removed booking as current): ${e.name} ${e.bookingNumber}, removed ${e.removedAt} (${e.removedReason})`);
      e.removalReversals = e.removalReversals || [];
      e.removalReversals.push({ removedAt: e.removedAt, removedReason: e.removedReason, reversedAt: now });
      e.status = 'in_custody';
      delete e.removedAt;
      delete e.removedReason;
      report.reversed.push({ bookingNumber: e.bookingNumber, name: e.name, was: 'removed' });
    }
    if (e.status === 'released') {
      // Same booking number listed as current after we'd recorded a release
      // -- keep what we had, don't silently discard it.
      console.log(`  REVERSED (portal lists booking as current): ${e.name} ${e.bookingNumber}, was released ${e.releasedAt} (${e.releaseSource})`);
      e.releaseReversals = e.releaseReversals || [];
      e.releaseReversals.push({ releasedAt: e.releasedAt, releaseReason: e.releaseReason, releaseSource: e.releaseSource, reversedAt: now });
      e.status = 'in_custody';
      e.releasedAt = null;
      e.releaseReason = null;
      e.releaseSource = null;
      report.reversed.push({ bookingNumber: e.bookingNumber, name: e.name });
    }
    if (row.ucn) e.ucn = row.ucn;
    if (row.agency) e.arrestingAgency = row.agency;
    if (row.facility) e.facility = row.facility;
    e.portalSubjectId = row.subjectId;
    e.statusSource = 'portal';
    e.portalCheckedAt = nowIso;
    delete e.portalPending;
    delete e.portalMissing;
    report.confirmedInCustody++;
    syncLog(key);
    return key;
  }

  function markPending(key, reason) {
    const e = roster[key];
    const since = e.portalPending?.since || nowIso;
    const gaveUp = Date.now() - new Date(`${since}Z`).getTime() > PENDING_MAX_DAYS * 86400000;
    e.portalPending = { since, lastAttemptAt: nowIso, attempts: (e.portalPending?.attempts || 0) + 1, lastReason: reason, gaveUp };
    report.pending.push({ bookingNumber: e.bookingNumber, name: e.name, reason, gaveUp });
    console.log(`  PENDING: ${e.name} ${e.bookingNumber} -- ${reason}${gaveUp ? ` (over ${PENDING_MAX_DAYS} days, no longer retried)` : ''}`);
  }

  // Charges, bail and UCN from a subject's detail page, for one booking.
  function applyDetail(key, d) {
    const e = roster[key];
    if (d.header?.ucn) e.ucn = d.header.ucn;
    const portalCharges = d.charges
      .filter(c => c.bookingNumber === e.bookingNumber)
      .map(c => {
        const { text, code } = splitOffense(c.offense);
        return { charge: text || null, offenseCode: code, bail: c.bail || null, chargeStatus: c.chargeStatus || null, releaseCode: c.releaseCode || null, courtCase: c.courtCase || null };
      });
    // First portal detail for a Socrata-first booking: what's in `charges`
    // is Socrata's, so keep it as the Socrata side of the merge.
    if (e.portalCharges === undefined) e.socrataCharges = e.socrataCharges ?? (e.charges || []);
    e.portalCharges = portalCharges;
    const merged = mergeCharges(portalCharges, e.socrataCharges);
    e.charges = merged.charges;
    e.unmatchedSocrataCharges = merged.unmatchedSocrata;
    if (merged.stats.portal > 0 && merged.stats.socrata > 0) {
      report.chargeMerge.bookings++;
      for (const k of ['portal', 'socrata', 'matched', 'unmatchedPortal', 'unmatchedSocrata']) report.chargeMerge[k] += merged.stats[k];
    }
    // Booking-level bail: the sum of this booking's still-open court cases'
    // bail totals (matches the portal's own Bail Total for single-booking
    // subjects). Never overwritten with nothing -- closed cases on a released
    // booking carry no bail total.
    const open = d.courtCases.filter(c => c.bookingNumber === e.bookingNumber && c.caseStatus !== 'Closed');
    const amounts = open.map(c => parseMoney(c.bailTotal)).filter(n => n !== null && n > 0);
    if (amounts.length) e.totalBail = formatMoney(amounts.reduce((a, b) => a + b, 0));
    // The subject's Bookings sub-table, from the same page load -- this
    // person's bookings, including this one (same shape idea as SCORE's
    // bookingHistory). The portal publishes an arrest time, not a separate
    // booked time, and no release type. A release time is kept only when the
    // row says Released and the time parses. Never overwritten with an empty
    // list: anyone with a detail page has at least this booking, so empty
    // means the sub-table didn't load.
    if (d.bookings.length) {
      e.bookingHistory = d.bookings
        .map(b => ({
          bookingNumber: b.bookingNumber,
          dateArrested: isValidDate(b.arrestedAt) ? b.arrestedAt : null,
          dateReleased: b.bookingStatus === 'Released' && isValidDate(b.releasedAt) ? b.releasedAt : null,
          bookingStatus: b.bookingStatus || null,
        }))
        .sort((a, b) => (b.dateArrested || '').localeCompare(a.dateArrested || ''));
    }
    e.portalDetailAt = nowIso;
    // Same convention as the other sources: hasDetail means real, filed
    // charge data. A portal-first booking with no charges filed yet keeps
    // being retried.
    if (portalCharges.length > 0) e.hasDetail = true;
  }

  // Release decision from a subject's Bookings sub-table, matched strictly on
  // this booking's number (never by person alone).
  function resolveFromBookings(key, d) {
    const e = roster[key];
    const b = d.bookings.find(x => x.bookingNumber === e.bookingNumber);
    if (!b) {
      // The detail page loaded in full (d.ok -- all three sub-tables answered
      // 200), so a missing booking is the county's own record, not a failed
      // fetch. Two cases are treated as removed from the portal:
      //   - other bookings are listed but not ours (rebooked, e.g. EHD ended
      //     and a new booking opened -- MUHAMAD 2026-010036 -> 2026-013801);
      //   - no bookings at all and the subject is Inactive (SIMMONS
      //     2026-009884, SANTIAGO 2026-012427, JOHNSON 2026-012758).
      // Anything else (empty table, subject still Active) stays pending.
      const inactive = /inactive/i.test(d.header?.subjectStatus || '');
      let reason = null;
      if (d.bookings.length > 0) reason = `booking not in Bookings sub-table; subject lists ${d.bookings.map(x => x.bookingNumber).join(', ')}`;
      else if (inactive) reason = 'Bookings sub-table empty and subject Inactive';
      if (!reason) return markPending(key, 'booking number not in this subject\'s Bookings sub-table');
      e.status = 'removed';
      e.removedAt = nowIso;
      e.removedReason = reason;
      e.statusSource = 'portal';
      e.portalCheckedAt = nowIso;
      delete e.portalPending;
      delete e.portalMissing;
      console.log(`  REMOVED (portal): ${e.name} ${e.bookingNumber} -- ${reason}`);
      report.removed.push({ bookingNumber: e.bookingNumber, name: e.name, reason });
      return;
    }
    if (b.bookingStatus === 'Released' && isValidDate(b.releasedAt)) {
      e.status = 'released';
      e.releasedAt = b.releasedAt;
      e.releaseSource = 'county';
      e.statusSource = 'portal';
      e.portalCheckedAt = nowIso;
      delete e.portalPending;
      delete e.portalMissing;
      console.log(`  RELEASED (portal): ${e.name} ${e.bookingNumber} at ${e.releasedAt} UTC`);
      report.released.push({ bookingNumber: e.bookingNumber, name: e.name, releasedAt: e.releasedAt });
      return;
    }
    if (b.bookingStatus === 'Booked') {
      // Still an open booking, just not the subject's "current" one in the
      // grid (e.g. two open bookings) -- in custody, confirmed.
      e.statusSource = 'portal';
      e.portalCheckedAt = nowIso;
      delete e.portalPending;
      delete e.portalMissing;
      report.stillBooked.push({ bookingNumber: e.bookingNumber, name: e.name });
      return;
    }
    markPending(key, `Booking Status "${b.bookingStatus}", release time ${b.releasedAt || 'missing'}`);
  }

  let session;
  const queue = [];
  const queued = new Set();
  const enqueue = (kind, key, subjectId) => {
    if (!key || queued.has(key)) return;
    queued.add(key);
    queue.push({ kind, key, subjectId });
  };

  try {
    session = await openPortal();

    // 1. Booked in the last 24 hours.
    const booked = await session.gridAll(VIEWS.BOOKED_24H);
    report.views.booked24h = booked.length;
    for (const row of booked.filter(r => r.bookingNumber)) {
      const key = observeCurrent(row);
      if (key && needsDetail(roster[key])) enqueue(roster[key].statusSource === 'portal' && roster[key].portalCharges ? 'new' : 'backfill', key, row.subjectId);
    }

    // 2. Released in the last 24 hours. These rows carry no booking number
    // (it's cleared on release) -- UCN picks which of our in-custody bookings
    // to check; the Bookings sub-table then confirms by booking number.
    const released = await session.gridAll(VIEWS.RELEASED_24H);
    report.views.released24h = released.length;
    const byUcn = new Map();
    for (const [key, e] of Object.entries(roster)) {
      if (e.source === 'kc_dajd' && e.status === 'in_custody' && e.ucn) {
        if (!byUcn.has(e.ucn)) byUcn.set(e.ucn, []);
        byUcn.get(e.ucn).push(key);
      }
    }
    for (const row of released) {
      for (const key of byUcn.get(row.ucn) || []) enqueue('release', key, row.subjectId);
    }

    // 3. Full in-custody check, at most once a day.
    const hoursSince = state.lastFullCheck ? (Date.now() - new Date(state.lastFullCheck).getTime()) / 3600000 : Infinity;
    let fullCheckDone = false;
    if (forceFullCheck || hoursSince >= FULL_CHECK_MIN_HOURS) {
      const rows = await session.gridAll(VIEWS.IN_CUSTODY);
      const withBooking = rows.filter(r => r.bookingNumber);
      report.fullCheck = { rows: rows.length, withBooking: withBooking.length, noCurrentBooking: rows.length - withBooking.length };
      if (withBooking.length < FULL_CHECK_MIN_ROWS) {
        report.fullCheck.skipped = `only ${withBooking.length} current bookings (floor ${FULL_CHECK_MIN_ROWS}) -- treating the fetch as broken, releasing no one`;
        console.warn(`  Full check skipped: ${report.fullCheck.skipped}`);
      } else {
        const current = new Set();
        for (const row of withBooking) {
          current.add(row.bookingNumber);
          const key = observeCurrent(row);
          if (key && needsDetail(roster[key])) enqueue(roster[key].statusSource === 'portal' && roster[key].portalCharges ? 'new' : 'backfill', key, row.subjectId);
        }
        // Marked rather than only queued, so whatever this run's detail
        // budget doesn't reach is picked up by the next run (step 4), not
        // left until tomorrow's full check.
        let missing = 0;
        for (const e of Object.values(roster)) {
          if (e.source !== 'kc_dajd' || e.status !== 'in_custody' || current.has(e.bookingNumber)) continue;
          e.portalMissing = e.portalMissing || nowIso;
          missing++;
        }
        fullCheckDone = true;
        report.fullCheck.missingFromPortal = missing;
      }
    }

    // 4. Work carried over from earlier runs: bookings the last full check
    // didn't list (or whose release couldn't be confirmed yet), and
    // bookings the portal has confirmed that still need a detail page (new
    // portal-first bookings, the one-time bail backfill).
    for (const [key, e] of Object.entries(roster)) {
      if (e.source !== 'kc_dajd' || e.status !== 'in_custody') continue;
      // A booking that's already failed once is retried at most every
      // FULL_CHECK_MIN_HOURS, not every run -- a lookup that keeps coming up
      // empty shouldn't cost several page loads every 2 hours for 14 days.
      const retryDue = !e.portalPending?.lastAttemptAt
        || (Date.now() - new Date(`${e.portalPending.lastAttemptAt}Z`).getTime()) / 3600000 >= FULL_CHECK_MIN_HOURS;
      if ((e.portalMissing || e.portalPending) && !e.portalPending?.gaveUp) {
        if (retryDue) enqueue(e.portalSubjectId ? 'release' : 'lookup', key, e.portalSubjectId || null);
      } else if (e.statusSource === 'portal' && e.portalSubjectId && needsDetail(e)) {
        enqueue(e.portalCharges ? 'new' : 'backfill', key, e.portalSubjectId);
      }
    }

    // 5. Detail pages, highest priority first, within the page-load budget.
    const rank = { release: 0, lookup: 1, new: 2, backfill: 3 };
    const prio = new Set(priority.map(normalizeBookingNumber));
    queue.sort((a, b) => (prio.has(roster[b.key].bookingNumber) - prio.has(roster[a.key].bookingNumber)) || (rank[a.kind] - rank[b.kind]));
    report.queue = queue.reduce((acc, q) => ({ ...acc, [q.kind]: (acc[q.kind] || 0) + 1 }), {});

    let processed = 0;
    for (const item of queue) {
      if (session.stats.detailLoads >= DETAIL_BUDGET) break;
      processed++;
      const e = roster[item.key];

      if (item.kind === 'lookup') {
        const query = searchNameFor(e.name);
        const candidates = (await session.search(VIEWS.PAST_YEAR, query)).slice(0, MAX_NAME_CANDIDATES);
        let resolved = false;
        let nearMatch = null;
        for (const c of candidates) {
          if (session.stats.detailLoads >= DETAIL_BUDGET) break;
          const d = await session.detail(c.subjectId, DETAIL_BUDGET - session.stats.detailLoads);
          if (!d.ok) continue;
          if (!d.bookings.some(b => b.bookingNumber === e.bookingNumber)) {
            // Not ours -- but check it for a near-miss number (Rule 3) from
            // this same page load, so it costs no extra page loads.
            const near = findNearMatch(e, d.bookings);
            if (near && (!nearMatch || near.gap < nearMatch.near.gap)) nearMatch = { c, near };
            continue;
          }
          e.portalSubjectId = c.subjectId;
          if (c.ucn) e.ucn = c.ucn;
          applyDetail(item.key, d);
          resolveFromBookings(item.key, d);
          report.detailed.push({ kind: 'lookup', bookingNumber: e.bookingNumber });
          resolved = true;
          break;
        }
        if (!resolved && nearMatch) {
          // Rule 3: saved for review only -- status is never changed here.
          const { c, near } = nearMatch;
          e.portalNearMatch = {
            foundAt: nowIso, ucn: c.ucn || null, subjectId: c.subjectId,
            bookingNumber: near.b.bookingNumber, bookingStatus: near.b.bookingStatus || null,
            arrestedAt: near.b.arrestedAt || null, releasedAt: near.b.releasedAt || null,
            numberGap: near.gap, hoursApart: Math.round(near.hours * 10) / 10,
          };
          report.nearMatches.push({ bookingNumber: e.bookingNumber, name: e.name, ...e.portalNearMatch });
          console.log(`  NEAR MATCH (review): ${e.name} ${e.bookingNumber} ~ ${near.b.bookingNumber} (${near.b.bookingStatus || 'no status'}), ${near.gap} apart, ${e.portalNearMatch.hoursApart}h`);
        }
        if (!resolved) markPending(item.key, candidates.length ? `no name-search candidate ("${query}") lists this booking number` : `name search "${query}" found no one`);
        syncLog(item.key);
        continue;
      }

      const d = await session.detail(item.subjectId, DETAIL_BUDGET - session.stats.detailLoads);
      if (!d.ok) {
        report.detailFailures.push({ kind: item.kind, bookingNumber: e.bookingNumber, reason: d.reason });
        if (item.kind === 'release') markPending(item.key, `detail page failed: ${d.reason}`);
        syncLog(item.key);
        continue;
      }
      applyDetail(item.key, d);
      if (item.kind === 'release') resolveFromBookings(item.key, d);
      report.detailed.push({ kind: item.kind, bookingNumber: e.bookingNumber });
      syncLog(item.key);
    }
    report.leftInQueue = queue.length - processed;

    report.portalStats = session.stats;
    if (fullCheckDone) state.lastFullCheck = new Date().toISOString();
    state.lastRun = new Date().toISOString();
  } finally {
    if (session) await session.close();
  }

  const inCustody = Object.values(roster).filter(e => e.status === 'in_custody').length;
  report.inCustodyAfter = inCustody;
  syncPortalMissing(roster, log);
  const target = dryRun ? outDir : dataDir;
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'roster.json'), JSON.stringify(roster));
  fs.writeFileSync(path.join(target, 'change_log.json'), JSON.stringify(log));
  fs.writeFileSync(path.join(target, 'status.json'), JSON.stringify({ source: 'kc_dajd', inCustody, lastUpdated: now }));
  fs.writeFileSync(path.join(target, 'portal_state.json'), JSON.stringify(state));
  if (dryRun) fs.writeFileSync(path.join(target, 'report.json'), JSON.stringify(report, null, 1));

  console.log(`[${nowPST()}] Portal check done${dryRun ? ` (dry run, written to ${outDir})` : ''}. ${report.created.length} new, ${report.released.length} released, ${report.reversed.length} reversed, ${report.removed.length} removed, ${report.nearMatches.length} near match(es) to review, ${report.pending.length} pending, ${report.detailed.length} detail(s) applied, ${session?.stats.detailLoads ?? 0} detail page load(s). ${inCustody} in custody.`);
  return report;
}
