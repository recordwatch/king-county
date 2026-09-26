import { chromium } from 'playwright';
import { normalizeBookingNumber } from '../lib/bookingNumber.js';

// King County DAJD's public lookup portal -- a Power Pages (Dynamics 365)
// "Entity List". Its grid data comes from POST /_services/entity-grid-data.json
// with an encrypted, session-bound `base64SecureConfiguration` blob that only
// the page's own JavaScript can produce (see CLAUDE.md), so a plain HTTP
// client can't use it. What does work (confirmed 2026-09-26): load the page
// in a real headless browser, capture the grid request the page itself makes,
// then replay it with fetch() from inside that same page, changing only
// page/pageSize/search. The server doesn't cap pageSize (2,500 worked), but
// each record carries ~33KB of metadata, so MAX_PAGE_SIZE keeps any single
// response to ~16MB.
const LOOKUP_URL = 'https://dajd-jms.powerappsportals.us/public/subject-lookup/';
const MAX_PAGE_SIZE = 500;
const MAX_PAGES = 20;
const GRID_DELAY_MS = 1500;
const DETAIL_DELAY_MS = 2000;
const DETAIL_ATTEMPTS = 3;
const SUBGRID_WAIT_MS = 30000;
// Seen once taking longer than 60s to render the grid on first load.
const GRID_RENDER_TIMEOUT_MS = 120000;
// The Subject Details form's id, as carried on every grid row's
// data-entityformid -- read from the page at startup, this is the fallback.
const DEFAULT_ENTITY_FORM_ID = '907105db-ce4d-ea11-a99b-001dd800951b';

export const VIEWS = {
  BOOKED_24H: 'Subjects Booked in Last 24 Hours',
  RELEASED_24H: 'Subjects Released in Last 24 Hours',
  IN_CUSTODY: 'In Custody Subjects',
  PAST_YEAR: 'Subjects in Custody in Past Year',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Dataverse dates arrive as "/Date(1790439510000)/" -- a true UTC epoch.
// Stored as the same marker-less UTC ISO string Socrata uses
// ("2026-09-26T16:18:30.000") so every consumer, including the frontend's
// dates.js, treats both sources' timestamps identically.
export function portalDateToIso(value) {
  const m = String(value ?? '').match(/-?\d+/);
  if (!m) return null;
  const d = new Date(Number(m[0]));
  // Dynamics' "no date" sentinel is 0001-01-01 -- parses fine, means nothing,
  // and must never become a 'county' release time.
  return isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? null : d.toISOString().slice(0, 23);
}

function attrMap(record) {
  const out = {};
  for (const a of record.attrs) out[a.n] = a;
  return out;
}

// String columns arrive with an empty FormattedValue and the text in
// DisplayValue (or Value), so empty strings must fall through, not stop.
const text = a => (a ? (a.f || (typeof a.v === 'string' ? a.v : null) || null) : null);

// One grid row = one subject (person), with columns for their *current*
// booking. Those booking columns are blank once the person is released
// (confirmed: 0 of 12,977 inactive rows carried them).
function parseGridRow(record) {
  const a = attrMap(record);
  return {
    subjectId: record.id,
    ucn: text(a.tri_offenderid),
    name: text(a.name),
    facility: text(a.tri_facilityid),
    agency: text(a.tri_agencyid),
    bookingNumber: normalizeBookingNumber(text(a.tri_name)),
    bookedAt: a.tri_completedon ? portalDateToIso(a.tri_completedon.v) : null,
    active: text(a.statuscode) === 'Active',
  };
}

function parseCourtCase(record) {
  const a = attrMap(record);
  const conditions = record.attrs.find(x => /condition/i.test(x.n));
  return {
    caseNumber: text(a.tri_name),
    court: text(a.tri_courtid),
    bookingNumber: normalizeBookingNumber(text(a.tri_bookingid)),
    bailTotal: text(a.kc_bail_total),
    bailConditions: conditions ? text(conditions) : null,
    caseStatus: text(a.tri_casestatus),
  };
}

function parseCharge(record) {
  const a = attrMap(record);
  return {
    bookingNumber: normalizeBookingNumber(text(a.tri_bookingid)),
    courtCase: text(a.tri_courtcaseid),
    offense: text(a.tri_offenseid),
    bail: text(a.kc_bail_amount),
    chargeStatus: text(a.kc_chargestatusid),
    releaseCode: text(a.kc_dispositionid),
  };
}

function parseBooking(record) {
  const a = attrMap(record);
  return {
    bookingNumber: normalizeBookingNumber(text(a.tri_name)),
    bookingStatus: text(a.tri_bookingstatus),
    arrestedAt: a.tri_arrestdatetime ? portalDateToIso(a.tri_arrestdatetime.v) : null,
    releasedAt: a.kc_releasedate ? portalDateToIso(a.kc_releasedate.v) : null,
  };
}

// The detail form's 3 sub-tables each POST to entity-subgrid-data.json. An
// empty sub-table has no records to read an entity name from, so each
// response is identified by its request's sort expression (confirmed
// 2026-09-26), then cross-checked against the entity name when rows exist.
const SUBGRIDS = [
  { key: 'courtCases', entity: 'tri_courtcase', test: s => /kc_sequence/.test(s), parse: parseCourtCase },
  { key: 'charges', entity: 'tri_charge', test: s => /kc_dispositionid/.test(s), parse: parseCharge },
  { key: 'bookings', entity: 'tri_booking', test: s => /^tri_name\b/.test(s), parse: parseBooking },
];

// Runs inside the browser page: replays a captured grid/sub-grid request
// with a changed body, returning only the slim fields we parse.
async function inPageFetch({ url, token, body }) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', __RequestVerificationToken: token, 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { status: r.status };
  const d = await r.json();
  return {
    status: 200,
    more: !!d.MoreRecords,
    itemCount: d.ItemCount,
    records: (d.Records || []).map(x => ({
      id: x.Id,
      entity: x.EntityName,
      attrs: x.Attributes.map(at => ({ n: at.Name.split('.').pop(), v: at.Value, f: at.FormattedValue || at.DisplayValue || null })),
    })),
  };
}

