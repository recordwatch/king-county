import axios from 'axios';
import * as cheerio from 'cheerio';

// Kirkland PD books people into multiple different facilities (its own
// "KPD Jail" holding, King County's KCJ, or SCORE) depending on the case —
// the "Location" column reflects that. Static HTML table + a per-booking
// detail page for charges. Only shows a small rolling window of recent
// activity, not full history.
const BASE_URL = 'https://pd.norcom.org';
const ROSTER_URL = `${BASE_URL}/jailregister/`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function cleanText(s) {
  return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

// bookingNumber -> internal detail-page id (e.g. "-45140"), populated by
// scrapeRoster() and consumed by scrapeDetailBatch() within the same run —
// the roster list page is the only place this internal id is exposed.
const detailIdCache = new Map();

export async function scrapeRoster() {
  const res = await axios.get(ROSTER_URL, { headers: HEADERS, timeout: 30000 });
  const $ = cheerio.load(res.data);

  const inmates = [];
  $('table.table tbody tr, table.table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;

    const link = $(cells[0]).find('a').first();
    const name = cleanText(link.text());
    const href = link.attr('href') || '';
    const idMatch = href.match(/BookingDetail\/(-?\d+)/);
    if (!name || !idMatch) return;

    const facility = cleanText($(cells[1]).text());
    const bookingDate = cleanText($(cells[2]).text());
    const bookingNumber = cleanText($(cells[3]).text());
    const releaseDate = cleanText($(cells[4]).text());
    if (!bookingNumber) return;

    detailIdCache.set(bookingNumber, idMatch[1]);

    inmates.push({
      idnum: bookingNumber,
      bookingNumber,
      name,
      facility: facility || 'KPD Jail',
      bookingDate,
      status: releaseDate ? 'released' : 'in_custody',
      releasedAt: releaseDate || null,
      charges: [],
    });
  });

  return inmates;
}

function parseDetail(html) {
  const $ = cheerio.load(html);
  const tables = $('table.table');

  const charges = [];
  // Second table: Citation/Warrant #, Charge Description, Charge Date
  $(tables[1]).find('tr').slice(1).each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const charge = cleanText($(cells[1]).text());
    if (!charge) return;
    charges.push({
      charge,
      causeNumber: cleanText($(cells[0]).text()) || null,
      chargeDate: cleanText($(cells[2]).text()) || null,
    });
  });

  // Third table: Statute(s), Total Bond Amount
  let bail = null;
  const bondRow = $(tables[2]).find('tr').eq(1);
  if (bondRow.length) {
    const bondCells = bondRow.find('td');
    const bondText = cleanText($(bondCells[1]).text());
    if (bondText) bail = bondText;
  }

  const bailAmount = bail ? parseFloat(bail.replace(/[$,]/g, '')) : 0;
  if (bailAmount > 0) {
    if (charges.length > 0) {
      charges.forEach(c => { c.bail = bail; });
    } else {
      // Bond can be set before a formal charge description is published —
      // surface it as its own placeholder charge rather than dropping it.
      charges.push({ charge: 'Charge pending', bail });
    }
  }

  return { charges };
}

export async function scrapeDetailBatch(bookingNumbers) {
  const results = {};
  for (const bookingNumber of bookingNumbers) {
    const detailId = detailIdCache.get(bookingNumber);
    if (!detailId) continue;
    try {
      const res = await axios.get(`${BASE_URL}/jailregister/BookingDetail/${detailId}`, { headers: HEADERS, timeout: 20000 });
      results[bookingNumber] = parseDetail(res.data);
    } catch (err) {
      console.warn(`  Detail fetch failed for ${bookingNumber}:`, err.message);
    }
  }
  return results;
}
