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

    const isBail = /^\$/.test(bailOrReleaseType);
    const charges = chargesText
      ? chargesText.split(',').map(c => c.trim()).filter(Boolean).map(charge => ({
          charge,
          bail: isBail ? bailOrReleaseType : null,
        }))
      : [];

    inmates.push({
      idnum: bookingNumber,
      personId: personIds[i] || null,
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
