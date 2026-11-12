const MONTHS = 'january february march april may june july august september october november december'.split(' ');
function dateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
function zonedMidnight(date, timezone) {
  const parts = { year: date.getUTCFullYear(), month: String(date.getUTCMonth() + 1).padStart(2, '0'), day: String(date.getUTCDate()).padStart(2, '0') };
  const target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let candidate = target;
  for (let i = 0; i < 2; i += 1) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    candidate -= represented - target;
  }
  return new Date(candidate);
}
export function extractDateRange(text, now = new Date(), timezone = 'Asia/Kolkata') {
  const q = text.toLowerCase(); const p = dateParts(now, timezone);
  const today = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  if (/\byesterday\b/.test(q)) { const d = new Date(today); d.setUTCDate(d.getUTCDate() - 1); return dayRange(d, false, timezone); }
  if (/\btoday\b/.test(q)) return dayRange(today, false, timezone);
  const named = q.match(/\bon\s+(\d{1,2})\s+([a-z]+)/);
  if (named && MONTHS.includes(named[2])) {
    const yearMatch = q.match(new RegExp(`${named[2]}\\s+${named[1]}(?:st|nd|rd|th)?[,]?\\s+(20\\d{2})`));
    const month = MONTHS.indexOf(named[2]); const year = yearMatch ? Number(yearMatch[1]) : today.getFullYear();
    const date = new Date(Date.UTC(year, month, Number(named[1])));
    if (!yearMatch && date > today) date.setUTCFullYear(year - 1);
    return dayRange(date, !yearMatch, timezone);
  }
  const weekday = q.match(/last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (weekday) {
    const target = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(weekday[1]);
    let diff = (today.getUTCDay() - target + 7) % 7; if (diff === 0) diff = 7;
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - diff); return dayRange(d, false, timezone);
  }
  return null;
}
function dayRange(date, ambiguousYear = false, timezone = 'Asia/Kolkata') { const next = new Date(date); next.setUTCDate(next.getUTCDate() + 1); return { start: zonedMidnight(date, timezone), end: zonedMidnight(next, timezone), ambiguousYear }; }
