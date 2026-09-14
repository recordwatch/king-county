import axios from 'axios';
import * as cheerio from 'cheerio';

// SCORE (South Correctional Entity) — regional jail serving Auburn, Burien,
// Des Moines, Normandy Park, SeaTac, and Tukwila. Server-rendered HTML, no
// JS/API call and no session/cookie gate needed — confirmed via direct GET.
const ROSTER_URL = 'https://jils.scorejail.org/roster';
const VIEW_URL = 'https://jils.scorejail.org/view';
const RECENT_RELEASES_URL = 'https://jils.scorejail.org/recentreleases';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// SCORE runs a nightly/periodic full rebuild during which every page
// (including /roster) briefly serves an "Updating Information!" placeholder
// instead of real content — confirmed live, lasting a few minutes. Treat it
// as an unusable response rather than parsing it as 0 real records.
function isUpdatingPlaceholder(html) {
  return /Updating Information/i.test(html);
}

function cleanText(s) {
  return (s || '').replace(/ /g, ' ').trim();
}

function parseField($, row) {
  const label = cleanText($(row).find('b').first().text()).replace(/:\s*$/, '').toLowerCase();
  const value = cleanText($(row).find('li').first().text());
  return [label, value];
}

// Generic parser for SCORE's repeating "list of .uk-panel rows" markup,
// used by the roster, recentreleases, and per-person view pages alike.
function parsePanels($, scope) {
  const out = [];
  scope.find('> div.uk-panel').not('.sc-heading-container').each((_, el) => {
    const fields = {};
    $(el).find('> .row').each((__, row) => {
      const [label, value] = parseField($, row);
      if (label) fields[label] = value;
    });
    out.push(fields);
  });
  return out;
}

export async function scrapeRoster() {
  const res = await axios.get(ROSTER_URL, { headers: HEADERS, timeout: 30000 });
  if (isUpdatingPlaceholder(res.data)) {
    console.warn('  SCORE is mid-rebuild ("Updating Information") -- skipping this run.');
    return [];
  }
  const $ = cheerio.load(res.data);

  const inmates = [];
  for (const fields of parsePanels($, $('.list'))) {
    const nameNumber = fields['name number'];
    if (!nameNumber) continue;

    inmates.push({
      idnum: nameNumber,
      bookingNumber: fields['booking number'],
      name: `${fields['last name']}, ${[fields['first name'], fields['middle name']].filter(Boolean).join(' ')}`.trim(),
      facility: 'SCORE',
      bookingDate: fields['date booked'],
      status: 'in_custody',
      charges: [],
    });
  }

  return inmates;
}

// The public roster list has no charge info, but the per-person "view" page
// does -- under "Current Booking" there's an "Offenses" table (confirmed
// live) with Agency/Offense/Cause Number/Offense Status/Bond/Bond Amount
// per charge. Requires one POST per person (nn=<Name Number>), so it's
// batched/rate-limited the same way as Kirkland's per-booking detail fetch.
function parseOffenses($) {
  const charges = [];
  $('h3').filter((_, el) => cleanText($(el).text()) === 'Offenses').each((_, h3) => {
    const panels = parsePanels($, $(h3).next('.list'));
    for (const f of panels) {
      if (!f['offense']) continue;
      charges.push({
        charge: f['offense'],
        arrestAgency: f['agency'] || null,
        causeNumber: f['cause number'] || null,
        disposition: f['offense status'] || null,
        bondType: f['bond'] || null,
        bail: f['bond amount'] || null,
      });
    }
  });
  return charges;
}

export async function scrapeDetailBatch(nameNumbers) {
  const results = {};
  for (const nn of nameNumbers) {
    try {
      const res = await axios.post(VIEW_URL, new URLSearchParams({ nn }), { headers: HEADERS, timeout: 20000 });
      if (isUpdatingPlaceholder(res.data)) continue;
      const $ = cheerio.load(res.data);
      const charges = parseOffenses($);
      results[nn] = { charges, complete: charges.length > 0 };
    } catch (err) {
      console.warn(`  Detail fetch failed for nn=${nn}:`, err.message);
    }
  }
  return results;
}

// SCORE's own /recentreleases feed publishes the authoritative release
// timestamp for each booking -- using it instead of our own scrape-detection
// time avoids up to 30 min of error from polling cadence alone.
export async function fetchReleaseTimes() {
  const res = await axios.get(RECENT_RELEASES_URL, { headers: HEADERS, timeout: 30000 });
  if (isUpdatingPlaceholder(res.data)) return {};
  const $ = cheerio.load(res.data);

  const releaseTimes = {};
  for (const fields of parsePanels($, $('.list'))) {
    const nameNumber = fields['name number'];
    const dateReleased = fields['date released'];
    if (!nameNumber || !dateReleased || dateReleased === 'In SCORE Custody') continue;
    releaseTimes[nameNumber] = dateReleased;
  }
  return releaseTimes;
}
