import { Fragment, useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import Header from './Header'
import HBarList from './HBarList'
import { computeStats } from '../statsUtils'
import { SOURCES, sourceLabel, combinedLagNote } from '../sources'

async function fetchAll(filename) {
  const results = await Promise.all(
    SOURCES.map(s => fetch(`./data/${s.id}/${filename}`).then(r => (r.ok ? r.json() : null)).catch(() => null))
  )
  return results
}

async function loadCombinedLog() {
  const perSource = await fetchAll('change_log.json')
  return perSource.flatMap(l => (Array.isArray(l) ? l : []))
}

async function loadStatusBySource() {
  const perSource = await fetchAll('status.json')
  const bySource = {}
  SOURCES.forEach((s, i) => { if (perSource[i]) bySource[s.id] = perSource[i] })
  return bySource
}

const TABS = ['Summary', 'Trends', 'Crime Types', 'Bail & Release', 'Agencies', 'Detention', 'Repeat Bookings']

function fmtMoney(n) {
  if (n === null || n === undefined) return '—'
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function fmtDays(n) {
  if (n === null || n === undefined) return '—'
  return `${n.toFixed(1)}d`
}

function fmtDate(d) {
  if (!d) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function DataMeta({ stats, status }) {
  return (
    <div className="section-note">
      {stats.totals.totalBookings.toLocaleString()} bookings tracked
      {stats.totals.dateRange && <> &nbsp;·&nbsp; {fmtDate(stats.totals.dateRange.min)} – {fmtDate(stats.totals.dateRange.max)}</>}
      <br />
      Data as of: {SOURCES.map(s => `${s.label} ${status?.[s.id]?.lastUpdated || 'no data yet'}`).join(' · ')}
    </div>
  )
}

function StayLengthTable({ stats }) {
  return (
    <div>
      <div className="section-title">Stay Length by Source</div>
      <div className="section-note">
        Only counts releases with a real, source-published release time (labeled "county" internally) — a source
        with no such times published shows no number rather than a guess based on when our scraper noticed the
        person gone. King County DAJD only pulls a rolling 60-day booking window, so stays that began more than 60
        days ago are excluded from this dataset entirely.
      </div>
      <table className="stats-table">
        <thead><tr><th>Source</th><th>n</th><th>Avg</th><th>Median</th></tr></thead>
        <tbody>
          {stats.stayLength.map(row => (
            <Fragment key={row.source}>
              <tr>
                <td>{sourceLabel(row.source)}{row.split && row.n > 0 ? ' — all releases' : ''}</td>
                {row.n === 0 ? (
                  <td colSpan={3}>No published release times</td>
                ) : (
                  <>
                    <td>{row.n}</td>
                    <td>{fmtDays(row.avgDays)}</td>
                    <td>{fmtDays(row.medianDays)}</td>
                  </>
                )}
              </tr>
              {row.split && row.n > 0 && [['excluding transfers', row.split.excludingTransfers], ['transfers only', row.split.transfersOnly]].map(([label, s]) => (
                <tr key={label} className="stats-subrow">
                  <td>&nbsp;&nbsp;{label}</td>
                  <td>{s.n}</td>
                  <td>{fmtDays(s.avgDays)}</td>
                  <td>{fmtDays(s.medianDays)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="section-note">
        A transfer to another agency ends the stay at this jail, but the person stays in custody, so SCORE and King
        County DAJD are also shown with transfers split out, using each source&apos;s published release reason.
        {stats.stayLength.filter(r => r.split?.noReason > 0).map(r => (
          <Fragment key={r.source}>
            {' '}{r.split.noReason} {sourceLabel(r.source)} release{r.split.noReason !== 1 ? 's have' : ' has'} no
            published reason yet (confirmed only by the county&apos;s jail lookup), so {r.split.noReason !== 1 ? 'they are' : 'it is'} counted
            in &quot;all releases&quot; but left out of the two split rows.
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function fmtPct(n) {
  return n === null || n === undefined ? '—' : `${n.toFixed(1)}%`
}

const RELEASE_REASON_NOTE = {
  score: "Based on SCORE releases tracked since September 13, 2026. SCORE's site has older release history, but only for people booked since tracking began, so it isn't used here.",
}

// Published release reasons per source. Each source's own wording is listed
// under its group; sources are never combined.
function ReleaseReasonBlock({ sourceId, data }) {
  if (!data) {
    return (
      <div className="agency-block">
        <div className="agency-name">{sourceLabel(sourceId)}</div>
        <div className="agency-meta">No published release reason</div>
      </div>
    )
  }
  return (
    <div className="agency-block">
      <div className="agency-name">{sourceLabel(sourceId)}</div>
      <div className="agency-meta">
        n = {data.n} releases with a published reason
        {data.dateRange && <> &nbsp;·&nbsp; released {fmtDate(data.dateRange.min)} – {fmtDate(data.dateRange.max)}</>}
      </div>
      {RELEASE_REASON_NOTE[sourceId] && <div className="section-note">{RELEASE_REASON_NOTE[sourceId]}</div>}
      {data.noReason > 0 && <div className="section-note">{data.noReason} other release{data.noReason !== 1 ? 's have' : ' has'} no published reason and {data.noReason !== 1 ? 'are' : 'is'} not counted.</div>}
      {data.multi > 0 && <div className="section-note">{data.multi} release{data.multi !== 1 ? 's list' : ' lists'} two reasons and {data.multi !== 1 ? 'are' : 'is'} counted under both, so the percentages add up to slightly more than 100%.</div>}
      <table className="stats-table">
        <thead><tr><th>How they left</th><th>n</th><th>%</th></tr></thead>
        <tbody>
          {data.groups.map(g => (
            <Fragment key={g.name}>
              <tr>
                <td>{g.name}</td>
                <td>{g.count}</td>
                <td>{fmtPct(g.pct)}</td>
              </tr>
              {g.reasons.map(r => (
                <tr key={r.name} className="stats-subrow">
                  <td>&nbsp;&nbsp;“{r.name}”</td>
                  <td>{r.count}</td>
                  <td></td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReleasedWithBail({ stats }) {
  return (
    <div>
      <div className="section-title">% Released on Bail or Bond</div>
      <div className="section-note">
        Uses each source&apos;s published release reason, not whether bail was set — bail being set doesn&apos;t
        mean the person paid it. SCORE: release type &quot;RELEASED - CASH BAIL OR BOND&quot; from the person&apos;s
        booking list. King County DAJD: county dataset release reasons &quot;Bail&quot; or &quot;Bond&quot; (release on
        personal recognizance is not counted as bail). Kent and Kirkland publish no release reason, so no
        percentage is shown for them.
      </div>
      <table className="stats-table">
        <thead><tr><th>Source</th><th>Method</th><th>Bail/bond</th><th>n</th><th>%</th></tr></thead>
        <tbody>
          {SOURCES.map(s => {
            const d = stats.releaseReasons[s.id]
            return (
              <tr key={s.id}>
                <td>{s.label}</td>
                {d ? (
                  <>
                    <td>Published release reason</td>
                    <td>{d.bail}</td>
                    <td>{d.n}</td>
                    <td>{fmtPct(d.bailPct)}</td>
                  </>
                ) : (
                  <td colSpan={4}>Not available — no published release reason</td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ReleaseReasonsSection({ stats }) {
  return (
    <div>
      <div className="section-title">How People Left Custody</div>
      <div className="section-note">
        From each source&apos;s own published release reason, per source — never combined. Transfers to another
        agency are their own group: the person left this jail but not custody. The jails hold different
        populations, so the sources shouldn&apos;t be compared directly.
      </div>
      {SOURCES.map(s => <ReleaseReasonBlock key={s.id} sourceId={s.id} data={stats.releaseReasons[s.id]} />)}
    </div>
  )
}

function SummaryTab({ stats, status }) {
  const t = stats.totals
  return (
    <div>
      <DataMeta stats={stats} status={status} />
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-card-num">{t.totalBookings}</div>
          <div className="stat-card-label">Total Bookings</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-num">{t.inCustody}</div>
          <div className="stat-card-label">In Custody</div>
          {combinedLagNote() && <div className="stat-card-sub">{combinedLagNote()}</div>}
        </div>
        <div className="stat-card">
          <div className="stat-card-num">{t.released}</div>
          <div className="stat-card-label">Releases Tracked</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-num">{t.avgCharges?.toFixed(1) ?? '—'}</div>
          <div className="stat-card-label">Avg Charges / Booking</div>
          <div className="stat-card-sub">median {t.medianCharges ?? '—'}, max {t.maxCharges}</div>
        </div>
      </div>
      <div className="section-note">
        "In Custody" includes people on electronic home detention and in other non-jail contract facilities, not
        just physical jail beds. The same person can appear in both the Kent and King County DAJD counts at once —
        some Kent-booked people are actually housed at King County's MRJC/KCCF.
      </div>
      <StayLengthTable stats={stats} />
    </div>
  )
}

function TrendsTab({ stats }) {
  return (
    <div>
      <div className="section-title">Bookings by Day of Week</div>
      <div className="section-note">By actual booking timestamp, not when our scraper first saw the entry.</div>
      <HBarList items={stats.trends.byWeekday} />
    </div>
  )
}

function CrimeTypesTab({ stats }) {
  const { categories, severities, topOffenses } = stats.crimeTypes
  return (
    <div>
      <div className="section-title">Crime Categories</div>
      <div className="section-note">Broad category per booking (deduped) — one booking can appear in multiple categories.</div>
      <HBarList items={categories} />

      <div className="section-title">Charge Severity</div>
      <div className="section-note">Best-effort classification per individual charge instance, inferred from charge text (WA statute tiers). Not authoritative.</div>
      <HBarList items={severities} />

      <div className="section-title">Most Common Charges</div>
      <div className="section-note">Raw charge text as booked — not normalized across the 4 sources.</div>
      <HBarList items={topOffenses} />
    </div>
  )
}

function BailSourceBlock({ row }) {
  if (!row.unit) {
    return (
      <div className="agency-block">
        <div className="agency-name">{sourceLabel(row.source)}</div>
        <div className="agency-meta">No bail/bond field published by this source</div>
      </div>
    )
  }
  return (
    <div className="agency-block">
      <div className="agency-name">{sourceLabel(row.source)}</div>
      <div className="agency-meta">Bail counted once per {row.unit} &nbsp;·&nbsp; n = {row.n}</div>
      {row.n === 0 ? (
        <div className="empty">No bail amounts recorded yet.</div>
      ) : (
        <>
          <div className="stats-grid">
            <div className="stat-card"><div className="stat-card-num">{fmtMoney(row.median)}</div><div className="stat-card-label">Median</div></div>
            <div className="stat-card"><div className="stat-card-num">{fmtMoney(Math.round(row.mean || 0))}</div><div className="stat-card-label">Mean</div></div>
            <div className="stat-card"><div className="stat-card-num">{fmtMoney(row.max)}</div><div className="stat-card-label">Max</div></div>
          </div>
          <table className="stats-table">
            <thead><tr><th>Category</th><th>Median</th><th>Mean</th><th>n</th></tr></thead>
            <tbody>
              {row.byCategory.map(c => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td>{fmtMoney(c.median)}</td>
                  <td>{fmtMoney(Math.round(c.mean))}</td>
                  <td>{c.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function BailTab({ stats }) {
  return (
    <div>
      <div className="section-note">
        Bail is never combined across sources — Kirkland's booking-detail page publishes one bond total for the
        whole booking (copied onto every charge in our data), so it's counted once per booking here. SCORE and Kent
        both publish a genuine bail figure per charge, so those are counted per charge. King County DAJD&apos;s county
        dataset has no bail field; bail from the county&apos;s jail lookup is shown on booking cards but isn&apos;t
        counted in the bail amounts below yet.
      </div>
      <ReleasedWithBail stats={stats} />
      <ReleaseReasonsSection stats={stats} />
      <div className="section-title">Bail Amounts</div>
      {stats.bail.map(row => <BailSourceBlock key={row.source} row={row} />)}
    </div>
  )
}

function AgenciesTab({ stats }) {
  return (
    <div>
      <div className="section-note">SCORE publishes an arresting agency on each charge, and King County DAJD publishes one per booking (shown on its booking cards). Only SCORE's per-charge agencies are counted below. Kent and Kirkland don't expose this field.</div>
      <HBarList items={stats.agencies.map(a => ({ name: a.agency, count: a.chargeCount }))} />
      {stats.agencies.map(a => (
        <div className="agency-block" key={a.agency}>
          <div className="agency-name">{a.agency}</div>
          <div className="agency-meta">{a.chargeCount} charge{a.chargeCount !== 1 ? 's' : ''}</div>
          <ul className="agency-top-charges">
            {a.topCharges.map(c => <li key={c.name}>{c.name} — {c.count}</li>)}
          </ul>
        </div>
      ))}
    </div>
  )
}

function DetentionSourceBlock({ sourceId, data }) {
  return (
    <div className="agency-block">
      <div className="agency-name">{sourceLabel(sourceId)}</div>
      {data.n === 0 ? (
        <div className="agency-meta">No published release times</div>
      ) : (
        <>
          <div className="agency-meta">{data.n} county-verified release{data.n !== 1 ? 's' : ''}, ≥2 data points per category shown</div>
          <table className="stats-table">
            <thead><tr><th>Category</th><th>Avg Days</th><th>Median Days</th><th>n</th></tr></thead>
            <tbody>
              {data.rows.map(row => (
                <tr key={row.category}>
                  <td>{row.category}</td>
                  <td>{fmtDays(row.avgDays)}</td>
                  <td>{fmtDays(row.medianDays)}</td>
                  <td>{row.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 && <div className="empty">Not enough released bookings yet to break this down by category.</div>}
        </>
      )}
    </div>
  )
}

function DetentionTab({ stats }) {
  return (
    <div>
      <div className="section-note">
        Detention duration by charge category, per source — never combined across sources (see Stay Length on the
        Summary tab for why). Only releases with a real, source-published release time are counted. Transfers to
        another agency are included (see Stay Length on the Summary tab for figures with transfers split out). King County
        DAJD only pulls a rolling 60-day booking window, so stays that began more than 60 days ago are excluded.
      </div>
      {SOURCES.map(s => <DetentionSourceBlock key={s.id} sourceId={s.id} data={stats.detention[s.id]} />)}
    </div>
  )
}

function RepeatBookingsTab({ stats }) {
  const { repeatRates } = stats
  const available = ['score', 'kent']
  const unavailable = ['kirkland', 'kc_dajd']
  return (
    <div>
      <div className="section-note">
        Definition: had another booking at this same jail in the 12 months before this booking.
        These are within-jail rates — bookings at other jails in this dataset are not counted.
        Kirkland and King County DAJD don't publish booking history data.
      </div>
      {available.map(id => {
        const r = repeatRates[id]
        if (!r) return null
        return (
          <div className="agency-block" key={id}>
            <div className="agency-name">{sourceLabel(id)}</div>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-card-num">{r.rate !== null ? (r.rate * 100).toFixed(1) + '%' : '—'}</div>
                <div className="stat-card-label">Repeat Rate</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-num">{r.included.toLocaleString()}</div>
                <div className="stat-card-label">Bookings in Sample</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-num">{r.repeats.toLocaleString()}</div>
                <div className="stat-card-label">Had Prior Booking</div>
                <div className="stat-card-sub">in preceding 12 mo</div>
              </div>
            </div>
            {r.nullExcluded > 0 && (
              <div className="section-note">{r.nullExcluded} {r.nullExcluded === 1 ? 'entry' : 'entries'} excluded — history not yet fetched.</div>
            )}
            {r.dateRange && (
              <div className="section-note">
                Current-booking date range: {fmtDate(r.dateRange.min)} – {fmtDate(r.dateRange.max)}
              </div>
            )}
          </div>
        )
      })}
      {unavailable.map(id => (
        <div className="agency-block" key={id}>
          <div className="agency-name">{sourceLabel(id)}</div>
          <div className="agency-meta">Not available — this source doesn&apos;t publish booking history.</div>
        </div>
      ))}
    </div>
  )
}

export default function StatsPage() {
  const [log, setLog] = useState(null)
  const [status, setStatus] = useState(null)
  const [tab, setTab] = useState('Summary')

  useEffect(() => {
    Promise.all([loadCombinedLog(), loadStatusBySource()]).then(([logData, statusData]) => {
      setLog(logData)
      setStatus(statusData)
    })
  }, [])

  const stats = useMemo(() => (log ? computeStats(log) : null), [log])

  return (
    <div className="app">
      <Header />
      <div className="controls">
        <Link to="/" className="back-link">← Main Page</Link>
      </div>
      {!stats ? (
        <div className="loading">Crunching numbers...</div>
      ) : (
        <>
          <div className="stats-tabs">
            {TABS.map(t => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          <div className="stats-panel">
            {tab === 'Summary' && <SummaryTab stats={stats} status={status} />}
            {tab === 'Trends' && <TrendsTab stats={stats} />}
            {tab === 'Crime Types' && <CrimeTypesTab stats={stats} />}
            {tab === 'Bail & Release' && <BailTab stats={stats} />}
            {tab === 'Agencies' && <AgenciesTab stats={stats} />}
            {tab === 'Detention' && <DetentionTab stats={stats} />}
            {tab === 'Repeat Bookings' && <RepeatBookingsTab stats={stats} />}
          </div>
        </>
      )}
    </div>
  )
}
