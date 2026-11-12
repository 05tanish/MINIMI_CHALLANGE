const MONTHS = 'january february march april may june july august september october november december'.split(' ');
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

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

/** Resolve the most recent past occurrence of a weekday (0=Sun..6=Sat) from `today`. */
function lastWeekday(today, target, forcePast = true) {
  let diff = (today.getUTCDay() - target + 7) % 7;
  if (forcePast && diff === 0) diff = 7;
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

export function extractDateRange(text, now = new Date(), timezone = 'Asia/Kolkata') {
  const q = text.toLowerCase(); const p = dateParts(now, timezone);
  const today = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));

  // yesterday / today
  if (/\byesterday\b/.test(q)) { const d = new Date(today); d.setUTCDate(d.getUTCDate() - 1); return dayRange(d, false, timezone); }
  if (/\btoday\b/.test(q)) return dayRange(today, false, timezone);

  // "on [day] [month]" e.g. "on 3 November" (with optional year)
  const named = q.match(/\bon\s+(\d{1,2})\s+([a-z]+)/);
  if (named && MONTHS.includes(named[2])) {
    const yearMatch = q.match(new RegExp(`${named[2]}\\s+${named[1]}(?:st|nd|rd|th)?[,]?\\s+(20\\d{2})`));
    const month = MONTHS.indexOf(named[2]); const year = yearMatch ? Number(yearMatch[1]) : today.getFullYear();
    const date = new Date(Date.UTC(year, month, Number(named[1])));
    if (!yearMatch && date > today) date.setUTCFullYear(year - 1);
    return dayRange(date, !yearMatch, timezone);
  }

  // "on [weekday]" e.g. "on Monday we shortlisted 5 CRM tools"
  const onWeekday = q.match(/\bon\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (onWeekday) {
    const target = WEEKDAYS.indexOf(onWeekday[1]);
    return dayRange(lastWeekday(today, target), false, timezone);
  }

  // "last [weekday]" e.g. "last Tuesday"
  const weekday = q.match(/last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1]);
    return dayRange(lastWeekday(today, target), false, timezone);
  }

  // "last week" → previous 7 days
  if (/\blast\s+week\b/.test(q)) {
    const start = new Date(today); start.setUTCDate(start.getUTCDate() - 7);
    return { start: zonedMidnight(start, timezone), end: zonedMidnight(today, timezone), ambiguousYear: false };
  }

  // "last month" → previous calendar month
  if (/\blast\s+month\b/.test(q)) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return { start: zonedMidnight(start, timezone), end: zonedMidnight(end, timezone), ambiguousYear: false };
  }

  // "this week" → last 7 days from today
  if (/\bthis\s+week\b/.test(q)) {
    const start = new Date(today); start.setUTCDate(start.getUTCDate() - 7);
    return { start: zonedMidnight(start, timezone), end: zonedMidnight(today, timezone), ambiguousYear: false };
  }

  // "this month" → last 30 days from today
  if (/\bthis\s+month\b/.test(q)) {
    const start = new Date(today); start.setUTCDate(start.getUTCDate() - 30);
    return { start: zonedMidnight(start, timezone), end: zonedMidnight(today, timezone), ambiguousYear: false };
  }

  // "N days ago" e.g. "3 days ago"
  const daysAgo = q.match(/(\d+)\s+days?\s+ago/);
  if (daysAgo) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - Number(daysAgo[1]));
    return dayRange(d, false, timezone);
  }

  // "a week ago"
  if (/\ba\s+week\s+ago\b/.test(q)) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - 7);
    return dayRange(d, false, timezone);
  }

  // "a few days ago" → treat as 3 days
  if (/\ba\s+few\s+days?\s+ago\b/.test(q)) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - 3);
    return dayRange(d, false, timezone);
  }

  // "recently" / "previously" → last 7 days
  if (/\b(recently|previously)\b/.test(q)) {
    const start = new Date(today); start.setUTCDate(start.getUTCDate() - 7);
    return { start: zonedMidnight(start, timezone), end: zonedMidnight(today, timezone), ambiguousYear: false };
  }

  return null;
}

function dayRange(date, ambiguousYear = false, timezone = 'Asia/Kolkata') {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: zonedMidnight(date, timezone), end: zonedMidnight(next, timezone), ambiguousYear };
}
