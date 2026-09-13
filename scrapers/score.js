import axios from 'axios';
import * as cheerio from 'cheerio';

// SCORE (South Correctional Entity) — regional jail serving Auburn, Burien,
// Des Moines, Normandy Park, SeaTac, and Tukwila. Server-rendered HTML, no
// JS/API call and no session/cookie gate needed — confirmed via direct GET.
const ROSTER_URL = 'https://jils.scorejail.org/roster';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function cleanText(s) {
  return (s || '').replace(/ /g, ' ').trim();
}

function parseField($, row) {
  const label = cleanText($(row).find('b').first().text()).replace(/:\s*$/, '').toLowerCase();
  const value = cleanText($(row).find('li').first().text());
  return [label, value];
}

// The public roster/detail pages only expose custody status and
// booking/release dates — there is no charge information anywhere on the
// SCORE JILS site (confirmed: the per-person "view" page is a booking
// *history* list, not charges). So every SCORE entry carries an empty
// charges[] permanently, not just until a detail fetch backfills it.
export async function scrapeRoster() {
  const res = await axios.get(ROSTER_URL, { headers: HEADERS, timeout: 30000 });
  const $ = cheerio.load(res.data);

  const inmates = [];
  $('.list > div.uk-panel').not('.sc-heading-container').each((_, el) => {
    const fields = {};
    $(el).find('> .row').each((__, row) => {
      const [label, value] = parseField($, row);
      if (label) fields[label] = value;
    });

    const nameNumber = fields['name number'];
    if (!nameNumber) return;

    inmates.push({
      idnum: nameNumber,
      bookingNumber: fields['booking number'],
      name: `${fields['last name']}, ${[fields['first name'], fields['middle name']].filter(Boolean).join(' ')}`.trim(),
      facility: 'SCORE',
      bookingDate: fields['date booked'],
      status: 'in_custody',
      charges: [],
    });
  });

  return inmates;
}
