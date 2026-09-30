// Builds a local SQLite database (kingcounty.db by default) from the
// committed data/<source>/roster.json files, for ad-hoc analysis. The .db is
// not committed (see .gitignore); rebuild it whenever data/ changes.
//
//   node build-db.js [output.db]      (Node 22.13+, uses built-in node:sqlite)
//
// Tables:
//   bookings         one row per tracked booking, all 4 sources
//   charges          one row per charge on a booking (booking_id -> bookings)
//   booking_history  SCORE and KC DAJD booking-history rows, with person_key
//   export_meta      when and from which commit the file was built
//
// Keys:
//   booking_id  "<source>:<idnum>", the same key the frontend uses. It is NOT
//               the booking number: SCORE's idnum is its per-person Name
//               Number, and SCORE has published the same booking number under
//               two Name Numbers (26-14036, 26-13804), so booking numbers
//               aren't unique.
//   person_key  "<source>:<id>" -- SCORE Name Number, KC DAJD UCN (from the
//               portal; not in change_log.json and not shown on the site),
//               Kent person id. NULL for Kirkland, which publishes no person
//               id, and for KC bookings the portal hasn't matched yet.
//               Namespaced by source so ids from different systems never
//               join by accident.
//
// Timestamps: every *_at column is UTC ISO 8601 ("2026-09-27T18:38:10.000Z");
// the original string is kept next to it in *_raw. The format decides the
// timezone, not the source: KC DAJD's Socrata/portal times are ISO without a
// marker and are UTC; everything written as MM/DD/YYYY -- SCORE, Kent and
// Kirkland times, and every source's firstSeen (our own nowPST(), including
// KC's) -- is Pacific wall-clock time, converted with the DST rules in force
// on that date. A value that doesn't parse ("In SCORE Custody", blanks) is
// NULL with its raw string kept, and is counted in the summary.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { pacificToUtc } from './utils.js';

const SOURCES = ['score', 'kent', 'kirkland', 'kc_dajd'];
const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'data');

// --- Timestamps ---

