import { useState } from "react";

import { api, type Tx } from "../api";
import { money, parseMoney, shortDate } from "../lib/format";
import { txTitle } from "../lib/text";
import { useAction, useCats } from "../queries";
import { CategoryPicker } from "../ui/CategoryPicker";
import { CategoryIcon } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";

type Row = { categoryId: number | null; text: string };

/** Splits a transaction across categories. The last row takes whatever remains, so it always adds up. */
export function SplitSheet({ tx, onClose }: { tx: Tx; onClose: () => void }) {
  const cats = useCats();
  const total = Math.abs(tx.amount);
  const sign = tx.amount < 0 ? -1 : 1;
  const [rows, setRows] = useState<Row[]>(() =>
    tx.splits.length > 1
      ? tx.splits.map((s) => ({ categoryId: s.categoryId, text: money(Math.abs(s.amount)) }))
      : [{ categoryId: tx.splits[0]?.categoryId ?? null, text: "" }, { categoryId: null, text: "" }],
  );
  const parsed = rows.slice(0, -1).map((r) => parseMoney(r.text));
  const remaining = total - parsed.reduce<number>((s, v) => s + (v ?? 0), 0);
  const ids = rows.map((r) => r.categoryId);
  const problem =
    ids.some((id) => id == null) ? "Choose a category for every row."
    : new Set(ids).size !== ids.length ? "Each category can only be used once."
    : parsed.some((v) => v == null || v <= 0) ? "Enter an amount for every row but the last."
    : remaining <= 0 ? "The amounts add up to more than the transaction."
    : null;

  const save = useAction(
    () =>
      api.setSplits(
        tx.id,
        rows.map((r, i) => ({ categoryId: r.categoryId!, amount: sign * (i === rows.length - 1 ? remaining : parsed[i]!) })),
      ),
    { success: "Split saved", onSuccess: onClose },
  );
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (!cats) return null;
  return (
    <Sheet
      title="Split Transaction"
      subtitle={`${txTitle(tx)} · ${money(tx.amount)} · ${shortDate(tx.date)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!!problem || save.isPending} onClick={() => save.mutate([])}>Save Split</button>
        </>
      }
    >
      {rows.map((r, i) => {
        const cat = r.categoryId != null ? cats.byId.get(r.categoryId) : undefined;
        const last = i === rows.length - 1;
        return (
          <div className="srow" key={i}>
            <CategoryPicker cats={cats} onPick={(id) => update(i, { categoryId: id })} defaultKind={tx.amount < 0 ? "expense" : "income"}>
              <button type="button" className="field grow-1 picker-trigger">
                {cat ? <><CategoryIcon cat={cat} size="sm" />{cat.path}</> : <span className="placeholder">Choose category</span>}
              </button>
            </CategoryPicker>
            {last ? (
              <div className="field money num" aria-label="Remaining amount">{money(Math.max(remaining, 0))}</div>
            ) : (
              <input
                className="field money num"
                inputMode="decimal"
                aria-label={`Amount for row ${i + 1}`}
                placeholder="0,00"
                value={r.text}
                onChange={(e) => update(i, { text: e.target.value })}
              />
            )}
            {rows.length > 2 && (
              <button type="button" className="icon-btn" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                <Icon name="x" />
              </button>
            )}
          </div>
        );
      })}
      <div className="remaining">
        <button type="button" className="btn plain" onClick={() => setRows((rs) => [...rs.slice(0, -1), { categoryId: null, text: "" }, rs[rs.length - 1]])}>
          <Icon name="plus" />Add Category
        </button>
        <span className={problem ? "error-text" : ""}>{problem ?? `Adds up to ${money(total)}`}</span>
      </div>
    </Sheet>
  );
}
