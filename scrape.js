import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runScrape } from './lib/runScraper.js';
import { runCrossReference } from './lib/crossReferenceDOC.js';
import { nowPST } from './utils.js';
import * as kcdajd from './scrapers/kcdajd.js';
import * as score from './scrapers/score.js';
import * as kent from './scrapers/kent.js';
import * as kirkland from './scrapers/kirkland.js';
import * as wadoc from './scrapers/wadoc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const SOURCES = {
  score: {
    sourceId: 'score',
    label: 'SCORE',
    dataDir: path.join(DATA_DIR, 'score'),
    fetchRoster: score.scrapeRoster,
    fetchDetailBatch: score.scrapeDetailBatch,
    detailBatchLimit: 40,
    backfillBatch: 50,
    fetchReleaseTimes: score.fetchReleaseTimes,
  },
  kent: {
    sourceId: 'kent',
    label: 'Kent',
    dataDir: path.join(DATA_DIR, 'kent'),
    fetchRoster: kent.scrapeRoster,
    // Inline roster charges are a fallback; the History endpoint gives a
    // full per-charge breakdown (RCW/court/bail) plus prior-booking history.
    fetchDetailBatch: kent.scrapeDetailBatch,
    detailBatchLimit: 30,
    backfillBatch: 40,
  },
  kirkland: {
    sourceId: 'kirkland',
    label: 'Kirkland',
    dataDir: path.join(DATA_DIR, 'kirkland'),
    fetchRoster: kirkland.scrapeRoster,
    fetchDetailBatch: kirkland.scrapeDetailBatch,
    detailBatchLimit: 20,
    backfillBatch: 30,
  },
  kcdajd: {
    sourceId: 'kc_dajd',
    label: 'King County DAJD',
    dataDir: path.join(DATA_DIR, 'kc_dajd'),
    fetchRoster: kcdajd.scrapeRoster,
    explicitStatus: true,
  },
};

// WA DOC isn't a live roster to diff -- it's a reference dataset (full
// statewide incarcerated population) used to cross-reference county
// releases and catch jail-to-prison transfers. See lib/crossReferenceDOC.js.
async function runWADOC() {
  const dataDir = path.join(DATA_DIR, 'wadoc');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  console.log(`[${nowPST()}] Running WA DOC scrape...`);
  const roster = await wadoc.scrapeRoster();
  if (roster.length === 0) {
    console.log('  Got 0 records — skipping to avoid wiping data.');
    return;
  }

  fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify(roster));
  fs.writeFileSync(path.join(dataDir, 'status.json'), JSON.stringify({
    source: 'wadoc', totalInmates: roster.length, lastUpdated: nowPST(),
  }));
  console.log(`  Fetched ${roster.length} statewide DOC records.`);

  const { checkedCount, foundCount } = runCrossReference(roster, DATA_DIR);
  console.log(`[${nowPST()}] WA DOC cross-reference done. ${checkedCount} release(s) checked, ${foundCount} match(es) found.`);
}

async function main() {
  const arg = process.argv[2] || 'all';
  const keys = arg === 'all' ? ['score', 'kent', 'kirkland'] : arg.split(',');

  if (keys.includes('wadoc')) {
    await runWADOC();
    return;
  }

  for (const key of keys) {
    const config = SOURCES[key];
    if (!config) {
      console.error(`Unknown source "${key}". Valid: ${Object.keys(SOURCES).join(', ')}, wadoc, all`);
      process.exitCode = 1;
      continue;
    }
    await runScrape(config);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
