// The database returns local wall-clock times (Atlas's timezone) as
// "2026-09-22T15:04:00" in clock_in_local / clock_out_local. We format those
// strings directly so the phone's own timezone never shifts a shift.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(local) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

export function fmtTime(local) {
  const p = parts(local);
  if (!p) return '—';
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
}

export function fmtDay(dateStr) {
  // dateStr "2026-09-22"
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${MONTHS[m - 1]} ${d}`;
}

export function fmtShortDate(dateStr) {
  const [, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

export function isNextDay(inLocal, outLocal) {
  return Boolean(inLocal && outLocal && String(inLocal).slice(0, 10) !== String(outLocal).slice(0, 10));
}

export function fmtHours(h) {
  if (h == null) return '—';
  return Number(h).toFixed(2);
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