const validParts = (y, mo, d, h, mi, s) => {
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const x = new Date(t);
  return mo >= 1 && mo <= 12 && h <= 23 && mi <= 59 && s <= 59
    && x.getUTCFullYear() === y && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d;
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
// 09/27/2026, 06:12:16 | 9/25/2026 1:55:00 AM | 09/22/2026 01:38 AM | 08/09/2026 15:01
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i;

const unparsed = {};

// -> UTC ISO string, or null (counted under `field` when non-empty).
export function toUtcIso(raw, field = 'unknown') {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(ISO);
  if (m) {
    const [, y, mo, d, h, mi, sec = '0', frac = '', zone] = m;
    if (validParts(+y, +mo, +d, +h, +mi, +sec)) {
      // No marker = UTC (only KC DAJD writes this form; see header).
      const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec.padStart(2, '0')}${frac}${zone || 'Z'}`);
      if (!isNaN(t.getTime())) return t.toISOString();
    }
  }
  m = s.match(US);
  if (m) {
    let [, mo, d, y, h, mi, sec = '0', ampm] = m;
    let hour = +h;
    if (ampm) {
      if (hour < 1 || hour > 12) hour = 99;
      else hour = (hour % 12) + (/pm/i.test(ampm) ? 12 : 0);
    }
    if (validParts(+y, +mo, +d, hour, +mi, +sec)) return new Date(pacificToUtc(+y, +mo, +d, hour, +mi, +sec)).toISOString();
  }
  unparsed[field] = unparsed[field] || { count: 0, examples: new Set() };
  unparsed[field].count++;
  if (unparsed[field].examples.size < 3) unparsed[field].examples.add(s);
  return null;
}

function parseMoney(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

const str = v => (v === null || v === undefined || v === '' ? null : String(v));

function personKey(source, e) {
  if (source === 'score') return `score:${e.idnum}`;
  if (source === 'kc_dajd') return e.ucn ? `kc_dajd:${e.ucn}` : null;
  if (source === 'kent') return e.detailId ? `kent:${e.detailId}` : null;
  return null;
}

// --- Schema ---

const SCHEMA = `
CREATE TABLE bookings (
  booking_id             TEXT PRIMARY KEY,   -- "<source>:<idnum>"
  source                 TEXT NOT NULL,      -- score | kent | kirkland | kc_dajd
  idnum                  TEXT NOT NULL,      -- SCORE: Name Number; others: booking number
  booking_number         TEXT,
  person_key             TEXT,               -- "<source>:<person id>", NULL if none
  name                   TEXT,
  status                 TEXT NOT NULL,      -- in_custody | released
  status_source          TEXT,               -- KC DAJD: 'portal' once the jail lookup has checked it
  facility               TEXT,
  arresting_agency       TEXT,               -- KC DAJD (portal) only
  booked_at              TEXT,               -- UTC ISO
  booked_at_raw          TEXT,
  first_seen_at          TEXT,               -- UTC ISO (when our scraper first saw it)
  first_seen_raw         TEXT,
  released_at            TEXT,               -- UTC ISO
  released_at_raw        TEXT,
  release_source         TEXT,               -- county | detected | unverified | NULL
  release_reason         TEXT,
  release_type           TEXT,
  detected_released_at   TEXT,               -- SCORE: original guess before upgrade to county
  detected_released_raw  TEXT,
  scheduled_release_at   TEXT,               -- projected, NOT a release
  scheduled_release_raw  TEXT,
  total_bail             TEXT,
  total_bail_amount      REAL,
  has_detail             INTEGER,
  charge_count           INTEGER NOT NULL,
  portal_checked_at      TEXT,               -- UTC ISO
  release_reversals_json TEXT                -- JSON array, raw
);

CREATE TABLE charges (
  charge_id          INTEGER PRIMARY KEY,
  booking_id         TEXT NOT NULL REFERENCES bookings(booking_id),
  source             TEXT NOT NULL,
  seq                INTEGER NOT NULL,       -- order on the booking, from 0
  charge             TEXT,
  offense_code       TEXT,                   -- KC DAJD (portal)
  rcw                TEXT,
  court              TEXT,
  cause_number       TEXT,
  court_case         TEXT,                   -- KC DAJD (portal)
  warrant            TEXT,                   -- Kent
  bail               TEXT,
  bail_amount        REAL,
  bond_type          TEXT,                   -- SCORE
  charge_status      TEXT,                   -- KC DAJD (portal)
  disposition        TEXT,                   -- SCORE
  release_reason     TEXT,                   -- KC DAJD (Socrata, per charge)
  release_code       TEXT,                   -- KC DAJD (portal disposition code)
  release_type       TEXT,                   -- Kent
  arrest_agency      TEXT,                   -- SCORE (per charge)
  charge_date_at     TEXT,                   -- Kirkland, UTC ISO
  charge_date_raw    TEXT
);

CREATE TABLE booking_history (
  history_id         INTEGER PRIMARY KEY,
  source             TEXT NOT NULL,          -- score | kc_dajd
  person_key         TEXT,
  booking_id         TEXT NOT NULL REFERENCES bookings(booking_id), -- the booking it was captured with
  booking_number     TEXT,
  is_this_booking    INTEGER NOT NULL,       -- 1 if booking_number = the parent booking's number
  booked_at          TEXT,                   -- SCORE Date Booked, UTC ISO
  booked_at_raw      TEXT,
  arrested_at        TEXT,                   -- KC DAJD arrest time, UTC ISO
  arrested_at_raw    TEXT,
  released_at        TEXT,                   -- UTC ISO
  released_at_raw    TEXT,                   -- SCORE may say "In SCORE Custody"
  release_type       TEXT,                   -- SCORE
  booking_status     TEXT                    -- KC DAJD: Booked | Released
);

CREATE TABLE export_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX idx_bookings_person_key        ON bookings(person_key);
CREATE INDEX idx_bookings_booking_number    ON bookings(source, booking_number);
CREATE INDEX idx_charges_booking_id         ON charges(booking_id);
CREATE INDEX idx_history_booking_id         ON booking_history(booking_id);
CREATE INDEX idx_history_person_key         ON booking_history(person_key);
`;

// --- Build ---

export function buildDb(outFile, dataDir = DATA_DIR) {
  for (const k of Object.keys(unparsed)) delete unparsed[k];
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const db = new DatabaseSync(outFile);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const insBooking = db.prepare(`INSERT INTO bookings VALUES (${Array(29).fill('?').join(',')})`);
  const insCharge = db.prepare(`INSERT INTO charges (booking_id, source, seq, charge, offense_code, rcw, court, cause_number, court_case, warrant,
    bail, bail_amount, bond_type, charge_status, disposition, release_reason, release_code, release_type, arrest_agency, charge_date_at, charge_date_raw)
    VALUES (${Array(21).fill('?').join(',')})`);
  const insHistory = db.prepare(`INSERT INTO booking_history (source, person_key, booking_id, booking_number, is_this_booking, booked_at, booked_at_raw,
    arrested_at, arrested_at_raw, released_at, released_at_raw, release_type, booking_status)
    VALUES (${Array(13).fill('?').join(',')})`);

  db.exec('BEGIN');
  for (const source of SOURCES) {
    const roster = JSON.parse(fs.readFileSync(path.join(dataDir, source, 'roster.json'), 'utf-8'));
    for (const e of Object.values(roster)) {
      const bookingId = `${source}:${e.idnum}`;
      const pk = personKey(source, e);
      const charges = e.charges || [];
      insBooking.run(
        bookingId, source, String(e.idnum), str(e.bookingNumber), pk, str(e.name), e.status, str(e.statusSource), str(e.facility),
        str(e.arrestingAgency),
        toUtcIso(e.bookingDate, `${source}.bookingDate`), str(e.bookingDate),
        toUtcIso(e.firstSeen, `${source}.firstSeen`), str(e.firstSeen),
        toUtcIso(e.releasedAt, `${source}.releasedAt`), str(e.releasedAt),
        str(e.releaseSource), str(e.releaseReason), str(e.releaseType),
        toUtcIso(e.detectedReleasedAt, `${source}.detectedReleasedAt`), str(e.detectedReleasedAt),
        toUtcIso(e.scheduledReleaseDate, `${source}.scheduledReleaseDate`), str(e.scheduledReleaseDate),
        str(e.totalBail), parseMoney(e.totalBail),
        e.hasDetail === undefined || e.hasDetail === null ? null : (e.hasDetail ? 1 : 0),
        charges.length,
        toUtcIso(e.portalCheckedAt, `${source}.portalCheckedAt`),
        e.releaseReversals && e.releaseReversals.length ? JSON.stringify(e.releaseReversals) : null,
      );
      charges.forEach((c, i) => insCharge.run(
        bookingId, source, i, str(c.charge), str(c.offenseCode), str(c.rcw), str(c.court), str(c.causeNumber), str(c.courtCase), str(c.warrant),
        str(c.bail), parseMoney(c.bail), str(c.bondType), str(c.chargeStatus), str(c.disposition), str(c.releaseReason), str(c.releaseCode),
        str(c.releaseType), str(c.arrestAgency),
        toUtcIso(c.chargeDate, `${source}.charges.chargeDate`), str(c.chargeDate),
      ));
      if ((source === 'score' || source === 'kc_dajd') && Array.isArray(e.bookingHistory)) {
        for (const b of e.bookingHistory) {
          insHistory.run(
            source, pk, bookingId, str(b.bookingNumber), b.bookingNumber === e.bookingNumber ? 1 : 0,
            toUtcIso(b.dateBooked, `${source}.bookingHistory.dateBooked`), str(b.dateBooked),
            toUtcIso(b.dateArrested, `${source}.bookingHistory.dateArrested`), str(b.dateArrested),
            // SCORE's "In SCORE Custody" placeholder isn't a date.
            b.dateReleased === 'In SCORE Custody' ? null : toUtcIso(b.dateReleased, `${source}.bookingHistory.dateReleased`), str(b.dateReleased),
            str(b.releaseType), str(b.bookingStatus),
          );
        }
      }
    }
  }

  let commit = null;
  try { commit = execSync('git rev-parse HEAD', { cwd: dataDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  const insMeta = db.prepare('INSERT INTO export_meta VALUES (?, ?)');
  insMeta.run('built_at', new Date().toISOString());
  insMeta.run('git_commit', commit);
  insMeta.run('timestamps', 'All *_at columns are UTC ISO 8601; *_raw keeps the source string.');
  db.exec('COMMIT');

  const counts = Object.fromEntries(['bookings', 'charges', 'booking_history'].map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  db.close();
  return { counts, unparsed: Object.fromEntries(Object.entries(unparsed).map(([k, v]) => [k, { count: v.count, examples: [...v.examples] }])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const out = process.argv[2] || 'kingcounty.db';
  const { counts, unparsed: bad } = buildDb(out);
  console.log(`Wrote ${out}`);
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n} rows`);
  const badFields = Object.entries(bad);
  if (badFields.length) {
    console.log('Timestamps that did not parse (stored as NULL, raw kept):');
    for (const [f, v] of badFields) console.log(`  ${f}: ${v.count} (e.g. ${v.examples.map(x => JSON.stringify(x)).join(', ')})`);
  }
}
