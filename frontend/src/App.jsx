import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Link } from 'react-router-dom'
import Header from './components/Header'
import StatBar from './components/StatBar'
import BookingCard from './components/BookingCard'
import HistoryLog from './components/HistoryLog'
import StatsPage from './components/StatsPage'
import { SOURCES } from './sources'

// Each source is scraped independently into its own data/<id>/ directory —
// merge them here rather than in scrape.js so a slow/failed source never
// blocks writing the others (see lib/runScraper.js).
async function fetchAll(filename) {
  const results = await Promise.all(
    SOURCES.map(s =>
      fetch(`./data/${s.id}/${filename}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
    )
  )
  return results
}

// WA DOC cross-reference results (lib/crossReferenceDOC.js) -- only
// unambiguous, receiving-unit matches are worth surfacing; see that file
// for the full matching policy.
async function loadDOCMatches() {
  try {
    const res = await fetch('./data/wadoc/matches.json')
    return res.ok ? await res.json() : {}
  } catch {
    return {}
  }
}

async function loadCombinedLog() {
  const [perSource, docMatches] = await Promise.all([fetchAll('change_log.json'), loadDOCMatches()])
  const log = perSource.flatMap(l => Array.isArray(l) ? l : [])
  return log.map(entry => {
    const m = docMatches[entry.source]?.[entry.idnum]
    return m && m.found && !m.ambiguous ? { ...entry, docMatch: m } : entry
  })
}

async function loadCombinedStatus() {
  const perSource = await fetchAll('status.json')
  const bySource = {}
  let inCustody = 0
  SOURCES.forEach((s, i) => {
    const st = perSource[i]
    if (st) {
      bySource[s.id] = st
      inCustody += st.inCustody || 0
    }
  })
  return { inCustody, bySource }
}

function getDateLabel(entry, field = 'firstSeen') {
  const raw = entry[field] || entry.bookingDate || ''
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw.split(',')[0].trim()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${month}/${day}/${d.getFullYear()}`
}

function BookingLog({ entries, grouped = false, groupBy = 'firstSeen' }) {
  if (entries.length === 0) {
    return <div className="empty">No records match your search.</div>
  }

  if (!grouped) {
    return (
      <div className="log">
        <div className="log-count">{entries.length} record{entries.length !== 1 ? 's' : ''}</div>
        {entries.map(entry => (
          <BookingCard key={`${entry.source}:${entry.idnum}`} entry={entry} />
        ))}
      </div>
    )
  }

  const groups = []
  const seen = {}
  for (const entry of entries) {
    const date = getDateLabel(entry, groupBy)
    if (!seen[date]) {
      seen[date] = []
      groups.push({ date, entries: seen[date] })
    }
    seen[date].push(entry)
  }

  return (
    <div className="log">
      <div className="log-count">{entries.length} record{entries.length !== 1 ? 's' : ''}</div>
      {groups.map(({ date, entries: group }) => (
        <div key={date}>
          <div className="date-separator">{date}</div>
          {group.map(entry => (
            <BookingCard key={`${entry.source}:${entry.idnum}`} entry={entry} />
          ))}
        </div>
      ))}
    </div>
  )
}

function SourceFilter({ value, onChange }) {
  return (
    <select className="source-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="all">All Sources</option>
      {SOURCES.map(s => (
        <option key={s.id} value={s.id}>{s.label}</option>
      ))}
    </select>
  )
}

function applyFilters(log, search, source) {
  return log.filter(e =>
    (source === 'all' || e.source === source) &&
    e.name?.toLowerCase().includes(search.toLowerCase())
  )
}

function InCustodyPage() {
  const [log, setLog] = useState([])
  const [status, setStatus] = useState(null)
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([loadCombinedLog(), loadCombinedStatus()]).then(([logData, statusData]) => {
      const inCustody = logData
        .filter(e => e.status === 'in_custody')
        .sort((a, b) => new Date(b.bookingDate) - new Date(a.bookingDate))
      setLog(inCustody)
      setStatus(statusData)
      setLoading(false)
    })
  }, [])

  const filtered = applyFilters(log, search, source)

  return (
    <div className="app">
      <Header />
      {status && <StatBar status={status} />}
      <div className="controls">
        <input
          type="text"
          placeholder="Search by name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="search-input"
        />
        <SourceFilter value={source} onChange={setSource} />
        <div className="filter-tabs">
          <Link to="/" className="active">In Custody</Link>
          <Link to="/released">Released</Link>
          <Link to="/history">History</Link>
        </div>
      </div>
      {loading ? <div className="loading">Loading records...</div> : <BookingLog entries={filtered} grouped groupBy="bookingDate" />}
    </div>
  )
}

function ReleasedPage() {
  const [log, setLog] = useState([])
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadCombinedLog().then(logData => {
      const released = logData
        .filter(e => e.status === 'released')
        .sort((a, b) => new Date(b.releasedAt) - new Date(a.releasedAt))
      setLog(released)
      setLoading(false)
    })
  }, [])

  const filtered = applyFilters(log, search, source)

  return (
    <div className="app">
      <Header />
      <div className="controls">
        <input
          type="text"
          placeholder="Search by name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="search-input"
        />
        <SourceFilter value={source} onChange={setSource} />
        <div className="filter-tabs">
          <Link to="/">In Custody</Link>
          <Link to="/released" className="active">Released</Link>
          <Link to="/history">History</Link>
        </div>
      </div>
      {loading ? <div className="loading">Loading records...</div> : <BookingLog entries={filtered} grouped groupBy="releasedAt" />}
    </div>
  )
}

function HistoryPage() {
  const [log, setLog] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadCombinedLog().then(logData => {
      setLog(logData)
      setLoading(false)
    })
  }, [])

  return (
    <div className="app">
      <Header />
      <div className="controls">
        <div className="filter-tabs">
          <Link to="/">In Custody</Link>
          <Link to="/released">Released</Link>
          <Link to="/history" className="active">History</Link>
        </div>
      </div>
      {loading ? <div className="loading">Loading records...</div> : <HistoryLog entries={log} />}
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<InCustodyPage />} />
        <Route path="/released" element={<ReleasedPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/stats" element={<StatsPage />} />
      </Routes>
    </HashRouter>
  )
}
