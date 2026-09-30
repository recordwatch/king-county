export function nowPST() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(new Date());
}

const PACIFIC_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Pacific's UTC offset (ms, negative) at a UTC instant.
function pacificOffset(ms) {
  const p = Object.fromEntries(PACIFIC_PARTS.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// Pacific wall-clock time -> UTC ms, whatever the machine's own TZ is. In the
// repeated hour when DST ends the earlier (PDT) reading is used.
export function pacificToUtc(y, mo, d, h, mi, s) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - pacificOffset(wall);
  const o2 = pacificOffset(t);
  if (o2 !== pacificOffset(wall)) t = wall - o2;
  return t;
}

// A nowPST() string ("09/29/2026, 10:00:59") -> Date, or null if it isn't one.
export function parseNowPST(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, mo, d, y, h, mi, sec] = m.map(Number);
  return new Date(pacificToUtc(y, mo, d, h, mi, sec));
}
