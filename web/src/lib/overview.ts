import type { Total, Tx } from "../api";
import { OTHER_COLOR, SERIES_COLORS, UNCATEGORIZED_COLOR, type CatIndex, type CatInfo } from "./categories";
import { addMonths } from "./format";

// Turns CategoryTotals rows into what the overview shows. Pure functions, so they're unit-tested.

export interface Amounts {
  amount: number;
  spent: number;
  received: number;
}

const zero = (): Amounts => ({ amount: 0, spent: 0, received: 0 });
const add = (a: Amounts, t: Amounts) => {
  a.amount += t.amount;
  a.spent += t.spent;
  a.received += t.received;
};

export interface CategoryRow extends Amounts {
  cat: CatInfo;
  prev: number;
  children: CategoryRow[];
}

export interface MonthModel {
  income: number;
  /** Negative: expense categories plus uncategorized money going out. */
  spent: number;
  saved: number;
  uncategorizedOut: number;
  uncategorizedIn: number;
  expenses: CategoryRow[];
  incomes: CategoryRow[];
  bar: { label: string; color: string; amount: number }[];
}

const ym = (key: string) => key.split("-").map(Number) as [number, number];

export function monthModel(totals: Total[], cats: CatIndex, month: string): MonthModel {
  const [y, m] = ym(month);
  const [py, pm] = ym(addMonths(month, -1));
  const own = new Map<number, Amounts>();
  const prevOwn = new Map<number, number>();
  let uncategorizedOut = 0;
  let uncategorizedIn = 0;
  for (const t of totals) {
    const isCur = t.year === y && t.month === m;
    const isPrev = t.year === py && t.month === pm;
    if (t.categoryId == null) {
      if (isCur && t.bucket === "out") uncategorizedOut += t.amount;
      if (isCur && t.bucket === "in") uncategorizedIn += t.amount;
      continue;
    }
    if (!cats.byId.has(t.categoryId)) continue;
    if (isCur) add(own.get(t.categoryId) ?? own.set(t.categoryId, zero()).get(t.categoryId)!, t);
    if (isPrev) prevOwn.set(t.categoryId, (prevOwn.get(t.categoryId) ?? 0) + t.amount);
  }

  const rows: CategoryRow[] = [];
  for (const top of cats.tops) {
    const family = cats.family.get(top.id)!;
    const row: CategoryRow = { cat: top, ...zero(), prev: 0, children: [] };
    for (const id of family) {
      const a = own.get(id);
      if (a) add(row, a);
      row.prev += prevOwn.get(id) ?? 0;
      if (id !== top.id && (a || prevOwn.has(id))) {
        row.children.push({ cat: cats.byId.get(id)!, ...(a ?? zero()), prev: prevOwn.get(id) ?? 0, children: [] });
      }
    }
    if (row.amount !== 0 || row.prev !== 0) rows.push(row);
  }
  const byAmount = (a: CategoryRow, b: CategoryRow) => a.amount - b.amount;
  for (const r of rows) r.children.sort(byAmount);
  const expenses = rows.filter((r) => r.cat.kind === "expense").sort(byAmount);
  const incomes = rows.filter((r) => r.cat.kind === "income").sort((a, b) => b.amount - a.amount);

  const income = incomes.reduce((s, r) => s + r.amount, 0);
  const spent = expenses.reduce((s, r) => s + r.amount, 0) + uncategorizedOut;

  const bar: MonthModel["bar"] = [];
  for (const r of expenses) {
    if (r.amount < 0) bar.push({ label: r.cat.name, color: r.cat.series, amount: -r.amount });
  }
  if (uncategorizedOut < 0) bar.push({ label: "Uncategorized", color: UNCATEGORIZED_COLOR, amount: -uncategorizedOut });

  return { income, spent, saved: income + spent + uncategorizedIn, uncategorizedOut, uncategorizedIn, expenses, incomes, bar };
}

/** Change in spending vs the previous month, as shown in the pill. */
export function spendDelta(cur: number, prev: number): { label: string; tone: "up" | "down" | "flat" } | null {
  const now = -cur;
  const before = -prev;
  if (before <= 0) return now > 0 ? { label: "new", tone: "flat" } : null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { label: "±0%", tone: "flat" };
  return pct > 0 ? { label: `+${pct}%`, tone: "up" } : { label: `−${-pct}%`, tone: "down" };
}

export interface Series {
  key: string;
  name: string;
  color: string;
  /** Spending per month, January first, in cents (positive = money spent). */
  data: number[];
}

export interface YearModel {
  series: Series[];
  income: number;
  spent: number;
  saved: number;
}

