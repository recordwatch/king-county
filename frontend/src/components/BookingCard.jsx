import { useState } from 'react'
import { sourceLabel, entryLagNote } from '../sources'
import { parseEntryDate, displayEntryDate } from '../dates'

function calcTimeHeld(source, start, end) {
  if (!start || !end) return null
  const ms = parseEntryDate(source, end) - parseEntryDate(source, start)
  if (ms <= 0) return null
  const totalMins = Math.floor(ms / 60000)
  const days  = Math.floor(totalMins / 1440)
  const hours = Math.floor((totalMins % 1440) / 60)
  const mins  = totalMins % 60
  if (days > 0)  return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

// Sources whose bookingHistory is shown on the card, and how far back each
// source's own site goes.
const HISTORY_NOTE = {
  kc_dajd: "As far back as the county's site shows, usually about the past year",
  score: "As far back as SCORE's site shows",
}

// SCORE sometimes lists one booking number on several rows, one per release
// type, with the same dates (65 such groups on 2026-09-27, none with
// differing dates). Shown as one row per booking with every release type;
// the stored data stays as SCORE publishes it.
function mergeHistoryRows(rows) {
  const byNumber = new Map()
  for (const b of rows) {
    const m = byNumber.get(b.bookingNumber)
    if (!m) {
      byNumber.set(b.bookingNumber, { ...b, releaseTypes: b.releaseType ? [b.releaseType] : [] })
      continue
    }
    for (const k of ['dateBooked', 'dateArrested', 'dateReleased']) m[k] = m[k] || b[k]
    if (b.releaseType && !m.releaseTypes.includes(b.releaseType)) m.releaseTypes.push(b.releaseType)
  }
  return [...byNumber.values()]
}

function ChargeRow({ c }) {
  return (
    <div className="charge-row">
      <div className="charge-violation">{c.charge || 'Charge pending'}</div>
      {c.court && (
        <div className="charge-court">{c.court}{c.causeNumber && ` — Cause #${c.causeNumber}`}</div>
      )}
      {c.rcw && <div className="charge-rcw">RCW/ORD: {c.rcw}</div>}
      {c.warrant && <div className="charge-warrant">Warrant/Citation: {c.warrant}</div>}
      {c.arrestAgency && <div className="charge-agency">Arresting agency: {c.arrestAgency}</div>}
      {c.bail && <div className="charge-bail">Bail: {c.bail}{c.bondType && ` (${c.bondType})`}</div>}
      {c.disposition && (
        <div className="charge-disposition">Disposition: {c.disposition}{c.dispositionDate && ` — ${c.dispositionDate}`}</div>
      )}
    </div>
  )
}

export default function BookingCard({ entry }) {
  const [open, setOpen] = useState(false)

  const isReleased = entry.status === 'released'
  const rawTimeHeld = isReleased ? calcTimeHeld(entry.source, entry.bookingDate || entry.firstSeen, entry.releasedAt) : null
  // Only a "county" releaseSource is a real, source-published release time --
  // 'detected' (our own disappearance-based guess) and 'unverified'
  // (Kirkland's own real-date column, not independently confirmed) are
  // approximate, so the duration built from them is labeled as such.
  const timeHeld = rawTimeHeld && entry.releaseSource !== 'county' ? `about ${rawTimeHeld}` : rawTimeHeld
  const lagNote = entryLagNote(entry)
  const history = HISTORY_NOTE[entry.source] && entry.bookingHistory ? mergeHistoryRows(entry.bookingHistory) : []

  return (
    <div className={`card ${isReleased ? 'card-released' : 'card-custody'}`}>
      <div className="card-header" onClick={() => setOpen(!open)}>
        <div className="card-left">
          <div className="card-name">
            {entry.name}
            <span className="source-badge">{sourceLabel(entry.source)}</span>
          </div>
          <div className="card-meta">
            {/* Issaquah publishes no booking number, only a per-person number. */}
            {entry.bookingNumber ? `Booking #${entry.bookingNumber}` : entry.personNumber ? `Person #${entry.personNumber}` : 'No booking number'} &nbsp;·&nbsp; Booked: {displayEntryDate(entry.source, entry.bookingDate || entry.firstSeen)}
            {entry.facility && <span> &nbsp;·&nbsp; {entry.facility}</span>}
            {timeHeld && <span className="card-time-held"> &nbsp;·&nbsp; Held: {timeHeld}</span>}
          </div>
          {lagNote && <div className="card-lag-note">{lagNote}</div>}
        </div>
        <div className="card-right">
          <span className={`badge ${isReleased ? 'badge-released' : 'badge-custody'}`}>
            {isReleased ? 'Released' : 'In Custody'}
          </span>
          <span className="card-toggle">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div className="card-body">
          {isReleased && entry.releasedAt && (
            <div className="card-release-row">
              Released: {displayEntryDate(entry.source, entry.releasedAt)}{timeHeld && <span className="card-time-held-detail"> &nbsp;·&nbsp; Time held: {timeHeld}</span>}
            </div>
          )}

          {entry.docMatch && (
            <div className="card-doc-match">
              Now in WA DOC custody — {entry.docMatch.facility} (DOC #{entry.docMatch.docNumber})
            </div>
          )}

          {!isReleased && entry.scheduledReleaseDate && (
            <div className="card-release-row">
              Scheduled release: {entry.scheduledReleaseDate}
            </div>
          )}

          {/* Booking-level fields (KC DAJD, from the DAJD portal; Kent's
              totalBail). SCORE's agency is per charge, shown in ChargeRow. */}
          {(entry.arrestingAgency || entry.totalBail) && (
            <div className="card-release-row">
              {entry.arrestingAgency && <span>Arresting agency: {entry.arrestingAgency}</span>}
              {entry.arrestingAgency && entry.totalBail && <span> &nbsp;·&nbsp; </span>}
              {entry.totalBail && <span>Total bail: {entry.totalBail}</span>}
            </div>
          )}

          {entry.charges && entry.charges.length > 0 ? (
            <div className="card-charges">
              <div className="charges-title">Charges ({entry.charges.length})</div>
              {entry.charges.map((c, i) => <ChargeRow key={i} c={c} />)}
            </div>
          ) : (
            <div className="card-charges">
              <div className="charges-title">Charges</div>
              <div className="charge-row charge-pending">
                Not yet available — check back shortly.
              </div>
            </div>
          )}

          {entry.priorBookings && entry.priorBookings.length > 0 && (
            <div className="card-history">
              <div className="charges-title">Booking History ({entry.priorBookings.length} prior)</div>
              {entry.priorBookings.map((b, i) => (
                <div key={i} className="prior-booking">
                  <div className="prior-booking-header">
                    Booking #{b.bookingNumber} &nbsp;·&nbsp; Booked: {b.bookedDate}
                    {b.releasedDate && <span> &nbsp;·&nbsp; Released: {b.releasedDate}</span>}
                  </div>
                  {b.charges.map((c, j) => <ChargeRow key={j} c={c} />)}
                </div>
              ))}
            </div>
          )}

          {/* SCORE's and KC DAJD's bookingHistory. KC's always lists the
              current booking; SCORE's usually doesn't until the person is
              released, so the heading checks. KC's rows carry an arrest time
              and booking status; SCORE's a booked time and release type. */}
          {history.length > 0 && (
            <div className="card-history">
              <div className="charges-title">
                Booking History ({history.length}{history.some(b => b.bookingNumber === entry.bookingNumber) ? ', including this one' : ' prior'})
              </div>
              <div className="card-history-note">{HISTORY_NOTE[entry.source]}</div>
              {history.map((b, i) => (
                <div key={i} className="prior-booking">
                  <div className="prior-booking-header">
                    Booking #{b.bookingNumber}
                    {b.dateBooked && <span> &nbsp;·&nbsp; Booked: {b.dateBooked}</span>}
                    {b.dateArrested && <span> &nbsp;·&nbsp; Arrested: {displayEntryDate(entry.source, b.dateArrested)}</span>}
                    {b.dateReleased
                      ? <span> &nbsp;·&nbsp; Released: {displayEntryDate(entry.source, b.dateReleased)}</span>
                      : b.bookingStatus === 'Booked' && <span> &nbsp;·&nbsp; Still booked</span>}
                    {b.releaseTypes.length > 0 && <span> &nbsp;·&nbsp; {b.releaseTypes.join(' / ')}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
