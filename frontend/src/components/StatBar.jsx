import { SOURCES, combinedLagNote } from '../sources'

export default function StatBar({ status }) {
  return (
    <div className="statbar">
      <div className="statbar-top">
        <div className="stat">
          <div className="stat-num">{status.inCustody}</div>
          <div className="stat-label">Currently in custody (all sources)</div>
          {combinedLagNote() && <div className="stat-label stat-lag-note">{combinedLagNote()}</div>}
        </div>
      </div>
      <div className="statbar-sources">
        {SOURCES.map(s => {
          const src = status.bySource?.[s.id]
          return (
            <div className="source-stat" key={s.id}>
              <span className="source-stat-label">{s.label}</span>
              <span className="source-stat-num">{src ? src.inCustody : '—'}</span>
              <span className="source-stat-cadence">{src ? src.lastUpdated : 'no data yet'}</span>
              {s.lagNote && <span className="source-stat-cadence source-stat-lag">{s.lagNote}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
