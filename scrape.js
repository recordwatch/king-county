import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runScrape } from './lib/runScraper.js';
import { runCrossReference } from './lib/crossReferenceDOC.js';
import { runPortal } from './lib/runPortal.js';
import { nowPST, parseNowPST } from './utils.js';
import * as kcdajd from './scrapers/kcdajd.js';
import * as score from './scrapers/score.js';
import * as kent from './scrapers/kent.js';
import * as kirkland from './scrapers/kirkland.js';
import * as issaquah from './scrapers/issaquah.js';
import * as wadoc from './scrapers/wadoc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

// A live source that can't be reached is only a warning while its last
// successful update is under this many hours old; after that the run fails.
// SCORE's rebuild windows and short outages at SCORE and NORCOM (Kirkland) --
// 90 minutes on 2026-09-29 -- would otherwise turn every run red for
// something that fixes itself, while a source down for hours still does.
// Only the live sources get it: KC DAJD's status.json is also
// refreshed by the portal every 2 hours, so its lastUpdated doesn't say
// whether the daily Socrata sync worked.
const LIVE_FAILURE_GRACE_HOURS = 2;
// A source that answered but only with an old copy (Issaquah's CDN, see
// scrapers/issaquah.js) gets longer: nothing is wrong with the data, it's
// just not updating, and that cache can stay stuck for hours (21 red runs
// on 2026-10-03/04). A real outage at the same source still gets 2 hours.
const STALE_COPY_GRACE_HOURS = 6;

const SOURCES = {
  score: {
    sourceId: 'score',
    failureGraceHours: LIVE_FAILURE_GRACE_HOURS,
    label: 'SCORE',
    dataDir: path.join(DATA_DIR, 'score'),
    fetchRoster: score.scrapeRoster,
    fetchDetailBatch: score.scrapeDetailBatch,
    detailBatchLimit: 40,
    backfillBatch: 50,
    fetchReleaseTimes: score.fetchReleaseTimes,
    recheckDetected: score.recheckDetectedReleases,
    // Sized comfortably above the current ~80-record backlog so it clears in
    // one run; recheckDetectedReleases spaces individual requests out so
    // this doesn't turn into a burst against SCORE.
    recheckBatch: 150,
  },
  kent: {
    sourceId: 'kent',
    failureGraceHours: LIVE_FAILURE_GRACE_HOURS,
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
    failureGraceHours: LIVE_FAILURE_GRACE_HOURS,
    label: 'Kirkland',
    dataDir: path.join(DATA_DIR, 'kirkland'),
    fetchRoster: kirkland.scrapeRoster,
    fetchDetailBatch: kirkland.scrapeDetailBatch,
    detailBatchLimit: 20,
    backfillBatch: 30,
  },
  issaquah: {
    sourceId: 'issaquah',
    failureGraceHours: LIVE_FAILURE_GRACE_HOURS,
    staleGraceHours: STALE_COPY_GRACE_HOURS,
    label: 'Issaquah',
    dataDir: path.join(DATA_DIR, 'issaquah'),
    // Charges are inline on the roster page -- no detail fetch. Releases has
    // no times, only confirms a release (see scrapers/issaquah.js).
    fetchRoster: issaquah.scrapeRoster,
    fetchReleaseTimes: issaquah.fetchReleaseTimes,
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
  const keys = arg === 'all' ? ['score', 'kent', 'kirkland', 'issaquah'] : arg.split(',');

  if (keys.includes('wadoc')) {
    await runWADOC();
    return;
  }

  // KC DAJD's live lookup portal (Playwright) -- keeps data/kc_dajd's custody
  // status current between Socrata's 1-2-week republishes. See
  // lib/runPortal.js. PORTAL_DRY_RUN=true writes to PORTAL_OUT_DIR instead of
  // data/; PORTAL_PRIORITY (comma-separated booking numbers) only reorders
  // the detail queue.
  if (keys.includes('kcportal')) {
    await runPortal({
      dataDir: path.join(DATA_DIR, 'kc_dajd'),
      dryRun: process.env.PORTAL_DRY_RUN === 'true',
      outDir: process.env.PORTAL_OUT_DIR || null,
      priority: (process.env.PORTAL_PRIORITY || '').split(',').filter(Boolean),
      forceFullCheck: process.env.PORTAL_FORCE_FULL_CHECK === 'true',
    });
    return;
  }

  for (const key of keys) {
    const config = SOURCES[key];
    if (!config) {
      console.error(`Unknown source "${key}". Valid: ${Object.keys(SOURCES).join(', ')}, kcportal, wadoc, all`);
      process.exitCode = 1;
      continue;
    }
    const result = await runScrape(config);
    if (result?.failed) reportFailure(config, result);
  }
}

// GitHub Actions annotations: ::warning:: shows on the run page without
// failing it; ::error:: plus a non-zero exit fails it.
export function failureVerdict(config, result, now = new Date()) {
  const where = `${config.label}: ${result.message}`;
  // A safety abort means the data looks wrong, not that the site was down --
  // someone has to decide whether to override it, so it never waits.
  if (result.failed === 'safety' || !config.failureGraceHours) return { level: 'error', text: where };
  let lastUpdated = null;
  try {
    lastUpdated = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'status.json'), 'utf-8')).lastUpdated;
  } catch {}
  const last = parseNowPST(lastUpdated);
  if (!last) return { level: 'error', text: `${where} (no previous successful update on record)` };
  const hours = (now - last) / 3600000;
  const since = `last successful update ${hours.toFixed(1)}h ago (${lastUpdated} Pacific)`;
  const grace = result.failed === 'stale' && config.staleGraceHours ? config.staleGraceHours : config.failureGraceHours;
  if (hours <= grace) {
    return { level: 'warning', text: `${where} -- ${since}; not failing the run until it's been over ${grace}h` };
  }
  return { level: 'error', text: `${where} -- ${since}, over the ${grace}h limit` };
}

function reportFailure(config, result) {
  const v = failureVerdict(config, result);
  console.log(`::${v.level} title=${config.label} scrape failed::${v.text}`);
  if (v.level === 'error') process.exitCode = 1;
}

// Only when run as `node scrape.js ...`, so tests can import failureVerdict.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
