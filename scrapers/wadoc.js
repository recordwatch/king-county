import axios from 'axios';
import * as cheerio from 'cheerio';

// Washington State DOC's statewide incarcerated-population listing.
// CONFIRMED 2026-09-15 (correcting an earlier wrong conclusion): this is a
// plain Drupal Views page, not VINE and not a JS app -- a real paginated
// HTML <table> (DOC Number, Name, Age, Location/facility, Housing
// Assignment), no session/auth/JS required. Fully bulk-browsable via
// ?page=0..~141 (confirmed live, ~100 rows/page, ~14,000 people total) with
// no name filter needed -- the earlier "VINE SPA, search-only" conclusion
// was wrong and came from trusting a tool summary instead of the raw HTML.
const BASE_URL = 'https://doc.wa.gov/records/incarcerated-data-search/incarcerated-search';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

async function fetchPage(page) {
  const res = await axios.get(BASE_URL, { params: { page }, headers: HEADERS, timeout: 30000 });
  const $ = cheerio.load(res.data);
  const rows = [];
  $('table.tablesaw tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 5) return;
    rows.push({
      docNumber: cleanText($(cells[0]).text()),
      name: cleanText($(cells[1]).text()),
      age: cleanText($(cells[2]).text()),
      facility: cleanText($(cells[3]).text()),
      housingAssignment: cleanText($(cells[4]).text()),
    });
  });
  return rows;
}

// Full statewide pull -- this is a reference dataset for cross-referencing
// county releases, not a live roster to diff, so it doesn't go through the
// shared runScrape() diff engine. Runs on its own daily schedule.
export async function scrapeRoster() {
  const all = [];
  for (let page = 0; ; page++) {
    const rows = await fetchPage(page);
    if (rows.length === 0) break;
    all.push(...rows);
  }
  return all;
}

// "LAST, FIRST MIDDLE" with punctuation/whitespace normalized -- matches
// the naming convention already shared by all 4 county sources.
export function normalizeName(name) {
  return cleanText(name).toUpperCase().replace(/[.,]/g, '');
}
