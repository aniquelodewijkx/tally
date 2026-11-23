import { api, type Tx } from "../api";
import { isUncategorized, type CatIndex } from "../lib/categories";
import { money, shortDate } from "../lib/format";
import { suggestPattern, txTitle } from "../lib/text";
import { useAction } from "../queries";
import { CategoryPicker } from "../ui/CategoryPicker";
import { Icon } from "../ui/Icon";
import { PotMenu } from "../ui/TransferMenu";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const outcome = (verb: string, r: { updated: number; skipped: number }, why: string) =>
  `${verb} ${r.updated}${r.skipped ? ` · ${r.skipped} skipped (${why})` : ""}`;

/**
 * Actions on several selected transactions at once: categorize, mark as transfers to a pot, link
 * them as paid back or as one transfer, or clear their category.
 */
export function BulkPanel({
  txs,
  cats,
  onClear,
  onDone,
  propose,
}: {
  txs: Tx[];
  cats: CatIndex;
  onClear: () => void;
  /** After an action: ends the selection. */
  onDone: () => void;
  /** Offers a rule when every selected transaction has the same name. */
  propose: (tx: Tx, target: { categoryId: number } | { potId: number }) => void;
}) {
  const ids = txs.map((t) => t.id);
  const out = txs.filter((t) => t.amount < 0);
  const inc = txs.filter((t) => t.amount > 0);
  const total = txs.reduce((n, t) => n + t.amount, 0);
  const dates = txs.map((t) => t.date).sort();
  const linked = txs.filter((t) => t.linkKind != null);
  const uncategorized = txs.filter((t) => t.linkKind == null && isUncategorized(t));
  const categorized = txs.filter((t) => t.splits.length > 0);
  // A rule is only offered when the selection is clearly "the same thing": one name, one direction.
  const sameName = new Set(txs.map(suggestPattern)).size === 1 && (out.length === 0 || inc.length === 0) ? txs[0] : undefined;

  const categorize = useAction(api.setCategory, {
    success: (r) => outcome("Labelled", r, "transfers"),
    onSuccess: () => onDone(),
  });
  const transfer = useAction(api.markTransfers, {
    success: (r) => outcome("Marked as transfer:", r, "already linked"),
    onSuccess: () => onDone(),
  });
  const group = useAction(api.createGroup, { success: "Linked", onSuccess: () => onDone() });

  const unlinked = linked.length === 0;
  const canPayBack = unlinked && out.length >= 1 && inc.length >= 1;
  const [a, b] = txs;
  const canTransfer = unlinked && txs.length === 2 && a.amount + b.amount === 0 && a.accountId !== b.accountId;
  const biggestExpense = [...out].sort((x, y) => x.amount - y.amount)[0];

  return (
    <aside className="insp bulk" aria-label="Selected transactions">
      <button className="icon-btn insp-close" aria-label="Deselect all" onClick={onClear}><Icon name="x" /></button>
      <div className="insp-head">
        <span className="bulk-count">{txs.length}</span>
        <div className="nm">{txs.length === 1 ? "transaction selected" : "transactions selected"}</div>
        <div className="big num">{money(total, { plus: true })}</div>
        <div className="meta">
          {dates[0] === dates.at(-1) ? shortDate(dates[0]) : `${shortDate(dates[0])} – ${shortDate(dates.at(-1)!)}`}
          {out.length > 0 && inc.length > 0 && ` · ${out.length} out, ${inc.length} in`}
        </div>
        <div className="meta">
          {[
            uncategorized.length && `${uncategorized.length} uncategorized`,
            linked.length && `${linked.length} linked`,
          ].filter(Boolean).join(" · ")}
        </div>
      </div>

      <section>
        <div className="glabel">Label</div>
        <div className="group">
          <CategoryPicker
            cats={cats}
            defaultKind={inc.length > out.length ? "income" : "expense"}
            onPick={(id) => categorize.mutate([ids, id], { onSuccess: () => sameName && propose(sameName, { categoryId: id }) })}
          >
            <button className="grow action" disabled={categorize.isPending}>
              <Icon name="tag" /><span className="grow-1">Categorize {plural(txs.length, "Transaction")}…</span><Icon name="right" className="chev" />
            </button>
          </CategoryPicker>
          <PotMenu
            heading="Where did the money go or come from?"
            direction={inc.length === 0 ? "To" : out.length === 0 ? "From" : "To or from"}
            excludeAccountIds={[...new Set(txs.map((t) => t.accountId))]}
            onChoose={(potId) => transfer.mutate([ids, potId], { onSuccess: () => potId != null && sameName && propose(sameName, { potId }) })}
          >
            <button className="grow action" disabled={transfer.isPending}>
              <Icon name="swap" /><span className="grow-1">Mark as Transfers</span><Icon name="right" className="chev" />
            </button>
          </PotMenu>
          {categorized.length > 0 && (
            <button className="grow action danger" disabled={categorize.isPending} onClick={() => categorize.mutate([ids, null])}>
              <Icon name="x" />Clear Category{categorized.length < txs.length ? ` (${categorized.length})` : ""}
            </button>
          )}
        </div>
        <div className="gfoot">Transfers can't have a category; they are skipped.</div>
      </section>

      {(canPayBack || canTransfer) && (
        <section>
          <div className="glabel">Link</div>
          <div className="group">
            {canPayBack && (
              <button className="grow action" onClick={() => group.mutate(["reimbursement", txTitle(biggestExpense), ids])}>
                <Icon name="back" /><span className="grow-1">Link as Paid Back</span>
              </button>
            )}
            {canTransfer && (
              <button className="grow action" onClick={() => group.mutate(["transfer", null, ids])}>
                <Icon name="swap" /><span className="grow-1">Link as One Transfer</span>
              </button>
            )}
          </div>
          <div className="gfoot">
            {canPayBack
              ? `The incoming payments pay back ${out.length === 1 ? txTitle(biggestExpense) : "these expenses"}; your share is ${money(total)}.`
              : "Money moved between two of your accounts."}
          </div>
        </section>
      )}

      <button className="btn bulk-clear" onClick={onClear}>Deselect All</button>
    </aside>
  );
}
