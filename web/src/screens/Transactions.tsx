import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import type { Account, Tx } from "../api";
import { isUncategorized, type CatIndex } from "../lib/categories";
import { addMonths, currentMonth, dayLabel, money, monthLabel, monthRange } from "../lib/format";
import { txSubtitle, txTitle } from "../lib/text";
import { useAccounts, useAction, useCats, useTransactions } from "../queries";
import { api } from "../api";
import { CategoryPicker } from "../ui/CategoryPicker";
import { Amount, CategoryIcon, Empty, Segmented, Stepper, Switch, TxIcon } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { RuleOfferCard, useRuleOffer } from "../ui/RuleOffer";
import { anySheetOpen } from "../sheets/context";
import { BulkPanel } from "./BulkPanel";
import { Inspector } from "./Inspector";

/** The category and all of its descendants. */
function subtree(cats: CatIndex, id: number): Set<number> {
  const ids = new Set<number>();
  for (const c of cats.ordered) {
    for (let cur: number | null = c.id; cur != null; cur = cats.byId.get(cur)?.parentId ?? null) {
      if (cur === id) {
        ids.add(c.id);
        break;
      }
    }
  }
  return ids;
}

export function Transactions() {
  const search = useSearch({ from: "/transactions" });
  const navigate = useNavigate({ from: "/transactions" });
  const cats = useCats();
  const accounts = useAccounts().data ?? [];
  const month = search.month ?? currentMonth();
  const [query, setQuery] = useState(search.q ?? "");
  useEffect(() => setQuery(search.q ?? ""), [search.q]);

  // Searching looks through every month; otherwise the list shows one month.
  const filter = {
    ...(search.q ? {} : monthRange(month)),
    accountId: search.account,
    uncategorizedOnly: search.uncategorized,
    search: search.q,
  };
  const { data, isFetching } = useTransactions(filter);
  const { rows, categoryTotal } = useMemo(() => {
    if (!data || !cats) return { rows: [], categoryTotal: 0 };
    if (search.category == null) return { rows: data, categoryTotal: 0 };
    const ids = subtree(cats, search.category);
    const rows = data.filter((t) => t.splits.some((s) => ids.has(s.categoryId)));
    // Split transactions count only their share in the category.
    const categoryTotal = rows.reduce((n, t) => n + t.splits.reduce((m, s) => m + (ids.has(s.categoryId) ? s.amount : 0), 0), 0);
    return { rows, categoryTotal };
  }, [data, cats, search.category]);
  const days = useMemo(() => {
    const out: [string, Tx[]][] = [];
    for (const t of rows) {
      if (out.length && out[out.length - 1][0] === t.date) out[out.length - 1][1].push(t);
      else out.push([t.date, [t]]);
    }
    return out;
  }, [rows]);
  const selected = rows.find((t) => t.id === search.tx) ?? data?.find((t) => t.id === search.tx);
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "";
  const set = (patch: Partial<typeof search>) => navigate({ search: (s) => ({ ...s, ...patch }) });
  const { offer, propose, dismiss } = useRuleOffer();

  // After picking a category on a row, the next uncategorized row's picker opens, so you can
  // type, Enter, type, Enter down the list. Escape or a click elsewhere stops it.
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const openNextPicker = (afterId: number) => {
    const i = rows.findIndex((r) => r.id === afterId);
    const next = rows.slice(i + 1).find((r) => r.linkKind == null && isUncategorized(r) && r.amount !== 0);
    if (!next) return setPickerFor(null);
    document.querySelector(`[data-tx-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
    setPickerFor(next.id);
  };

  // Multi-selection lives in the page, not the URL: ⌘/Ctrl-click toggles, Shift-click selects a
  // range, Select mode toggles with a plain click. One transaction is the ordinary selection (URL).
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const anchor = useRef<number | null>(null);
  const pickedTxs = rows.filter((t) => picked.has(t.id));
  const bulk = pickedTxs.length >= 2 || (selecting && pickedTxs.length >= 1);
  const clearPicked = () => setPicked(new Set());
  useEffect(clearPicked, [month, search.q, search.account, search.category, search.uncategorized]);

  const clickRow = (t: Tx, e: MouseEvent) => {
    const toggle = e.metaKey || e.ctrlKey || selecting;
    if (e.shiftKey && anchor.current != null) {
      const ids = rows.map((r) => r.id);
      const [from, to] = [ids.indexOf(anchor.current), ids.indexOf(t.id)].sort((x, y) => x - y);
      if (from >= 0) {
        e.preventDefault();
        setPicked(new Set([...(toggle ? picked : []), ...ids.slice(from, to + 1)]));
        if (search.tx != null) set({ tx: undefined });
        return;
      }
    }
    anchor.current = t.id;
    if (toggle) {
      const next = new Set(picked.size === 0 && search.tx != null ? [search.tx] : picked);
      next.has(t.id) ? next.delete(t.id) : next.add(t.id);
      // Down to one outside Select mode: that's an ordinary selection again.
      if (!selecting && next.size === 1) {
        setPicked(new Set());
        set({ tx: [...next][0] });
      } else {
        setPicked(next);
        if (search.tx != null) set({ tx: undefined });
      }
      return;
    }
    clearPicked();
    set({ tx: t.id === search.tx ? undefined : t.id });
  };

  // ⌘/Ctrl+A selects everything listed; Escape ends the selection.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (anySheetOpen() || /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && rows.length > 0) {
      e.preventDefault();
      setPicked(new Set(rows.map((r) => r.id)));
      if (search.tx != null) set({ tx: undefined });
    } else if (e.key === "Escape" && (picked.size > 0 || selecting)) {
      clearPicked();
      setSelecting(false);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const category = search.category != null ? cats?.byId.get(search.category) : undefined;
  const title = search.account != null ? accountName(search.account) || "Transactions" : "Transactions";

  return (
    <div className={`tx-layout ${selected && !bulk ? "has-selection" : ""} ${bulk ? "has-bulk" : ""} ${selecting ? "selecting" : ""}`}>
      <section className="tx-col">
        <div className="toolbar">
          <div className="title">
            <h1>{title}</h1>
            <small>
              {search.q ? `Search results in all months · ${rows.length}` : `${monthLabel(month)} · ${rows.length} transaction${rows.length === 1 ? "" : "s"}`}
              {category && rows.length > 0 && <> · <span className="num">{money(categoryTotal)}</span> in {category.name}</>}
            </small>
          </div>
          <div className="spacer" />
          {!search.q && <Stepper label="month" onPrev={() => set({ month: addMonths(month, -1), tx: undefined })} onNext={() => set({ month: addMonths(month, 1), tx: undefined })} />}
          <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: query.trim() || undefined, tx: undefined }); }}>
            <Icon name="search" />
            <input id="tx-search" aria-label="Search all transactions" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            {search.q && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => set({ q: undefined })}><Icon name="x" /></button>}
          </form>
        </div>
        <div className="toolbar second">
          <AccountFilter accounts={accounts} value={search.account} onChange={(account) => set({ account, tx: undefined })} />
          {cats && (
            <CategoryFilter
              cats={cats}
              value={search.category}
              onChange={(category) => set({ category, uncategorized: category != null ? undefined : search.uncategorized, tx: undefined })}
            />
          )}
          <div className="spacer" />
          <button
            className={`btn select-btn ${selecting ? "on" : ""}`}
            aria-pressed={selecting}
            title="Select several transactions. Also: ⌘/Ctrl-click, Shift-click, ⌘/Ctrl+A"
            onClick={() => {
              if (selecting) clearPicked();
              else if (search.tx != null) {
                setPicked(new Set([search.tx]));
                set({ tx: undefined });
              }
              setSelecting(!selecting);
            }}
          >
            {selecting ? "Done" : "Select"}
          </button>
          <Switch checked={!!search.uncategorized} onChange={(v) => set({ uncategorized: v || undefined, category: v ? undefined : search.category, tx: undefined })}>
            Uncategorized only
          </Switch>
        </div>
        <div className={`tx-scroll ${isFetching ? "refreshing" : ""}`}>
          {cats && days.map(([date, txs]) => (
            <div key={date}>
              <div className="day">{dayLabel(date)}</div>
              {txs.map((t) => (
                <TxRow
                  key={t.id}
                  tx={t}
                  cats={cats}
                  account={accountName(t.accountId)}
                  pot={t.linkCounterAccountId != null ? accountName(t.linkCounterAccountId) : null}
                  selected={!bulk && t.id === search.tx}
                  multi={picked.has(t.id)}
                  checkbox={selecting}
                  onSelect={(e) => clickRow(t, e)}
                  pickerOpen={pickerFor === t.id}
                  onPickerOpenChange={(o) => setPickerFor((cur) => (o ? t.id : cur === t.id ? null : cur))}
                  onPicked={() => openNextPicker(t.id)}
                  onCategorized={propose}
                />
              ))}
            </div>
          ))}
          {offer && cats && (
            <div className="offer-dock">
              <RuleOfferCard offer={offer} cats={cats} onDone={dismiss} />
            </div>
          )}
          {data && rows.length === 0 && (
            <Empty title={search.q ? `Nothing matches "${search.q}"` : "No transactions here"}>
              {search.q ? "Try another word from the description or name." : "Try another month, or import a statement."}
            </Empty>
          )}
        </div>
      </section>
      {cats && bulk && (
        <BulkPanel
          txs={pickedTxs}
          cats={cats}
          propose={propose}
          onClear={() => { clearPicked(); setSelecting(false); }}
          onDone={() => { clearPicked(); setSelecting(false); }}
        />
      )}
      {cats && !bulk && (
        <Inspector
          tx={selected}
          cats={cats}
          account={selected ? accountName(selected.accountId) : ""}
          onClose={() => set({ tx: undefined })}
        />
      )}
    </div>
  );
}

/** "Category" button that opens the category list; once set, shows the category with a clear button. */
function CategoryFilter({ cats, value, onChange }: { cats: CatIndex; value?: number; onChange: (v: number | undefined) => void }) {
  const cat = value != null ? cats.byId.get(value) : undefined;
  return (
    <span className={`cat-filter ${cat ? "set" : ""}`}>
      <CategoryPicker cats={cats} onPick={onChange} allowCreate={false}>
        <button type="button" className="cat-filter-btn" aria-label={cat ? `Category filter: ${cat.path}. Change` : "Filter by category"}>
          {cat ? <CategoryIcon cat={cat} size="sm" /> : <Icon name="tag" />}
          <span className="ellipsis">{cat ? cat.path : "Category"}</span>
          {!cat && <Icon name="updown" />}
        </button>
      </CategoryPicker>
      {cat && (
        <button type="button" className="cat-filter-clear" aria-label={`Remove filter ${cat.path}`} onClick={() => onChange(undefined)}>
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}

function AccountFilter({ accounts, value, onChange }: { accounts: Account[]; value?: number; onChange: (v: number | undefined) => void }) {
  if (accounts.length < 2) return null;
  return (
    <Segmented
      label="Account"
      value={value ?? 0}
      options={[{ value: 0, label: "All" }, ...accounts.map((a) => ({ value: a.id, label: a.name.split(" ")[0] }))]}
      onChange={(v) => onChange(v === 0 ? undefined : v)}
    />
  );
}

function TxRow({
  tx,
  cats,
  account,
  pot,
  selected,
  multi,
  checkbox,
  onSelect,
  onCategorized,
  pickerOpen,
  onPickerOpenChange,
  onPicked,
}: {
  tx: Tx;
  cats: CatIndex;
  account: string;
  pot: string | null;
  selected: boolean;
  /** Part of a multi-selection. */
  multi: boolean;
  /** Select mode: show a checkbox. */
  checkbox: boolean;
  onSelect: (e: MouseEvent) => void;
  onCategorized: (tx: Tx, target: { categoryId: number }) => void;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  /** After a category is picked: move on to the next row. */
  onPicked: () => void;
}) {
  const setSplits = useAction(api.setSplits);
  const sub = [account, txSubtitle(tx)].filter(Boolean).join(" · ");
  return (
    <div className={`tx ${selected ? "sel" : ""} ${multi ? "multi" : ""} ${tx.linkKind === "transfer" ? "dim" : ""}`} data-tx-id={tx.id}>
      <button className="tx-main" onClick={onSelect} aria-pressed={selected || multi}>
        {checkbox && <span className={`check ${multi ? "on" : ""}`}>{multi && <Icon name="check" />}</span>}
        <TxIcon tx={tx} cats={cats} />
        <span className="min0">
          <span className="nm">{txTitle(tx)}</span>
          <span className="sub">{sub}</span>
        </span>
      </button>
      {tx.linkKind === "transfer" ? (
        <span className="tag xfer">{pot ? `${tx.amount < 0 ? "\u2192" : "\u2190"} ${pot}` : "Transfer"}</span>
      ) : tx.linkKind === "reimbursement" ? (
        <span className="tag link"><Icon name="back" />{tx.linkTitle ?? "Paid back"}</span>
      ) : isUncategorized(tx) ? (
        <CategoryPicker
          cats={cats}
          defaultKind={tx.amount < 0 ? "expense" : "income"}
          open={pickerOpen}
          onOpenChange={onPickerOpenChange}
          returnFocusAfterPick={false}
          onPick={(id) => {
            setSplits.mutate([tx.id, [{ categoryId: id, amount: tx.amount }]], { onSuccess: () => onCategorized(tx, { categoryId: id }) });
            onPicked();
          }}
        >
          <button className="tag add"><Icon name="plus" />Category</button>
        </CategoryPicker>
      ) : (
        <span />
      )}
      <button className="amt-btn" onClick={onSelect} tabIndex={-1}>
        <Amount cents={tx.amount} className="amt" />
      </button>
    </div>
  );
}
