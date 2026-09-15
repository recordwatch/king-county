import fs from 'fs';
import path from 'path';
import { nowPST } from '../utils.js';
import { normalizeName } from '../scrapers/wadoc.js';

// Cross-references county jail releases against the WA DOC statewide
// roster to catch jail-to-prison transfers -- someone released from a
// county jail who then shows up in DOC custody almost certainly wasn't
// actually "released" in the everyday sense. Kept as its own file
// (data/wadoc/matches.json) rather than mutating each source's own
// roster/change_log files, so this never risks conflicting with the 30-min
// live-source workflow's writes -- same "independent files, merge
// client-side" pattern as the other 4 sources.
//
// Design (per explicit user direction 2026-09-15, to avoid publicly
// misattributing someone's DOC record based on a coincidental same name):
// a match is only ever recorded, let alone published, if ALL of:
//   1. The person disappeared from a county's live custody list (our
//      existing diff-based release detection) at least THRESHOLD_DAYS ago
//      -- gives real transfer paperwork time to show up in DOC's system.
//   2. The county's own release reason (when available) isn't an obvious
//      non-transfer -- bond/bail/PR releases don't show up in DOC the next
//      day, so there's no reason to even check those.
//   3. The name match against the DOC roster is EXACT and UNAMBIGUOUS --
//      if more than one DOC inmate shares that normalized name, we
//      deliberately do NOT guess; it's recorded as inconclusive.
//   4. The matched DOC record's facility is a receiving unit (Washington
//      Corrections Center - RC, or Washington Corrections Center for
//      Women - Receiving) -- that's where someone freshly transferred in
//      from county custody actually shows up, not general population.
//
// Known limitation: release reason is only reliably available for KC DAJD
// (explicit `release_reason` field in the source data) and SCORE (via one
// extra per-release fetch of that person's Booking List "Release Type").
// Kent and Kirkland don't expose a usable release-reason signal (Kirkland's
// detail page goes empty once someone is actually released; Kent doesn't
// have a clean release-outcome field) -- for those two, step 2 is skipped
// and steps 1/3/4 carry the full weight of avoiding false positives.
const THRESHOLD_DAYS = 3;
const SOURCES = ['score', 'kent', 'kirkland', 'kc_dajd'];
const BAIL_LIKE = /bond|bail|personal recognizance/i;
const RECEIVING_FACILITY = /washington corrections center( for women)? -( receiving|.*\brc\b)/i;

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return fallback;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

function buildNameIndex(docRoster) {
  const byName = new Map();
  for (const rec of docRoster) {
    const key = normalizeName(rec.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(rec);
  }
  return byName;
}

export function runCrossReference(docRoster, dataDir) {
  const nameIndex = buildNameIndex(docRoster);
  const matchesFile = path.join(dataDir, 'wadoc', 'matches.json');
  const matches = readJSON(matchesFile, {});
  const cutoff = Date.now() - THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const now = nowPST();

  let checkedCount = 0;
  let foundCount = 0;

  for (const source of SOURCES) {
    const roster = readJSON(path.join(dataDir, source, 'roster.json'), {});
    matches[source] = matches[source] || {};

    for (const [idnum, entry] of Object.entries(roster)) {
      if (entry.status !== 'released' || !entry.releasedAt) continue;
      if (matches[source][idnum]) continue; // already checked once

      const releasedTime = new Date(entry.releasedAt).getTime();
      if (isNaN(releasedTime) || releasedTime > cutoff) continue; // not old enough yet

      // Skip obvious non-transfers before even touching the DOC lookup --
      // only source data we actually have (see limitation note above).
      if (entry.releaseReason && BAIL_LIKE.test(entry.releaseReason)) {
        matches[source][idnum] = { found: false, skipped: 'bail_or_pr', checkedAt: now };
        continue;
      }

      checkedCount++;
      const candidates = nameIndex.get(normalizeName(entry.name));
      const receivingCandidates = (candidates || []).filter(c => RECEIVING_FACILITY.test(c.facility || ''));

      if (receivingCandidates.length === 0) {
        matches[source][idnum] = { found: false, checkedAt: now };
      } else if (receivingCandidates.length === 1) {
        matches[source][idnum] = { found: true, ambiguous: false, ...receivingCandidates[0], checkedAt: now };
        foundCount++;
      } else {
        // Multiple people with this exact name in a receiving unit right
        // now -- can't responsibly say which one, so flag as inconclusive
        // rather than picking one.
        matches[source][idnum] = { found: true, ambiguous: true, candidateCount: receivingCandidates.length, checkedAt: now };
      }
    }
  }

  writeJSON(matchesFile, matches);
  return { checkedCount, foundCount };
}
