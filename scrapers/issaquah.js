import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';

// Issaquah City Jail. Three static HTML pages (regenerated on a schedule,
// served from Azure blob storage): the roster (everyone in custody), Bookings
// (recent) and Releases (recent). Every person row is followed by a hidden
// row holding their charges, so one request per page gets everything -- no
// detail fetch. Confirmed 2026-10-03.
//
// There is no booking number anywhere. "Number" is a per-person id: it
// doesn't rise with booking date (booked 2026-10-02: 141009; booked
// 2025-11-13: 186398). So a booking's idnum is person number + booked-at
// time ("349467-20260724170000") -- a rebooking gets a new id and the old
// booking keeps its release. If Issaquah ever corrects a booked-at time,
// that booking would look like a release plus a new booking.
//
// Releases has no release time (only booked-at, and the charges are
// emptied), so every Issaquah release is 'detected'. Being listed there is
// recorded as releaseConfirmed: the person really was released, not just
// dropped from the roster for some other reason.
//
// The CDN in front of the pages often serves an old copy (seen 2026-10-03).
// It caches a separate copy per Accept-Encoding (Vary: Accept-Encoding) and
// each goes stale on its own: at 03:37 UTC the identity copy was from 03:00,
// the brotli one mostly from 19:00 the day before and once from 20:00 the
// day before that. A cache-busting query string and Cache-Control: no-cache
// didn't help. Scraping an old copy would release everyone booked since and
// re-book them next run. So each page is fetched twice per encoding in
// ENCODINGS and the copy with the newest Last-Modified is used, and the
// roster's Last-Modified is kept in page_state.json: a roster older than the
// one used last run is a fetch failure, never diffed.
const BASE_URL = 'https://jailroster.issaquahwa.gov/jail';
const ROSTER_URL = `${BASE_URL}/`;
const RELEASES_URL = `${BASE_URL}/releases.html`;

export const FACILITY_LABEL = 'Issaquah City Jail';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// Agency and court codes, translated only where the meaning is certain;
// anything else is shown as the raw code. Unconfirmed codes (2026-10-03):
// NBPD, SNO, OSA (agencies), IQM, OTHR (courts).
const AGENCY_NAMES = {
  ISS: 'Issaquah Police',
  FPD: 'Federal Way Police',
  FWPD: 'Federal Way Police',
  MIPD: 'Mercer Island Police',
};
const COURT_NAMES = {
  FWM: 'Federal Way Municipal Court',
  MIM: 'Mercer Island Municipal Court',
  KCDC: 'King County District Court',
};

