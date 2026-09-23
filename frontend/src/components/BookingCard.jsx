import { useState } from 'react'
import { sourceLabel } from '../sources'

function calcTimeHeld(start, end) {
  if (!start || !end) return null
  const ms = new Date(end) - new Date(start)
  if (ms <= 0) return null
  const totalMins = Math.floor(ms / 60000)
  const days  = Math.floor(totalMins / 1440)
  const hours = Math.floor((totalMins % 1440) / 60)
  const mins  = totalMins % 60
  if (days > 0)  return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
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
  const timeHeld = isReleased ? calcTimeHeld(entry.bookingDate || entry.firstSeen, entry.releasedAt) : null

  return (
    <div className={`card ${isReleased ? 'card-released' : 'card-custody'}`}>
      <div className="card-header" onClick={() => setOpen(!open)}>
        <div className="card-left">
          <div className="card-name">
            {entry.name}
            <span className="source-badge">{sourceLabel(entry.source)}</span>
          </div>
          <div className="card-meta">
            Booking #{entry.bookingNumber} &nbsp;·&nbsp; Booked: {entry.bookingDate || entry.firstSeen}
            {entry.facility && <span> &nbsp;·&nbsp; {entry.facility}</span>}
            {timeHeld && <span className="card-time-held"> &nbsp;·&nbsp; Held: {timeHeld}</span>}
          </div>
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
              Released: {entry.releasedAt}{timeHeld && <span className="card-time-held-detail"> &nbsp;·&nbsp; Time held: {timeHeld}</span>}
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
        </div>
      )}
    </div>
  )
}
