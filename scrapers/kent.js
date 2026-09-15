import axios from 'axios';
import * as cheerio from 'cheerio';

// City of Kent Corrections Facility. ASP.NET MVC app — confirmed via curl
// that a plain form POST (no anti-forgery token present anywhere on the
// page) returns the full "everyone in custody" table server-rendered in
// one response. The visible 10/25-per-page "pager" is a client-side
// tablesorter widget — every row is already in the HTML we get back.
const BASE_URL = 'https://jils.kentwa.gov/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Content-Type': 'application/x-www-form-urlencoded',
};

function cleanText(s) {
  return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

// bookingNumber -> personId (Search.InmateSearchResults[N].InmateId), used
// to call the History endpoint below. Every currently-in-custody person is
// on the one full roster page each run (unlike Kirkland's small rolling
// window), so this cache is always complete for anyone still in custody.
const personIdCache = new Map();

export async function scrapeRoster() {
  const body = new URLSearchParams({
    'Search.BrowseSelection': 'All',
    'action:Browse': 'Browse',
  });
  const res = await axios.post(BASE_URL, body, { headers: HEADERS, timeout: 30000 });
  const $ = cheerio.load(res.data);

  // Hidden inputs (InmateId/DateOfBirth/Gender) are siblings of the <tr>
  // elements inside <tbody>, one triplet immediately before each row, in
  // the same order as the rows themselves.
  const tbody = $('table tbody').first();
  const personIds = [];
  // Scoped to the top-level search-results array field — each row also has
  // its own unrelated "History.InmateId" hidden input inside the name
  // button's form, which would double-count/misalign against `rows` here.
  tbody.find('input[name^="Search.InmateSearchResults"][name$=".InmateId"]').each((_, el) => personIds.push($(el).attr('value')));

  const rows = tbody.find('> tr');
  const inmates = [];

  rows.each((i, row) => {
    const cells = $(row).find('> td');
    if (cells.length < 6) return;

    const name = cleanText($(cells[0]).find('button').first().text());
    const facility = cleanText($(cells[1]).text());
    const bookingNumber = cleanText($(cells[2]).text());
    const bookingDate = cleanText($(cells[3]).text());
    const bailOrReleaseType = cleanText($(cells[4]).text());
    const chargesText = cleanText($(cells[5]).text());

    if (!bookingNumber) return;

    const personId = personIds[i] || null;
    if (personId) personIdCache.set(bookingNumber, personId);

    const isBail = /^\$/.test(bailOrReleaseType);
    const charges = chargesText
      ? chargesText.split(',').map(c => c.trim()).filter(Boolean).map(charge => ({
          charge,
          bail: isBail ? bailOrReleaseType : null,
        }))
      : [];

    inmates.push({
      idnum: bookingNumber,
      personId,
      detailId: personId,
      bookingNumber,
      name,
      facility: facility || 'Kent Corrections Facility',
      bookingDate,
      status: 'in_custody',
      charges,
    });
  });

  return inmates;
}

// Kent's roster table only shows a flat comma-joined charge string. There's
// an undocumented "History" endpoint -- POST / with History.InmateId=<id>
// and action:History= present (ASP.NET MVC's multi-submit-button pattern;
// the button has no value attribute, just needs the key present) -- that
// returns a per-charge breakdown (Warrant/Citation No, RCW/ORD, Court,
// Bail) for the current booking, PLUS every prior booking that person has
// had at Kent, each with its own full charge breakdown. Confirmed live.
function parseHistory($) {
  const bookings = [];

  $('#inmateCharges > .panel').each((_, panel) => {
    const isCurrent = $(panel).hasClass('panel-success');
    const spans = $(panel).find('.panel-heading a > span');
    const headerText = cleanText($(spans[0]).text());
    const statusText = cleanText($(spans[1]).text());

    const headerMatch = headerText.match(/booking:\s*([\w-]+),\s*Booked:\s*(.+?),?$/i);
    const bookingNumber = headerMatch ? headerMatch[1] : null;
    const bookedDate = headerMatch ? headerMatch[2].trim() : null;
    const releasedMatch = statusText.match(/Released:\s*(.+)/i);

    const charges = [];
    $(panel).find('.panel-body .row .col-md-6').each((__, col) => {
      const fields = {};
      $(col).find('p').each((___, p) => {
        const text = cleanText($(p).text());
        const m = text.match(/^([^:]+):\s*(.*)$/);
        if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
      });
      if (!fields['charge']) return;
      charges.push({
        charge: fields['charge'],
        warrant: fields['warrant/citation no'] || null,
        rcw: fields['rcw/ord'] || null,
        court: fields['court'] || null,
        bail: fields['bail'] || null,
      });
    });

    bookings.push({
      bookingNumber,
      bookedDate,
      isCurrent,
      status: isCurrent ? statusText : null,
      releasedDate: releasedMatch ? releasedMatch[1].trim() : null,
      charges,
    });
  });

  return bookings;
}

export async function scrapeDetailBatch(bookingNumbers, { roster } = {}) {
  const results = {};
  for (const bookingNumber of bookingNumbers) {
    const personId = personIdCache.get(bookingNumber) || roster?.[bookingNumber]?.detailId;
    if (!personId) continue;
    try {
      const body = new URLSearchParams({ 'History.InmateId': personId, 'action:History': '' });
      const res = await axios.post(BASE_URL, body, { headers: HEADERS, timeout: 20000 });
      const $ = cheerio.load(res.data);
      const bookings = parseHistory($);
      const current = bookings.find(b => b.isCurrent);
      const priorBookings = bookings.filter(b => !b.isCurrent && b.bookingNumber !== bookingNumber);
      const charges = current ? current.charges : [];
      results[bookingNumber] = { charges, priorBookings, complete: charges.length > 0 };
    } catch (err) {
      console.warn(`  History fetch failed for ${bookingNumber}:`, err.message);
    }
  }
  return results;
}