function launchOptions() {
  // Local/sandbox overrides only -- GitHub Actions uses Playwright's own
  // installed Chromium with no proxy and normal certificate checking.
  const opts = { headless: true };
  if (process.env.PORTAL_CHROMIUM_PATH) opts.executablePath = process.env.PORTAL_CHROMIUM_PATH;
  if (process.env.PORTAL_PROXY) opts.proxy = { server: process.env.PORTAL_PROXY };
  if (process.env.PORTAL_IGNORE_CERT_ERRORS === '1') opts.args = ['--ignore-certificate-errors'];
  return opts;
}

export async function openPortal() {
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const session = new PortalSession(browser, context, page);
  try {
    await session.init();
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}

class PortalSession {
  constructor(browser, context, page) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.viewConfigs = new Map();
    this.lastGridRequest = null;
    this.stats = { gridRequests: 0, detailLoads: 0, detailFailures: 0 };
    page.on('request', req => {
      if (/entity-grid-data\.json/.test(req.url())) {
        try {
          this.lastGridRequest = { url: req.url(), token: req.headers()['__requestverificationtoken'], body: JSON.parse(req.postData() || '{}') };
        } catch {}
      }
    });
  }

  async init() {
    await this.page.goto(LOOKUP_URL, { waitUntil: 'domcontentloaded', timeout: GRID_RENDER_TIMEOUT_MS });
    await this.page.waitForSelector('tr[data-id]', { state: 'attached', timeout: GRID_RENDER_TIMEOUT_MS });
    if (!this.lastGridRequest) throw new Error('portal grid rendered but no grid request was captured');
    this.viewConfigs.set(VIEWS.BOOKED_24H, this.lastGridRequest);
    this.portalId = this.lastGridRequest.url.split('/').pop();
    this.entityFormId = await this.page.evaluate(
      () => document.querySelector('tr[data-id] a.details-link')?.getAttribute('data-entityformid') || null,
    ) || DEFAULT_ENTITY_FORM_ID;
  }

  // Each view has its own encrypted config; the only way to get one is to
  // let the page switch to that view once and capture the request it makes.
  async viewConfig(view) {
    if (this.viewConfigs.has(view)) return this.viewConfigs.get(view);
    this.lastGridRequest = null;
    const found = await this.page.evaluate(v => {
      const a = [...document.querySelectorAll('a[role=menuitem]')].find(x => x.getAttribute('aria-label') === v);
      if (a) a.click();
      return !!a;
    }, view);
    if (!found) throw new Error(`portal view "${view}" not found in the page's view menu`);
    for (let i = 0; i < 120 && !this.lastGridRequest; i++) await sleep(500);
    if (!this.lastGridRequest) throw new Error(`switching to portal view "${view}" never issued a grid request`);
    this.viewConfigs.set(view, this.lastGridRequest);
    await sleep(GRID_DELAY_MS);
    return this.lastGridRequest;
  }

  async gridPage(view, { page = 1, pageSize = MAX_PAGE_SIZE, search = '' } = {}) {
    if (pageSize > MAX_PAGE_SIZE) throw new Error(`pageSize ${pageSize} exceeds the ${MAX_PAGE_SIZE} cap`);
    const cfg = await this.viewConfig(view);
    this.stats.gridRequests++;
    const out = await this.page.evaluate(inPageFetch, { url: cfg.url, token: cfg.token, body: { ...cfg.body, page, pageSize, search } });
    await sleep(GRID_DELAY_MS);
    if (out.status !== 200) throw new Error(`portal grid "${view}" page ${page} returned HTTP ${out.status}`);
    return { rows: out.records.map(parseGridRow), more: out.more, itemCount: out.itemCount };
  }

  async gridAll(view) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.gridPage(view, { page });
      rows.push(...res.rows);
      if (!res.more || res.rows.length === 0) return rows;
    }
    throw new Error(`portal grid "${view}" still reported more records after ${MAX_PAGES} pages of ${MAX_PAGE_SIZE}`);
  }

  async search(view, query) {
    return (await this.gridPage(view, { page: 1, pageSize: 10, search: query })).rows;
  }

  // Loads one subject's detail form and returns its 3 sub-tables, or
  // { ok: false } after DETAIL_ATTEMPTS tries -- the sub-tables are flaky
  // (sometimes none of the 3 requests fire; the same URL works on retry).
  // maxAttempts lets the caller keep retries inside its page-load budget.
  async detail(subjectId, maxAttempts = DETAIL_ATTEMPTS) {
    const url = `https://dajd-jms.powerappsportals.us/_portal/modal-form-template-path/${this.portalId}?id=${subjectId}&entityformid=${this.entityFormId}&languagecode=1033`;
    let lastReason = null;
    for (let attempt = 1; attempt <= Math.min(DETAIL_ATTEMPTS, maxAttempts); attempt++) {
      this.stats.detailLoads++;
      const res = await this.detailOnce(url).catch(err => ({ ok: false, reason: err.message }));
      if (res.ok) {
        await sleep(DETAIL_DELAY_MS);
        return res;
      }
      lastReason = res.reason;
      await sleep(DETAIL_DELAY_MS * attempt * 1.5);
    }
    this.stats.detailFailures++;
    return { ok: false, reason: lastReason };
  }

  async detailOnce(url) {
    const p = await this.context.newPage();
    const pending = [];
    p.on('response', resp => {
      if (!/entity-subgrid-data\.json/.test(resp.url())) return;
      pending.push((async () => {
        const req = resp.request();
        const body = JSON.parse(req.postData() || '{}');
        const cfg = { url: resp.url(), token: req.headers()['__requestverificationtoken'], body };
        if (resp.status() !== 200) return { status: resp.status(), cfg };
        const d = await resp.json();
        return {
          status: 200, cfg,
          data: {
            more: !!d.MoreRecords,
            records: (d.Records || []).map(x => ({
              id: x.Id,
              entity: x.EntityName,
              attrs: x.Attributes.map(at => ({ n: at.Name.split('.').pop(), v: at.Value, f: at.FormattedValue || at.DisplayValue || null })),
            })),
          },
        };
      })());
    });
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let waited = 0; pending.length < SUBGRIDS.length && waited < SUBGRID_WAIT_MS; waited += 500) await sleep(500);
      if (pending.length < SUBGRIDS.length) return { ok: false, reason: `only ${pending.length} of ${SUBGRIDS.length} sub-tables loaded` };
      const responses = (await Promise.allSettled(pending)).map(r => (r.status === 'fulfilled' ? r.value : null));

      const out = {};
      for (const sg of SUBGRIDS) {
        const resp = responses.find(r => r && sg.test(r.cfg.body.sortExpression || ''));
        if (!resp || resp.status !== 200) return { ok: false, reason: `${sg.key} sub-table missing or failed` };
        let records = resp.data.records;
        if (records.some(r => r.entity !== sg.entity)) return { ok: false, reason: `${sg.key} sub-table returned unexpected entity type` };
        // Sub-tables page at 30 rows -- refetch in full when there are more.
        if (resp.data.more) {
          const full = await p.evaluate(inPageFetch, { url: resp.cfg.url, token: resp.cfg.token, body: { ...resp.cfg.body, page: 1, pageSize: 250 } });
          if (full.status !== 200 || full.more) return { ok: false, reason: `${sg.key} sub-table has more rows than could be fetched` };
          records = full.records;
        }
        out[sg.key] = records.map(sg.parse);
      }

      const header = await p.evaluate(() => {
        const val = id => document.getElementById(id)?.value || null;
        const sel = document.getElementById('tri_offenderstatus');
        return {
          name: val('name'),
          ucn: val('tri_offenderid'),
          bailTotal: val('kc_aggregate_bail'),
          subjectStatus: sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : null,
        };
      });
      return { ok: true, header, ...out };
    } finally {
      await p.close().catch(() => {});
    }
  }

  async close() {
    await this.browser.close().catch(() => {});
  }
}
