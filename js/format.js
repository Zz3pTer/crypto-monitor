// Number and time formatting. Every time is Malaysia time (FR-TIME-01..03),
// whatever the viewer's device time zone is.

export const TZ = "Asia/Kuala_Lumpur";

const fmtCache = new Map();
function parts(d, opts) {
  const key = JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", ...opts }));
  return Object.fromEntries(fmtCache.get(key).formatToParts(d).map((p) => [p.type, p.value]));
}

// "11 Nov 2026, 08:10 MYT"
export function dateTime(d) {
  const p = parts(new Date(d), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} MYT`;
}

// "23:24:05 MYT"
export function clock(d) {
  const p = parts(new Date(d), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${p.hour}:${p.minute}:${p.second} MYT`;
}

// "11 Nov 2026"
export function date(d) {
  const p = parts(new Date(d), { day: "numeric", month: "short", year: "numeric" });
  return `${p.day} ${p.month} ${p.year}`;
}

// MYT wall-clock fields, for calculations.
export function mytFields(d = new Date()) {
  const p = parts(new Date(d), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return { hh: +p.hour, mm: +p.minute, iso: `${p.year}-${p.month}-${p.day}` };
}

// Same rules as python/telegram_notifier.fmt_price: $104,820 / $3,912.55 / $2.418 / $0.2214
export function price(p) {
  if (p === null || p === undefined || Number.isNaN(p)) return "—";
  const f = (min, max) => p.toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
  if (p >= 10000) return `$${f(0, 0)}`;
  if (p >= 10) return `$${f(2, 2)}`;
  if (p >= 1) return `$${f(3, 3)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(8).replace(/0+$/, "")}`;
}

export function pct(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}

export function signed(n) {
  return `${n > 0 ? "+" : ""}${n}`;
}

export function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
