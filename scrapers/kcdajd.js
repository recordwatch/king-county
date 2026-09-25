import axios from 'axios';

// King County doesn't run a live browsable "who's in custody right now"
// portal for KCCF/MRJC — the public DAJD lookup (dajd-jms.powerappsportals.us)
// is search-by-last-name only, no bulk/browse mode. The only bulk source is
// this Socrata Open Data feed, which is a booking *event* log (one row per
// charge, re-published every few days — NOT real-time) rather than a live
// roster. Resource id j56h-zgnm is stable even though the dataset's public
// title/date-range gets renamed every year.
const RESOURCE_URL = 'https://data.kingcounty.gov/resource/j56h-zgnm.json';

// Fallback label for rows where `current_facility` is blank (most rows,
// confirmed live -- ~31k of ~40k don't have it populated). When present it
// distinguishes King County Correctional Facility, Maleng Regional Justice
// Center, Community Correction Division, and Electronic Home Detention.
const FACILITY_LABEL = 'King County DAJD (KCCF/MRJC)';

// Pull a rolling window rather than the full ~13-month/40k-row history —
// this is a monitor, not a backfill of the county's whole archive (which
// stays queryable live at data.kingcounty.gov if anyone needs it). A wide
// enough window to safely cover anyone still in custody plus recent
// bookings/releases for the log.
const WINDOW_DAYS = 60;
const PAGE_SIZE = 1000;

function toISODate(d) {
  return d.toISOString().slice(0, 19);
}

async function fetchRows() {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const where = `booking_date_time > '${toISODate(cutoff)}'`;

  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await axios.get(RESOURCE_URL, {
      params: {
        $where: where,
        $order: 'booking_date_time DESC',
        $limit: PAGE_SIZE,
        $offset: offset,
      },
      timeout: 30000,
    });
    rows.push(...res.data);
    if (res.data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

function formatName(row) {
  const parts = [row.first_name, row.middle_name].filter(Boolean).join(' ');
  return `${row.last_name}, ${parts}`.trim();
}

// Groups per-charge rows into one booking entry each, matching the shared
// data shape (one entry per booking, charges[] nested inside).
function groupIntoBookings(rows) {
  const byBooking = new Map();
  for (const row of rows) {
    const id = row.book_of_arrest_number;
    if (!byBooking.has(id)) byBooking.set(id, []);
    byBooking.get(id).push(row);
  }

  const bookings = [];
  for (const [id, chargeRows] of byBooking) {
    // A booking is only "released" once every charge on it has a release
    // timestamp — if any single charge is still open, the person is still
    // in custody on this booking as a whole.
    const stillOpen = chargeRows.some(r => !r.release_date_time);
    const releasedAt = stillOpen
      ? null
      : chargeRows.reduce((latest, r) => (!latest || r.release_date_time > latest ? r.release_date_time : latest), null);

    const facilityRow = chargeRows.find(r => r.current_facility);
    // Used by the WA DOC cross-reference (lib/crossReferenceDOC.js) to skip
    // releases that obviously won't show up in DOC custody -- bond/bail/PR
    // releases aren't transfers. Take the release reason off whichever
    // charge actually has one; if reasons differ across charges on the same
    // booking, prefer a non-bail one (a single bail charge among several
    // "Transfer of Custody" charges shouldn't mask a real transfer).
    const reasons = chargeRows.map(r => r.release_reason).filter(Boolean);
    const releaseReason = reasons.find(r => !/bond|bail|personal recognizance/i.test(r)) || reasons[0] || null;

    bookings.push({
      idnum: id,
      bookingNumber: id,
      name: formatName(chargeRows[0]),
      facility: facilityRow ? facilityRow.current_facility : FACILITY_LABEL,
      bookingDate: chargeRows.reduce((min, r) => (r.booking_date_time < min ? r.booking_date_time : min), chargeRows[0].booking_date_time),
      status: stillOpen ? 'in_custody' : 'released',
      releasedAt,
      releaseReason: stillOpen ? null : releaseReason,
      charges: chargeRows.map(row => ({
        charge: row.charge,
        court: row.court,
        causeNumber: row.court_case_cause_number,
        rcw: row.rcw_ordinance_number,
        releaseReason: row.release_reason,
      })),
    });
  }

  return bookings;
}

function escapeSoQL(s) {
  return s.replace(/'/g, "''");
}

// Targeted lookup by booking number, bypassing the WINDOW_DAYS date filter
// entirely -- used for bookings that have aged out of the rolling window in
// fetchRows() above but are still stored as in_custody, so their real
// current status gets picked up instead of freezing forever. Batched
// defensively to keep query strings and page sizes reasonable.
async function fetchRowsByBookingNumber(bookingNumbers) {
  if (bookingNumbers.length === 0) return [];
  const rows = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < bookingNumbers.length; i += BATCH_SIZE) {
    const batch = bookingNumbers.slice(i, i + BATCH_SIZE);
    const list = batch.map(bn => `'${escapeSoQL(bn)}'`).join(',');
    const res = await axios.get(RESOURCE_URL, {
      params: { $where: `book_of_arrest_number in (${list})`, $limit: PAGE_SIZE },
      timeout: 30000,
    });
    rows.push(...res.data);
  }
  return rows;
}

export async function scrapeRoster(ctx = {}) {
  const rows = await fetchRows();
  const bookings = groupIntoBookings(rows);

  // A booking still open past WINDOW_DAYS simply stops being returned by the
  // windowed query above -- Socrata doesn't republish a row just because
  // it's still active -- which otherwise freezes it forever at its
  // last-known status regardless of what actually happened. Check those
  // specifically, by booking number, so they get resolved one way or the
  // other instead. `ctx.roster` is the currently-stored roster, passed in by
  // runScraper.js the same way fetchDetailBatch already receives it.
  const roster = ctx.roster || {};
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const inWindow = new Set(bookings.map(b => b.bookingNumber));
  const frozenBookingNumbers = Object.values(roster)
    .filter(e => e.status === 'in_custody' && e.bookingDate && new Date(e.bookingDate) < cutoff && !inWindow.has(e.bookingNumber))
    .map(e => e.bookingNumber);

  if (frozenBookingNumbers.length > 0) {
    const frozenRows = await fetchRowsByBookingNumber(frozenBookingNumbers);
    const frozenBookings = groupIntoBookings(frozenRows);
    const found = new Set(frozenBookings.map(b => b.bookingNumber));
    bookings.push(...frozenBookings);

    // A booking number Socrata simply doesn't return anything for isn't
    // proof of anything -- could be a transient API hiccup, could be a real
    // data gap -- so it's left completely out of the result rather than
    // guessed at either way. Since explicitStatus sources only touch ids
    // that actually appear in this run's records, leaving it out means the
    // stored entry stays exactly as it was: flagged here, not released.
    const notFound = frozenBookingNumbers.filter(bn => !found.has(bn));
    if (notFound.length > 0) {
      console.warn(`  ${notFound.length} booking(s) outside the ${WINDOW_DAYS}-day window not found in Socrata by number -- leaving unchanged, not releasing: ${notFound.join(', ')}`);
    }
  }

  return bookings;
}
