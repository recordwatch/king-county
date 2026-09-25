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

  const currentIds = new Set(records.map(r => r.idnum));
  const previousIds = new Set(Object.keys(roster));
  const now = nowPST();

  const newRecords = records.filter(r => !previousIds.has(r.idnum));
  console.log(`  ${newRecords.length} new record(s) found`);

  let detailMap = {};
  if (fetchDetailBatch && newRecords.length > 0 && newRecords.length <= detailBatchLimit) {
    console.log(`  Fetching details for ${newRecords.length} new record(s)...`);
    try {
      detailMap = await fetchDetailBatch(newRecords.map(r => r.idnum), { roster });
    } catch (err) {
      console.warn('  Detail batch failed:', err.message);
    }
  } else if (fetchDetailBatch && newRecords.length > detailBatchLimit) {
    console.log(`  Skipping details (${newRecords.length} new — likely first run)`);
  }

  for (const r of newRecords) {
    console.log(`  NEW: ${r.name}`);
    const detail = detailMap[r.idnum];
    const entry = {
      idnum: r.idnum,
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
    roster[r.idnum] = entry;
    log.unshift(entry);
  }

  // Refresh mutable fields for records already known. Sources that return
  // charges inline (Kent, Kirkland's list, KC DAJD) get them refreshed every
  // run; sources with a separate detail fetch are left alone here and
  // handled by the backfill pass below instead.
  let newlyReleased = 0;
  for (const r of records) {
    if (!previousIds.has(r.idnum)) continue;
    const existing = roster[r.idnum];
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
    }
    const logEntry = log.find(e => e.idnum === r.idnum);
    if (logEntry) {
      logEntry.charges = existing.charges;
      logEntry.facility = existing.facility;
      logEntry.status = existing.status;
      logEntry.releasedAt = existing.releasedAt;
      logEntry.releaseReason = existing.releaseReason;
      logEntry.scheduledReleaseDate = existing.scheduledReleaseDate;
    }
  }

  // Backfill details for anyone still missing real charge data (first-run
  // overflow, previous fetch failures, or charges that weren't formally
  // filed yet when we last checked — see `complete` on the returned detail).
  if (fetchDetailBatch) {
    const needsDetail = Object.values(roster)
      .filter(e => e.source === sourceId && !e.hasDetail)
      .slice(0, backfillBatch)
      .map(e => e.idnum);

    if (needsDetail.length > 0) {
      console.log(`  Backfilling details for ${needsDetail.length} record(s)...`);
      try {
        const backfillMap = await fetchDetailBatch(needsDetail, { roster });
        for (const id of needsDetail) {
          const detail = backfillMap[id];
          if (!detail) continue;
          const priorBookings = detail.priorBookings || null;
          roster[id] = { ...roster[id], charges: detail.charges, priorBookings, hasDetail: !!detail.complete };
          const logEntry = log.find(e => e.idnum === id);
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
    const releasedIds = [...previousIds].filter(
      id => !currentIds.has(id) && roster[id]?.source === sourceId && roster[id]?.status === 'in_custody'
    );

    let releaseTimes = {};
    if (fetchReleaseTimes && releasedIds.length > 0) {
      try {
        releaseTimes = await fetchReleaseTimes(releasedIds);
      } catch (err) {
        console.warn('  fetchReleaseTimes failed, falling back to scrape time:', err.message);
      }
    }

    for (const id of releasedIds) {
      const inmate = roster[id];
      console.log(`  RELEASED: ${inmate.name}`);
      inmate.status = 'released';
      // Prefer the source's own authoritative release timestamp (e.g.
      // SCORE's recentreleases feed) over our scrape-detection time, since
      // the id can disappear from a live roster up to 30 min after the
      // actual release event. fetchReleaseTimes may return a plain string
      // (just the timestamp) or { releasedAt, releaseReason } when a source
      // can also determine why -- normalize both shapes here.
      const info = releaseTimes[id];
      const releasedAt = (typeof info === 'string' ? info : info?.releasedAt) || now;
      const releaseReason = (typeof info === 'object' ? info?.releaseReason : null) || null;
      inmate.releasedAt = releasedAt;
      inmate.releaseReason = releaseReason;
      inmate.scheduledReleaseDate = null;
      const logEntry = log.find(e => e.idnum === id);
      if (logEntry) {
        logEntry.status = 'released';
        logEntry.releasedAt = releasedAt;
        logEntry.releaseReason = releaseReason;
        logEntry.scheduledReleaseDate = null;
      }
    }
    releasedCount = releasedIds.length;
  }

  writeJSON(ROSTER_FILE, roster);
  writeJSON(LOG_FILE, log);

  const inCustody = Object.values(roster).filter(e => e.status === 'in_custody').length;
  writeJSON(STATUS_FILE, { source: sourceId, inCustody, lastUpdated: now });

  console.log(`[${nowPST()}] ${label} done. ${newRecords.length} new, ${releasedCount} released. ${inCustody} in custody.`);
}
