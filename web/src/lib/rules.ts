import type { Rule } from "../api";
import type { CatIndex } from "./categories";

export interface RuleGroup {
  key: string;
  /** The top-level category's name, or the pot's name for transfer rules. */
  title: string;
  /** The top-level category (null for a pot group). */
  categoryId: number | null;
  potId: number | null;
  rules: Rule[];
  labels: number;
}

/**
 * Rules grouped by what they do: top-level categories in the order of the category tree, then pots
 * by name. Within a group, by subcategory in tree order, then pattern (smaller ranges first).
 * `query` keeps rules whose pattern or category path (or pot name) contains it.
 */
export function groupRules(rules: Rule[], cats: CatIndex, potName: (id: number) => string, query = ""): RuleGroup[] {
  const q = query.trim().toLowerCase();
  const treeIndex = new Map(cats.ordered.map((c, i) => [c.id, i]));
  const groups = new Map<string, RuleGroup & { rank: number }>();
  for (const r of rules) {
    const cat = r.categoryId != null ? cats.byId.get(r.categoryId) : undefined;
    const top = cat ? cats.byId.get(cat.topId) : undefined;
    const isPot = r.potId != null;
    const key = isPot ? `pot-${r.potId}` : `cat-${top?.id ?? "unknown"}`;
    const title = isPot ? potName(r.potId!) || "Pot" : top?.name ?? "Unknown category";
    const haystack = isPot ? title : cat?.path ?? title;
    if (q && !r.pattern.includes(q) && !haystack.toLowerCase().includes(q)) continue;
    let g = groups.get(key);
    if (!g) {
      const rank = isPot ? 1_000_000 : top ? (treeIndex.get(top.id) ?? 2_000_000) : 2_000_000;
      g = { key, title, categoryId: top?.id ?? null, potId: r.potId, rules: [], labels: 0, rank };
      groups.set(key, g);
    }
    g.rules.push(r);
    g.labels += r.labels;
  }
  const place = (r: Rule) => (r.categoryId != null ? (treeIndex.get(r.categoryId) ?? 0) : 0);
  const order = (a: Rule, b: Rule) =>
    place(a) - place(b) ||
    a.pattern.localeCompare(b.pattern) ||
    (a.minAmount ?? 0) - (b.minAmount ?? 0) ||
    (a.maxAmount ?? Infinity) - (b.maxAmount ?? Infinity);
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
    .map(({ rank: _rank, ...g }) => ({ ...g, rules: g.rules.sort(order) }));
}

/** A rule's subcategory relative to its group, e.g. "Healthcare" under "Fixed costs"; null at the top. */
export function subcategoryLabel(rule: Rule, cats: CatIndex): string | null {
  const cat = rule.categoryId != null ? cats.byId.get(rule.categoryId) : undefined;
  if (!cat || cat.depth === 0) return null;
  return cat.path.split(" › ").slice(1).join(" › ");
}
