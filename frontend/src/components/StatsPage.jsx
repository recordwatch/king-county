import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import Header from './Header'
import HBarList from './HBarList'
import { computeStats } from '../statsUtils'
import { SOURCES, sourceLabel } from '../sources'

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
            <tr key={row.source}>
              <td>{sourceLabel(row.source)}</td>
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
          ))}
        </tbody>
      </table>
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
        both publish a genuine bail figure per charge, so those are counted per charge. King County DAJD's feed has
        no bail/bond field at all.
      </div>
      {stats.bail.map(row => <BailSourceBlock key={row.source} row={row} />)}
    </div>
  )
}

function AgenciesTab({ stats }) {
  return (
    <div>
      <div className="section-note">Only SCORE publishes an arresting agency on its charges — Kent, Kirkland, and King County DAJD don't expose this field, so they aren't represented below.</div>
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
        Summary tab for why). Only releases with a real, source-published release time are counted. King County
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
