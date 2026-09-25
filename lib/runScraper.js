import fs from 'fs';
import path from 'path';
import { nowPST } from '../utils.js';

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return fallback;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

// Used everywhere a "county" releaseSource is considered -- a non-empty
// string alone isn't enough, it has to actually parse as a real date.
function isValidDate(s) {
  return !!s && !isNaN(new Date(s).getTime());
}

// Shared diff/write engine used by all 4 King County scrapers. Each source
// differs only in how it fetches records and whether it needs a separate
// detail-page fetch for charges — everything else (roster diffing, release
// detection, log building, file I/O) is identical to the sibling counties'
// scrape.js pattern, so it's factored out here instead of copy-pasted 4x.
//
// fetchRoster() must resolve to an array of:
//   { idnum, name, facility, bookingNumber, bookingDate, charges?, status?, releasedAt? }
//
// explicitStatus: true means the source itself reports status/releasedAt
// authoritatively (e.g. King County's booking-event feed) rather than us
// inferring release by an id disappearing from the roster (the norm for
// live "who's here right now" rosters like SCORE/Kent/Kirkland).
export async function runScrape({
  sourceId,
  label,
  dataDir,
  fetchRoster,
  fetchDetailBatch,
  detailBatchLimit = 30,
  backfillBatch = 100,
  explicitStatus = false,
  fetchReleaseTimes,
}) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const ROSTER_FILE = path.join(dataDir, 'roster.json');
  const LOG_FILE = path.join(dataDir, 'change_log.json');
  const STATUS_FILE = path.join(dataDir, 'status.json');

  console.log(`[${nowPST()}] Running ${label} scrape...`);

  let roster = readJSON(ROSTER_FILE, {});
  let log = readJSON(LOG_FILE, []);

  let records;
  try {
    records = await fetchRoster();
  } catch (err) {
    // A source can throw a marked "expected empty" error for a known,
    // transient reason (e.g. SCORE's mid-rebuild placeholder) -- that's a
    // clean skip, not a failure. Anything else is a real fetch failure.
    if (err.expectedEmpty) {
      console.log(`  ${err.message}`);
      return;
    }
    console.error(`  ${label} fetch failed:`, err.message);
    process.exitCode = 1;
    return;
  }

  if (records.length === 0) {
    console.error('  Got 0 records with no known reason to expect an empty roster -- failing the run.');
    process.exitCode = 1;
    return;
  }

  // Safety check: a sudden large drop in the in-custody population usually
  // means the fetch/parse silently broke rather than a real mass release --
  // abort rather than writing data that looks like everyone left at once.
  // Requires both >10% and >5 people so small-population sources (e.g.
  // Kirkland's ~15-30) don't trip this on ordinary day-to-day variance.
  // FORCE_UPDATE=true (wired into scrape.yml's workflow_dispatch input)
  // overrides this for the rare case where the drop is real.
  const oldInCustody = Object.values(roster).filter(e => e.status === 'in_custody').length;
  const newInCustody = records.filter(r => (r.status || 'in_custody') === 'in_custody').length;
  const dropCount = oldInCustody - newInCustody;
  const drop = oldInCustody > 0 ? dropCount / oldInCustody : 0;
  if (oldInCustody > 0 && drop > 0.10 && dropCount > 5 && process.env.FORCE_UPDATE !== 'true') {
    console.error(`  ABORTED: in-custody count dropped ${(drop * 100).toFixed(1)}% (${oldInCustody} -> ${newInCustody}, -${dropCount}), more than the 10%/5-person safety threshold. Set FORCE_UPDATE=true to override.`);
    process.exitCode = 1;
    return;
  }

  const previousIds = new Set(Object.keys(roster));
  const now = nowPST();

  // SCORE's scraped id ("Name Number") is a stable person-level identifier,
  // not a booking-level one -- unlike every other source, where idnum IS the
  // booking number. That means the same nn can legitimately correspond to
  // two different bookings over time (a rebooking), which the other sources
  // can't experience: their idnum simply changes when the booking does.
  // Resolve each incoming record to the roster key it actually belongs to:
  //   - an exact match on the SAME booking number, if we already have one
  //     under this id (normal update, or a rebooking fork we made earlier)
  //   - otherwise the most recently-created entry for this id, so the caller
  //     can tell "same booking reappearing" from "a new booking" by
  //     comparing bookingNumber
  //   - null if we've truly never seen this id before
  // Every other source's id is already booking-level unique, so this is
  // just previousIds.has(r.idnum).
  function resolveKey(r) {
    if (sourceId !== 'score') {
      return previousIds.has(r.idnum) ? r.idnum : null;
    }
    const candidates = Object.keys(roster).filter(k => k === r.idnum || k.startsWith(`${r.idnum}:`));
    if (candidates.length === 0) return null;
    const exact = candidates.find(k => roster[k].bookingNumber === r.bookingNumber);
    if (exact) return exact;
    candidates.sort((a, b) => new Date(roster[b].firstSeen) - new Date(roster[a].firstSeen));
    return candidates[0];
  }

  // Classify every record from this fetch, and track which roster keys this
  // fetch confirms are still live (used below to detect who disappeared).
  const newRecords = []; // never seen this id before
  const rebookings = []; // SCORE only: same nn, different booking, old one already released
  const forcedRebookings = []; // SCORE only: same nn, different booking, old one still showed in_custody
  const existingRecords = []; // matches a known entry under the SAME booking
  const currentKeys = new Set();

  for (const r of records) {
    const matchKey = resolveKey(r);
    if (matchKey === null) {
      newRecords.push({ r, key: r.idnum });
      currentKeys.add(r.idnum);
    } else if (roster[matchKey].bookingNumber === r.bookingNumber) {
      existingRecords.push({ r, key: matchKey });
      currentKeys.add(matchKey);
    } else {
      // Different booking number under a known nn -- a rebooking either way.
      // Fork a new entry for the new booking; what happens to the old one
      // depends on whether we already knew it was released.
      const key = `${r.idnum}:${r.bookingNumber}`;
      if (roster[matchKey].status === 'released') {
        rebookings.push({ r, key, oldKey: matchKey });
      } else {
        // The old booking was still showing in_custody -- it was superseded
        // without us ever seeing it disappear (missed a run, or the two
        // bookings overlapped by a cycle). It's just as released as any
        // other booking we've stopped seeing; resolve its release time the
        // same way the normal disappearance path does, below.
        forcedRebookings.push({ r, key, oldKey: matchKey });
      }
      currentKeys.add(key);
    }
  }

  console.log(`  ${newRecords.length} new record(s) found`);
  if (rebookings.length > 0) console.log(`  ${rebookings.length} rebooking(s) found`);
  if (forcedRebookings.length > 0) console.log(`  ${forcedRebookings.length} rebooking(s) found with the prior booking still marked in_custody`);

  const freshEntries = [...newRecords, ...rebookings, ...forcedRebookings];

  let detailMap = {};
  if (fetchDetailBatch && freshEntries.length > 0 && freshEntries.length <= detailBatchLimit) {
    console.log(`  Fetching details for ${freshEntries.length} new record(s)...`);
    try {
      detailMap = await fetchDetailBatch(freshEntries.map(x => x.r.idnum), { roster });
    } catch (err) {
      console.warn('  Detail batch failed:', err.message);
    }
  } else if (fetchDetailBatch && freshEntries.length > detailBatchLimit) {
    console.log(`  Skipping details (${freshEntries.length} new — likely first run)`);
  }

  for (const { r, key, oldKey } of freshEntries) {
    if (oldKey && roster[oldKey].status === 'released') {
      // The old booking stays exactly as it was -- still released, with its
      // original release time untouched -- since this is a genuinely new,
      // separate booking event for the same person, not a correction.
      console.log(`  REBOOKED: ${r.name} (nn ${r.idnum}) -- new booking ${r.bookingNumber}, prior booking ${roster[oldKey].bookingNumber} stays released`);
    } else if (oldKey) {
      // forcedRebookings -- the old booking is released further down, once
      // fetchReleaseTimes has been called for it alongside normal releases.
      console.log(`  REBOOKED: ${r.name} (nn ${r.idnum}) -- new booking ${r.bookingNumber}, prior booking ${roster[oldKey].bookingNumber} was still in_custody, forcing it released`);
    } else {
      console.log(`  NEW: ${r.name}`);
    }
    const detail = detailMap[r.idnum];
    const entry = {
      idnum: key,
      source: sourceId,
      facility: r.facility,
      bookingNumber: r.bookingNumber,
      name: r.name,
      status: r.status || 'in_custody',
      firstSeen: now,
      releasedAt: r.releasedAt || null,
      // Used by the WA DOC cross-reference to skip obvious non-transfers
      // (bond/bail/PR releases) before even checking DOC. Only reliably
      // available for explicitStatus sources (KC DAJD) and SCORE's
      // fetchReleaseTimes -- null for Kent/Kirkland, see CLAUDE.md.
      releaseReason: r.releaseReason || null,
      // "county" for explicitStatus sources' authoritative feed, and only
      // when releasedAt actually parses as a real date. Kirkland is the one
      // non-explicit source that can arrive already-released (its own
      // real-date "Release Date" column) -- marked "unverified" rather than
      // "county" since that column's reliability as an actual release event
      // (vs. a scheduling artifact) hasn't been independently confirmed.
      releaseSource: r.status !== 'released' ? null
        : sourceId === 'kirkland' ? 'unverified'
        : isValidDate(r.releasedAt) ? 'county' : null,
      releaseReversals: [],
      scheduledReleaseDate: r.scheduledReleaseDate || null,
      detailId: r.detailId || null,
      bookingDate: r.bookingDate,
      charges: detail ? detail.charges : (r.charges || []),
      // Full prior-booking history, when a source's detail fetch provides
      // it (currently just Kent) -- null for everyone else.
      priorBookings: detail && detail.priorBookings ? detail.priorBookings : null,
      // For sources with a separate detail fetch, "complete" means we got
      // real charge data (not just an empty/placeholder result because
      // charges haven't been formally filed yet) — if not complete, the
      // backfill pass below keeps retrying instead of freezing it forever.
      hasDetail: fetchDetailBatch ? !!(detail && detail.complete) : true,
    };
    roster[key] = entry;
    log.unshift(entry);
  }

  // Refresh mutable fields for records already known under the SAME booking.
  // Sources that return charges inline (Kent, Kirkland's list, KC DAJD) get
  // them refreshed every run; sources with a separate detail fetch are left
  // alone here and handled by the backfill pass below instead.
  let newlyReleased = 0;
  for (const { r, key } of existingRecords) {
    const existing = roster[key];
    if (!fetchDetailBatch && r.charges) existing.charges = r.charges;
    existing.facility = r.facility || existing.facility;
    existing.scheduledReleaseDate = r.scheduledReleaseDate || null;
    if (r.detailId) existing.detailId = r.detailId;
    if (explicitStatus) {
      if (existing.status === 'in_custody' && r.status === 'released') {
        console.log(`  RELEASED: ${existing.name}`);
        newlyReleased++;
      }
      existing.status = r.status;
      existing.releasedAt = r.releasedAt || existing.releasedAt;
      existing.releaseReason = r.releaseReason || existing.releaseReason;
      if (r.status === 'released' && isValidDate(r.releasedAt)) existing.releaseSource = 'county';
    } else if (existing.status === 'released' && (r.status || 'in_custody') === 'in_custody') {
      // Reappearance: the SAME booking showing up again on the live roster
      // after we'd marked it released -- the release was wrong (a scrape or
      // disappearance-detection false positive), not a real event. Reverse
      // it and keep what we'd recorded rather than silently discarding it.
      console.log(`  REVERSED: ${existing.name} (was released ${existing.releasedAt}, reappeared in custody under the same booking)`);
      existing.releaseReversals = existing.releaseReversals || [];
      existing.releaseReversals.push({
        releasedAt: existing.releasedAt,
        releaseReason: existing.releaseReason,
        releaseSource: existing.releaseSource,
        reversedAt: now,
      });
      existing.status = 'in_custody';
      existing.releasedAt = null;
      existing.releaseReason = null;
      existing.releaseSource = null;
    }
    const logEntry = log.find(e => e.idnum === key);
    if (logEntry) {
      logEntry.charges = existing.charges;
      logEntry.facility = existing.facility;
      logEntry.status = existing.status;
      logEntry.releasedAt = existing.releasedAt;
      logEntry.releaseReason = existing.releaseReason;
      logEntry.releaseSource = existing.releaseSource;
      logEntry.releaseReversals = existing.releaseReversals;
      logEntry.scheduledReleaseDate = existing.scheduledReleaseDate;
    }
  }

  // Backfill details for anyone still missing real charge data (first-run
  // overflow, previous fetch failures, or charges that weren't formally
  // filed yet when we last checked — see `complete` on the returned detail).
  if (fetchDetailBatch) {
    const needsDetailEntries = Object.values(roster)
      .filter(e => e.source === sourceId && !e.hasDetail)
      .slice(0, backfillBatch);
    // fetchDetailBatch expects the source's own raw id (SCORE's nn), not a
    // rebooking fork's compound roster key -- recover it by splitting on the
    // first ":". Safe for every other source too, since none of their real
    // ids ever contain a colon, so this is a no-op for them.
    const rawToKey = new Map(needsDetailEntries.map(e => [e.idnum.split(':')[0], e.idnum]));
    const needsDetail = [...rawToKey.keys()];

    if (needsDetail.length > 0) {
      console.log(`  Backfilling details for ${needsDetail.length} record(s)...`);
      try {
        const backfillMap = await fetchDetailBatch(needsDetail, { roster });
        for (const rawId of needsDetail) {
          const key = rawToKey.get(rawId);
          const detail = backfillMap[rawId];
          if (!detail) continue;
          const priorBookings = detail.priorBookings || null;
          roster[key] = { ...roster[key], charges: detail.charges, priorBookings, hasDetail: !!detail.complete };
          const logEntry = log.find(e => e.idnum === key);
          if (logEntry) Object.assign(logEntry, { charges: detail.charges, priorBookings, hasDetail: !!detail.complete });
        }
      } catch (err) {
        console.warn('  Backfill failed:', err.message);
      }
    }
  }

  // Releases.
  let releasedCount = 0;
  if (explicitStatus) {
    releasedCount = newlyReleased;
  } else {
    // forcedRebookings' old bookings are released below too -- exclude them
    // from the generic disappearance diff so they don't get processed twice.
    const forcedOldKeys = new Set(forcedRebookings.map(x => x.oldKey));
    const disappearedKeys = [...previousIds].filter(
      key => !currentKeys.has(key) && !forcedOldKeys.has(key)
        && roster[key]?.source === sourceId && roster[key]?.status === 'in_custody'
    );
    const toRelease = [
      ...disappearedKeys.map(key => ({ key, name: roster[key].name })),
      ...forcedRebookings.map(({ oldKey }) => ({ key: oldKey, name: roster[oldKey].name })),
    ];

    // fetchReleaseTimes returns every release row it found (not deduped by
    // id), since the same id can legitimately have more than one row -- e.g.
    // a rebooking fork's old booking and a genuine disappearance both
    // resolving in the same run. Match each key's OWN booking number against
    // that row set first, and only fall back to matching by raw id alone
    // when the row set doesn't carry a booking number to compare (or none
    // matches) -- used identically for every source of a release below.
    let releaseRows = [];
    if (fetchReleaseTimes && toRelease.length > 0) {
      // Same raw-id recovery as the backfill block above.
      const rawIds = [...new Set(toRelease.map(({ key }) => key.split(':')[0]))];
      try {
        releaseRows = await fetchReleaseTimes(rawIds);
      } catch (err) {
        console.warn('  fetchReleaseTimes failed, falling back to scrape time:', err.message);
      }
    }

    function resolveRelease(key) {
      const raw = key.split(':')[0];
      const bookingNumber = roster[key].bookingNumber;
      const nnRows = releaseRows.filter(row => row.nn === raw);
      const byBooking = nnRows.find(row => row.bookingNumber && row.bookingNumber === bookingNumber);
      // Only fall back to matching by nn alone when none of this nn's rows
      // carry a booking number to compare against at all -- if they do, and
      // none matches THIS booking, those rows belong to a different booking
      // for the same person and using one would attribute the wrong release
      // event. That's a real miss, not a match, so it falls through to now.
      const noBookingNumbers = nnRows.length > 0 && nnRows.every(row => !row.bookingNumber);
      const match = byBooking || (noBookingNumbers ? nnRows[0] : null);
      // Prefer the source's own authoritative release timestamp (e.g.
      // SCORE's recentreleases feed) over our scrape-detection time, since
      // the id can disappear from a live roster up to 30 min after the
      // actual release event.
      const infoReleasedAt = match?.releasedAt || null;
      const releasedAt = infoReleasedAt || now;
      const releaseReason = match?.releaseReason || null;
      // "county" only when the matched row's timestamp actually parses as a
      // valid date -- not just whether a row matched at all.
      const releaseSource = isValidDate(infoReleasedAt) ? 'county' : 'detected';
      return { releasedAt, releaseReason, releaseSource };
    }

    function applyRelease(key, logLabel) {
      const inmate = roster[key];
      console.log(`  ${logLabel}: ${inmate.name}`);
      const { releasedAt, releaseReason, releaseSource } = resolveRelease(key);
      inmate.status = 'released';
      inmate.releasedAt = releasedAt;
      inmate.releaseReason = releaseReason;
      inmate.releaseSource = releaseSource;
      inmate.scheduledReleaseDate = null;
      const logEntry = log.find(e => e.idnum === key);
      if (logEntry) {
        logEntry.status = 'released';
        logEntry.releasedAt = releasedAt;
        logEntry.releaseReason = releaseReason;
        logEntry.releaseSource = releaseSource;
        logEntry.scheduledReleaseDate = null;
      }
    }

    for (const key of disappearedKeys) applyRelease(key, 'RELEASED');
    for (const { oldKey } of forcedRebookings) applyRelease(oldKey, 'FORCED RELEASE');

    releasedCount = disappearedKeys.length + forcedRebookings.length;
  }

  writeJSON(ROSTER_FILE, roster);
  writeJSON(LOG_FILE, log);

  const inCustody = Object.values(roster).filter(e => e.status === 'in_custody').length;
  writeJSON(STATUS_FILE, { source: sourceId, inCustody, lastUpdated: now });

  console.log(`[${nowPST()}] ${label} done. ${newRecords.length} new, ${releasedCount} released. ${inCustody} in custody.`);
}
