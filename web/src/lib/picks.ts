import type { Tx } from "../api";
import type { CatIndex } from "./categories";
import { counterpartyKey } from "./text";

export interface Pick {
  categoryId: number;
  /** How often this category was used for the same counterparty; 0 for general suggestions. */
  here: number;
}

/**
 * Categories to offer for a transaction: first the ones already used for the same counterparty
 * (most often first), then the most used categories overall for money going the same way.
 */
export function quickPicks(tx: Tx, history: Tx[], cats: CatIndex, n = 5): Pick[] {
  const key = counterpartyKey(tx);
  const here = new Map<number, number>();
  const overall = new Map<number, number>();
  for (const h of history) {
    if (h.id === tx.id || h.splits.length === 0 || Math.sign(h.amount) !== Math.sign(tx.amount)) continue;
    const same = key !== "" && counterpartyKey(h) === key;
    for (const s of h.splits) {
      if (!cats.byId.has(s.categoryId)) continue;
      overall.set(s.categoryId, (overall.get(s.categoryId) ?? 0) + 1);
      if (same) here.set(s.categoryId, (here.get(s.categoryId) ?? 0) + 1);
    }
  }
  const picks: Pick[] = [...here].sort((a, b) => b[1] - a[1]).map(([categoryId, count]) => ({ categoryId, here: count }));
  const taken = new Set(picks.map((p) => p.categoryId));
  for (const [categoryId] of [...overall].sort((a, b) => b[1] - a[1])) {
    if (picks.length >= n) break;
    if (!taken.has(categoryId)) picks.push({ categoryId, here: 0 });
  }
  // Fresh install: no history yet, offer leaf categories of the matching kind.
  const kind = tx.amount < 0 ? "expense" : "income";
  for (const c of cats.ordered) {
    if (picks.length >= n) break;
    const isLeaf = !cats.ordered.some((o) => o.parentId === c.id);
    if (isLeaf && c.kind === kind && !picks.some((p) => p.categoryId === c.id)) picks.push({ categoryId: c.id, here: 0 });
  }
  return picks.slice(0, n);
}