export function yearModel(totals: Total[], cats: CatIndex, year: number): YearModel {
  const series: Series[] = cats.expenseTops.map((c) => ({ key: `c${c.id}`, name: c.name, color: c.series, data: Array(12).fill(0) }));
  const uncategorized: Series = { key: "uncategorized", name: "Uncategorized", color: UNCATEGORIZED_COLOR, data: Array(12).fill(0) };
  let income = 0;
  let saved = 0;
  for (const t of totals) {
    if (t.year !== year) continue;
    saved += t.amount;
    const m = t.month - 1;
    if (t.categoryId == null) {
      if (t.bucket === "out") uncategorized.data[m] += -t.amount;
      continue;
    }
    const cat = cats.byId.get(t.categoryId);
    if (!cat) continue;
    if (cat.kind === "income") {
      income += t.amount;
      continue;
    }
    const slot = series.findIndex((s) => s.key === `c${cat.topId}`);
    if (slot >= 0) series[slot].data[m] += -t.amount;
  }
  const all = [...series, uncategorized].filter((s) => s.data.some((v) => v !== 0));
  const spent = -all.reduce((s, x) => s + x.data.reduce((a, b) => a + b, 0), 0);
  return { series: all, income, spent, saved };
}

/**
 * How many months a year's averages divide by: from the first month with any money in or out
 * (the first import, for a year that started before it) up to `lastMonth`, the last month that
 * has begun. Dividing by every month since January would make a year imported from June look
 * half as expensive.
 */
export function monthsCovered(totals: Total[], year: number, lastMonth: number): number {
  const months = totals.filter((t) => t.year === year && (t.amount !== 0 || t.spent !== 0 || t.received !== 0)).map((t) => t.month - 1);
  if (months.length === 0 || lastMonth < 0) return 0;
  return Math.max(0, lastMonth - Math.min(...months) + 1);
}

/**
 * One top-level expense category's spending per month, split over its direct subcategories
 * (deeper ones count toward theirs), each its own series colored in tree order (gray past the
 * palette, never merged). Money booked on the category itself is "No subcategory".
 */
export function subcategorySeries(totals: Total[], cats: CatIndex, year: number, topId: number): Series[] {
  const top = cats.byId.get(topId);
  if (!top) return [];
  const byChild = new Map<number, number[]>();
  const direct: number[] = Array(12).fill(0);
  for (const t of totals) {
    if (t.year !== year || t.categoryId == null) continue;
    let cat = cats.byId.get(t.categoryId);
    if (!cat || cat.topId !== topId || cat.kind !== "expense") continue;
    while (cat.parentId != null && cat.parentId !== topId) cat = cats.byId.get(cat.parentId)!;
    let data = direct;
    if (cat.id !== topId) {
      data = byChild.get(cat.id) ?? Array(12).fill(0);
      byChild.set(cat.id, data);
    }
    data[t.month - 1] += -t.amount;
  }
  const children = [...byChild].filter(([, d]) => d.some((v) => v !== 0));
  const treeIndex = new Map(cats.ordered.map((c, i) => [c.id, i]));
  const series: Series[] = children
    .sort((a, b) => treeIndex.get(a[0])! - treeIndex.get(b[0])!)
    .map(([id, data], i) => ({ key: `c${id}`, name: cats.byId.get(id)!.name, color: SERIES_COLORS[i] ?? OTHER_COLOR, data }));
  if (direct.some((v) => v !== 0)) {
    series.push(
      children.length > 0
        ? { key: "self", name: "No subcategory", color: UNCATEGORIZED_COLOR, data: direct }
        : { key: "self", name: top.name, color: top.series, data: direct },
    );
  }
  return series;
}

export interface TransferLine {
  /** Null for transfers between accounts you import (or to an account you don't track). */
  potId: number | null;
  /** Between accounts: the money moved (positive). For a pot: net moved into it (negative if more came out). */
  amount: number;
}

/** What the overview leaves out: transfers, split by where they went. Pots first by amount, then the rest. */
export function transferBreakdown(txs: Tx[]): TransferLine[] {
  let between = 0;
  const pots = new Map<number, number>();
  for (const t of txs) {
    if (t.linkKind !== "transfer") continue;
    if (t.linkCounterAccountId != null) pots.set(t.linkCounterAccountId, (pots.get(t.linkCounterAccountId) ?? 0) - t.amount);
    else if (t.amount < 0) between -= t.amount;
  }
  const lines: TransferLine[] = [...pots].map(([potId, amount]) => ({ potId, amount })).sort((a, b) => b.amount - a.amount);
  if (between > 0) lines.push({ potId: null, amount: between });
  return lines;
}