function cleanText(s) {
  return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

// "Issaquah Police (ISS)" when known, else the code itself; null if blank.
function label(code, names) {
  if (!code) return null;
  return names[code] ? `${names[code]} (${code})` : code;
}

// "17:00:00 07/24/2026" (Pacific) -> "07/24/2026, 17:00:00", the same shape
// nowPST() writes, so the frontend, parseNowPST() and build-db.js all read it.
export function toStoredDate(raw) {
  const m = cleanText(raw).match(/^(\d{2}):(\d{2}):(\d{2}) (\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[4]}/${m[5]}/${m[6]}, ${m[1]}:${m[2]}:${m[3]}` : null;
}

// Booking id: person number + booked-at, digits only (no ':' -- runScraper
// treats ':' as its own rebooking-fork separator).
export function bookingId(personNumber, bookedRaw) {
  const m = cleanText(bookedRaw).match(/^(\d{2}):(\d{2}):(\d{2}) (\d{2})\/(\d{2})\/(\d{4})$/);
  if (!personNumber || !m) return null;
  return `${personNumber}-${m[6]}${m[4]}${m[5]}${m[1]}${m[2]}${m[3]}`;
}

// "$5,050" -> "$5,050"; "$0" stays (a real zero); "$NaN" (Issaquah prints
// that when there's no amount) and blanks -> null.
function cleanBail(s) {
  const t = cleanText(s);
  return /^\$[\d,]+(\.\d+)?$/.test(t) ? t : null;
}

// Parses one page into [{ personNumber, name, bookedRaw, charges }].
export function parsePage(html) {
  const $ = cheerio.load(html);
  const people = [];
  $('#main-table > tbody > tr.name').each((_, row) => {
    const cells = $(row).children('td');
    const name = cleanText($(cells[0]).text());
    const personNumber = cleanText($(cells[1]).text());
    const bookedRaw = cleanText($(cells[2]).text());
    const charges = [];
    $(row).next('tr').find('table.sub-table > tbody > tr').each((__, cr) => {
      const c = $(cr).children('td').map((___, td) => cleanText($(td).text())).get();
      if (c.length < 8) return;
      const [arrestRaw, agency, court, billing, bondType, bond, warrant, description] = c;
      charges.push({
        charge: description || null,
        arrestAgency: label(agency, AGENCY_NAMES),
        arrestAgencyCode: agency || null,
        court: label(court, COURT_NAMES),
        courtCode: court || null,
        billingAgency: label(billing, AGENCY_NAMES),
        billingAgencyCode: billing || null,
        bondType: bondType || null,
        bail: cleanBail(bond),
        warrant: warrant || null,
        arrestDate: toStoredDate(arrestRaw),
      });
    });
    people.push({ personNumber, name, bookedRaw, charges });
  });
  return people;
}

const ENCODINGS = ['identity', 'gzip', 'br', 'gzip, deflate, br'];
const TRIES_PER_ENCODING = 2;
const STATE_FILE = 'page_state.json';

function get(url, encoding) {
  return axios.get(url, { headers: { ...HEADERS, 'Accept-Encoding': encoding }, timeout: 30000 });
}

// Fetches url TRIES_PER_ENCODING times per encoding; returns the copy with
// the newest Last-Modified as { html, lastModified (ms, or null if no copy
// had one) }. A failed request is skipped; it throws only if all fail.
export async function fetchNewest(url, fetchOne = get) {
  let best = null;
  let lastError = null;
  for (let i = 0; i < TRIES_PER_ENCODING; i++) for (const encoding of ENCODINGS) {
    let res;
    try {
      res = await fetchOne(url, encoding);
    } catch (err) {
      lastError = err;
      continue;
    }
    const lm = Date.parse(res.headers?.['last-modified'] ?? '');
    const lastModified = Number.isNaN(lm) ? null : lm;
    if (!best || (lastModified !== null && (best.lastModified === null || lastModified > best.lastModified))) {
      best = { html: res.data, lastModified };
    }
  }
  if (!best) throw lastError;
  return best;
}

function readState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

// Throws if this run's roster is older than the last one used; otherwise
// records its Last-Modified for the next run. A copy with no Last-Modified
// can't be compared and is used as is (warned).
export function checkRosterVersion(dataDir, lastModified) {
  if (!dataDir) return;
  if (lastModified === null) {
    console.warn('  Issaquah: roster had no parseable Last-Modified; can\'t tell whether it\'s a stale copy');
    return;
  }
  const prev = Date.parse(readState(dataDir).rosterLastModified ?? '');
  if (!Number.isNaN(prev) && lastModified < prev) {
    throw new Error(`only got a roster copy from ${new Date(lastModified).toISOString()}, older than last run's ${new Date(prev).toISOString()} (stale CDN copy)`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, STATE_FILE), JSON.stringify({ rosterLastModified: new Date(lastModified).toISOString() }, null, 2) + '\n');
}

export async function scrapeRoster({ dataDir } = {}) {
  const page = await fetchNewest(ROSTER_URL);
  checkRosterVersion(dataDir, page.lastModified);
  const people = parsePage(page.html);
  const records = [];
  for (const p of people) {
    const idnum = bookingId(p.personNumber, p.bookedRaw);
    if (!idnum || !p.name) {
      console.warn(`  Issaquah: skipped a row with no usable person number/booked-at ("${p.name}", "${p.personNumber}", "${p.bookedRaw}")`);
      continue;
    }
    records.push({
      idnum,
      personNumber: p.personNumber,
      bookingNumber: null,
      name: p.name,
      facility: FACILITY_LABEL,
      bookingDate: toStoredDate(p.bookedRaw),
      charges: p.charges,
    });
  }
  return records;
}

// Called by runScraper for bookings that just left the roster. Returns a
// row per booking listed on Releases -- no release time exists, so
// releasedAt stays null (-> 'detected'); `confirmed` marks it as listed.
export async function fetchReleaseTimes() {
  const people = parsePage((await fetchNewest(RELEASES_URL)).html);
  return people
    .map(p => ({ nn: bookingId(p.personNumber, p.bookedRaw), releasedAt: null, confirmed: true }))
    .filter(r => r.nn);
}
