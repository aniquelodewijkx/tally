import { useEffect, useMemo, useRef, useState } from "react";

import { api, type Tx } from "../api";
import { addDays, money, shortDate } from "../lib/format";
import { txSubtitle, txTitle } from "../lib/text";
import { useAction, useCats, useTransactions } from "../queries";
import { Amount } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";

const WINDOW_DAYS = 21;
/** How much "Show earlier" / "Show later" widens the window. */
const STEP_DAYS = 30;

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Links reimbursements to expenses. From an expense: tick the incoming payments, starting with the
 * three weeks after it. From a payment: tick the expenses it pays back, starting with the three
 * weeks before. The window widens a month at a time, and typing searches every month. From a
 * transaction that is already linked, the sheet edits its group.
 */
export function LinkSheet({ tx, onClose }: { tx: Tx; onClose: () => void }) {
  const fromExpense = tx.amount < 0;
  const [earlier, setEarlier] = useState(0);
  const [later, setLater] = useState(0);
  const range = fromExpense
    ? { from: addDays(tx.date, -earlier), to: addDays(tx.date, WINDOW_DAYS + later) }
    : { from: addDays(tx.date, -WINDOW_DAYS - earlier), to: addDays(tx.date, later) };
  const [filter, setFilter] = useState("");
  const query = useDebounced(filter.trim());
  const searching = query.length > 0;
  const nearby = useTransactions(range, !searching);
  const found = useTransactions({ search: query }, searching);
  const listed = (searching ? found : nearby).data ?? [];
  const inGroup = tx.linkKind === "reimbursement" && tx.groupId != null;
  const membersQuery = useTransactions({ groupId: tx.groupId ?? undefined }, inGroup);
  const members = membersQuery.data ?? [];
  // From a transaction that is already linked, the sheet edits the group: the group's members on
  // the other side (its payments, or from a payment its expenses) start ticked.
  const editing = inGroup;
  const otherSide = (t: Tx) => (fromExpense ? t.amount > 0 : t.amount < 0);
  const linkedOthers = members.filter(otherSide);
  // Selected transactions are kept whole, so they stay picked while searching or widening the window.
  const [selected, setSelected] = useState<Map<number, Tx>>(new Map());
  const seeded = useRef(false);
  useEffect(() => {
    if (!editing || seeded.current || !membersQuery.data) return;
    seeded.current = true;
    setSelected(new Map(membersQuery.data.filter((m) => (fromExpense ? m.amount > 0 : m.amount < 0)).map((m) => [m.id, m])));
  }, [editing, membersQuery.data, fromExpense]);
  const [title, setTitle] = useState(tx.linkTitle ?? (fromExpense ? txTitle(tx) : ""));
  const cats = useCats();
  const categoryOf = (t: Tx) =>
    t.splits.length === 0 ? "Uncategorized" : t.splits.map((s) => cats?.byId.get(s.categoryId)?.name ?? "?").join(" + ");

  const candidates = useMemo(() => {
    // Payments linked to another expense can be picked too (they move here); transfers can't.
    const fits = (c: Tx) =>
      c.id !== tx.id && (fromExpense ? c.amount > 0 && c.linkKind !== "transfer" : c.amount < 0 && c.linkKind !== "transfer");
    const byId = new Map(listed.filter(fits).map((c) => [c.id, c]));
    for (const [id, c] of selected) if (!byId.has(id)) byId.set(id, c);
    // What's picked stays on top, so it's visible while searching or after widening the window.
    const picked = (c: Tx) => (selected.has(c.id) ? 0 : 1);
    return [...byId.values()].sort(
      (a, b) => picked(a) - picked(b) || (fromExpense ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)),
    );
  }, [listed, selected, fromExpense, tx.id]);

  // Several on either side: payments back for one expense, or one payment covering several expenses.
  const toggle = (c: Tx) =>
    setSelected((s) => {
      const next = new Map(s);
      next.has(c.id) ? next.delete(c.id) : next.set(c.id, c);
      return next;
    });

  // Linked transactions share the expense's category (the server enforces it); say which one.
  const pathsOf = (txs: Tx[]) =>
    [...new Set(txs.flatMap((t) => t.splits.map((s) => s.categoryId)))].map((id) => cats?.byId.get(id)?.path ?? "?");
  const picked = [...selected.values()];
  const ownSide = inGroup ? members.filter((m) => !otherSide(m)) : [tx];
  const expenseSide = fromExpense ? ownSide : picked;
  const paymentSide = fromExpense ? picked : ownSide;
  const expenseCats = pathsOf(expenseSide);
  const paymentCats = pathsOf(paymentSide);
  const payments = paymentSide.length === 1 ? (fromExpense ? "The payment" : "This payment") : fromExpense ? "The payments" : "These payments";
  const expenses = expenseSide.length === 1 ? "the expense" : "the expenses";
  // From an unlinked payment, picking an expense that is already linked joins its link.
  const joins = !editing && !fromExpense ? picked.find((c) => c.linkKind === "reimbursement" && c.groupId != null) : undefined;
  const target = editing ? tx.groupId : joins?.groupId;
  const moving = picked.filter((c) => c.linkKind === "reimbursement" && c.groupId !== target).length;
  const added = picked.filter((c) => !linkedOthers.some((m) => m.id === c.id)).length;
  const removed = editing ? linkedOthers.filter((m) => !selected.has(m.id)).length : 0;
  const categoryOutcome =
    selected.size === 0
      ? null
      : expenseCats.length > 0
        ? `${payments} will be labelled ${expenseCats.join(" + ")}, like ${expenses}.`
        : paymentCats.length > 0
          ? `${expenses[0].toUpperCase()}${expenses.slice(1)} will be labelled ${paymentCats.join(" + ")}, like ${payments.toLowerCase()}.`
          : "No category yet. Once the expense has one, the payments get it too.";
  const movingNote = moving
    ? ` ${moving} ${fromExpense ? (moving === 1 ? "payment moves" : "payments move") : moving === 1 ? "expense moves" : "expenses move"} here from another link.`
    : "";
  const joinNote = joins ? ` Joins the link "${joins.linkTitle ?? txTitle(joins)}".` : "";
  const outcome = categoryOutcome && `${categoryOutcome}${joinNote}${movingNote}`;

  const sum = (txs: Tx[]) => txs.reduce((n, t) => n + t.amount, 0);
  const share = sum(expenseSide) + sum(paymentSide);
  const linkNote = (c: Tx) =>
    c.linkKind !== "reimbursement" ? null : c.groupId === tx.groupId ? "linked here" : `linked to ${c.linkTitle ?? "another expense"}`;
  const year = tx.date.slice(0, 4);
  const dateLabel = (iso: string) => (iso.slice(0, 4) === year ? shortDate(iso) : `${shortDate(iso)} ${iso.slice(0, 4)}`);

  const save = useAction(
    async () => {
      const ids = [...selected.keys()];
      if (editing) {
        const current = linkedOthers.map((m) => m.id);
        if (ids.length === 0) await api.deleteGroup(tx.groupId!);
        else await api.updateGroupMembers(tx.groupId!, ids.filter((id) => !current.includes(id)), current.filter((id) => !selected.has(id)));
      } else if (fromExpense) {
        await api.createGroup("reimbursement", title.trim() || null, [tx.id, ...ids]);
      } else if (joins) {
        await api.updateGroupMembers(joins.groupId!, [tx.id, ...picked.filter((c) => c.groupId !== joins.groupId).map((c) => c.id)], []);
      } else {
        const biggest = [...picked].sort((a, b) => a.amount - b.amount)[0];
        await api.createGroup("reimbursement", title.trim() || txTitle(biggest), [...ids, tx.id]);
      }
    },
    { success: editing && selected.size === 0 ? "Unlinked" : editing ? "Links updated" : "Linked", onSuccess: onClose },
  );

  const what = fromExpense ? "incoming payments" : "expenses";
  const earlierBtn = !searching && (
    <button type="button" className="cand-more" onClick={() => setEarlier((d) => d + STEP_DAYS)}>
      <Icon name="left" />Show earlier · from {dateLabel(addDays(range.from, -STEP_DAYS))}
    </button>
  );
  const laterBtn = !searching && (
    <button type="button" className="cand-more" onClick={() => setLater((d) => d + STEP_DAYS)}>
      Show later · until {dateLabel(addDays(range.to, STEP_DAYS))}<Icon name="right" />
    </button>
  );

  return (
    <Sheet
      title={fromExpense ? "Link Payments Back" : "Link to Expenses"}
      subtitle={`${txTitle(tx)} · ${money(tx.amount)} · ${shortDate(tx.date)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {editing ? (
            <button className="btn primary" disabled={(added === 0 && removed === 0) || save.isPending} onClick={() => save.mutate([])}>
              {selected.size === 0 ? "Unlink All" : "Save"}
            </button>
          ) : (
            <button className="btn primary" disabled={selected.size === 0 || save.isPending} onClick={() => save.mutate([])}>
              {`Link ${selected.size || ""} ${fromExpense ? "Payment" : "Expense"}${selected.size === 1 ? "" : "s"}`}
            </button>
          )}
        </>
      }
    >
      <div className="field with-icon">
        <Icon name="search" />
        <input id="link-filter" aria-label="Search all months" placeholder="Search all months" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {filter && (
          <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setFilter("")}><Icon name="x" /></button>
        )}
      </div>
      <div className="cand-period hint">
        {searching
          ? `${what[0].toUpperCase()}${what.slice(1)} matching "${query}" in any month`
          : `${what[0].toUpperCase()}${what.slice(1)} from ${dateLabel(range.from)} to ${dateLabel(range.to)}`}
      </div>
      <div className={`cands ${(searching ? found : nearby).isFetching ? "refreshing" : ""}`} role="listbox" aria-multiselectable>
        {/* The list runs oldest-first from an expense and newest-first from a payment; "earlier" sits where older rows are. */}
        {fromExpense ? earlierBtn : laterBtn}
        {candidates.map((c) => (
          <button type="button" role="option" aria-selected={selected.has(c.id)} key={c.id} className="cand" onClick={() => toggle(c)}>
            <span className={`check ${selected.has(c.id) ? "on" : ""}`}>{selected.has(c.id) && <Icon name="check" />}</span>
            <span className="min0 grow-1">
              <span className="strong ellipsis">{txTitle(c)}</span>
              <span className="meta ellipsis">
                {[dateLabel(c.date), linkNote(c) ?? categoryOf(c), txSubtitle(c)].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Amount cents={c.amount} className="strong" />
          </button>
        ))}
        {candidates.length === 0 && (
          <div className="cand-empty">{searching ? `No ${what} match "${query}".` : `No ${what} in this period.`}</div>
        )}
        {fromExpense ? laterBtn : earlierBtn}
      </div>
      {outcome && (
        <div className="link-outcome">
          <Icon name="tag" />
          <span>{outcome}</span>
        </div>
      )}
      {(fromExpense || selected.size > 0) && (
        <div className="net">
          <span>Your share</span>
          <span className="num">{money(share)}</span>
        </div>
      )}
      {!editing && !joins && (
        <div className="form-row">
          <label htmlFor="link-title">Name</label>
          <input id="link-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Dinner, weekend away…" />
        </div>
      )}
    </Sheet>
  );
}
