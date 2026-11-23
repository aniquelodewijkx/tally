// Money is always integer cents; dates are ISO "YYYY-MM-DD" strings; months are "YYYY-MM" keys.

export const MINUS = "−";
const nf2 = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });

/** "−1.019,66", or "+29,00" with `plus`. */
export function money(cents: number, opts: { plus?: boolean } = {}): string {
  const sign = cents < 0 ? MINUS : opts.plus && cents > 0 ? "+" : "";
  return sign + nf2.format(Math.abs(cents) / 100);
}

/** Whole euros without sign: "1.292". */
export function euros(cents: number): string {
  return nf0.format(Math.round(cents / 100));
}

/** Parses what someone types in an amount field ("19,50", "19.50", "1.019,66", "€ 8") into cents. */
export function parseMoney(input: string): number | null {
  let s = input.replace(/[\s€+]/g, "").replace(MINUS, "-");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function currentMonth(): string {
  return todayIso().slice(0, 7);
}

export function isMonthKey(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function addMonths(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthRange(key: string): { from: string; to: string } {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${key}-01`, to: `${key}-${pad(last)}` };
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

const asDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "November 2026" */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

/** "Wednesday 19 November" */
export function dayLabel(iso: string): string {
  return asDate(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

/** "16 Nov" */
export function shortDate(iso: string): string {
  return asDate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "Saturday 15 Nov 2026" */
export function longDate(iso: string): string {
  return asDate(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
}

export function daysBetween(a: string, b: string): number {
  return Math.round((asDate(b).getTime() - asDate(a).getTime()) / 86_400_000);
}
