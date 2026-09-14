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
export async function scrapeRoster() {
  const rows = await fetchRows();

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

    bookings.push({
      idnum: id,
      bookingNumber: id,
      name: formatName(chargeRows[0]),
      facility: facilityRow ? facilityRow.current_facility : FACILITY_LABEL,
      bookingDate: chargeRows.reduce((min, r) => (r.booking_date_time < min ? r.booking_date_time : min), chargeRows[0].booking_date_time),
      status: stillOpen ? 'in_custody' : 'released',
      releasedAt,
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
