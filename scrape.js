import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runScrape } from './lib/runScraper.js';
import * as kcdajd from './scrapers/kcdajd.js';
import * as score from './scrapers/score.js';
import * as kent from './scrapers/kent.js';
import * as kirkland from './scrapers/kirkland.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const SOURCES = {
  score: {
    sourceId: 'score',
    label: 'SCORE',
    dataDir: path.join(DATA_DIR, 'score'),
    fetchRoster: score.scrapeRoster,
    // No detail fetch — SCORE's public portal doesn't publish charges at all.
  },
  kent: {
    sourceId: 'kent',
    label: 'Kent',
    dataDir: path.join(DATA_DIR, 'kent'),
    fetchRoster: kent.scrapeRoster,
    // Charges come back inline with the roster — no separate detail fetch.
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

async function main() {
  const arg = process.argv[2] || 'all';
  const keys = arg === 'all' ? ['score', 'kent', 'kirkland'] : arg.split(',');

  for (const key of keys) {
    const config = SOURCES[key];
    if (!config) {
      console.error(`Unknown source "${key}". Valid: ${Object.keys(SOURCES).join(', ')}, all`);
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
