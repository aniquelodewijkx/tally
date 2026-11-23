import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type TransferSuggestion, type Tx } from "../api";
import { daysBetween, longDate, money, shortDate } from "../lib/format";
import { quickPicks } from "../lib/picks";
import { txSubtitle, txTitle } from "../lib/text";
import { anySheetOpen, useSheets } from "../sheets/context";
import { useAccounts, useAction, useAllTransactions, useCats, useTransferSuggestions, useUncategorized } from "../queries";
import { CategoryPicker } from "../ui/CategoryPicker";
import { Amount, CategoryIcon, Empty, TxIcon } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { TransferMenu } from "../ui/TransferMenu";
import { acceptOffer, RuleOfferCard, useRuleOffer } from "../ui/RuleOffer";

type Item = { key: string; kind: "transfer"; s: TransferSuggestion; out: Tx; in: Tx } | { key: string; kind: "tx"; tx: Tx };

const QUEUE_SHOWN = 40;

/** Everything that needs a decision: transfer suggestions first, then uncategorized transactions. */
export function Inbox() {
  const cats = useCats();
  const accounts = useAccounts().data ?? [];
  const uncategorized = useUncategorized().data;
  const suggestions = useTransferSuggestions().data;
  const all = useAllTransactions().data;
  const open = useSheets();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [last, setLast] = useState<{ txId: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { offer, propose, dismiss: dismissOffer } = useRuleOffer();
  const createRule = useAction(acceptOffer, { success: (msg) => msg, onSuccess: dismissOffer });

  const queue = useMemo<Item[]>(() => {
    if (!uncategorized || !suggestions || !all) return [];
    const byId = new Map(all.map((t) => [t.id, t]));
    const used = new Set<number>();
    const transfers: Item[] = [];
    for (const s of suggestions) {
      const key = `t${s.outgoingId}-${s.incomingId}`;
      const out = byId.get(s.outgoingId);
      const inc = byId.get(s.incomingId);
      if (!out || !inc || dismissed.has(key) || used.has(out.id) || used.has(inc.id)) continue;
      used.add(out.id);
      used.add(inc.id);
      transfers.push({ key, kind: "transfer", s, out, in: inc });
    }
    const txs: Item[] = uncategorized.filter((t) => !used.has(t.id)).map((tx) => ({ key: `x${tx.id}`, kind: "tx", tx }));
    const items = [...transfers, ...txs];
    const rank = (i: Item) => skipped.indexOf(i.key);
    return items.sort((a, b) => rank(a) - rank(b));
  }, [uncategorized, suggestions, all, dismissed, skipped]);

  const item = queue.find((i) => i.key === current) ?? queue[0];
  const next = () => {
    const idx = queue.findIndex((i) => i.key === item?.key);
    setCurrent(queue[idx + 1]?.key ?? null);
  };

  const categorize = useAction(api.setSplits, {
    onSuccess: (t) => {
      setDone((d) => d + 1);
      setLast({ txId: t.id });
      next();
    },
  });
  const undo = useAction(api.setSplits, {
    success: "Undone",
    onSuccess: (t) => {
      setDone((d) => Math.max(0, d - 1));
      setCurrent(`x${t.id}`);
      setLast(null);
    },
  });
  const linkTransfer = useAction(api.createGroup, {
    success: "Linked as transfer",
    onSuccess: () => {
      setDone((d) => d + 1);
      next();
    },
  });

  const picks = useMemo(() => (item?.kind === "tx" && cats && all ? quickPicks(item.tx, all, cats) : []), [item, cats, all]);
  const assign = (categoryId: number) => {
    if (item?.kind !== "tx") return;
    const tx = item.tx;
    categorize.mutate([tx.id, [{ categoryId, amount: tx.amount }]], { onSuccess: () => propose(tx, { categoryId }) });
  };
  const skip = () => item && (setSkipped((s) => [...s.filter((k) => k !== item.key), item.key]), next());
  const dismiss = () => {
    if (item?.kind !== "transfer") return;
    setDismissed((d) => new Set(d).add(item.key));
    next();
  };

  // Keyboard: 1-5 quick picks, / all categories, S split, L link, J skip, U undo, T / N for transfers.
  const handler = useRef<(e: KeyboardEvent) => void>(() => {});
  handler.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || anySheetOpen() || /INPUT|TEXTAREA|SELECT/.test(target.tagName) || !item) return;
    const k = e.key.toLowerCase();
    if (k === "r" && offer) {
      createRule.mutate([offer]);
      e.preventDefault();
      return;
    }
    if (item.kind === "tx") {
      if (/^[1-5]$/.test(k) && picks[Number(k) - 1]) assign(picks[Number(k) - 1].categoryId);
      else if (k === "/") setPickerOpen(true);
      else if (k === "s") open({ kind: "split", tx: item.tx });
      else if (k === "l") open({ kind: "link", tx: item.tx });
      else if (k === "j") skip();
      else if (k === "u" && last) undo.mutate([last.txId, []]);
      else return;
    } else {
      if (k === "t") linkTransfer.mutate(["transfer", null, [item.out.id, item.in.id]]);
      else if (k === "n") dismiss();
      else if (k === "j") skip();
      else return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => handler.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  if (!cats || !uncategorized || !suggestions || !all) return <div className="page grouped" />;
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "";
  const total = done + queue.length;
  const transfers = queue.filter((i) => i.kind === "transfer").length;

  return (
    <div className="inbox">
      <aside className="queue">
        <div className="toolbar"><div className="title"><h1>To Categorize</h1></div></div>
        <div className="ring-row">
          <Ring value={total ? done / total : 1} />
          <div>
            <b>{done} of {total} done</b>
            <span>{queue.length - transfers} to categorize · {transfers} transfer{transfers === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div className="queue-list">
          {queue.slice(0, QUEUE_SHOWN).map((i, idx) => (
            <div key={i.key}>
              {(idx === 0 || queue[idx - 1].kind !== i.kind) && (
                <div className="qh">{i.kind === "transfer" ? "Transfers" : "Transactions"}</div>
              )}
              <button className={`qi ${i.key === item?.key ? "on" : ""}`} onClick={() => setCurrent(i.key)}>
                {i.kind === "transfer" ? (
                  <><span className="ci sm xfer"><Icon name="swap" /></span><span className="nm">{txTitle(i.out)}</span><span className="amt num">{money(-i.out.amount)}</span></>
                ) : (
                  <><TxIcon tx={i.tx} cats={cats} size="sm" /><span className="nm">{txTitle(i.tx)}</span><Amount cents={i.tx.amount} className="amt" /></>
                )}
              </button>
            </div>
          ))}
          {queue.length > QUEUE_SHOWN && <div className="qi muted">{queue.length - QUEUE_SHOWN} more</div>}
        </div>
      </aside>
      <section className="stage-inner">
        {offer && (
          <div className="inbox-offer">
            <RuleOfferCard offer={offer} cats={cats} onDone={dismissOffer} />
            <span className="hint">Press <span className="kbd">R</span> to create the rule</span>
          </div>
        )}
        {!item ? (
          <div className="card">
            <Empty title="All caught up">
              <p>Everything is categorized and every transfer is linked.</p>
              <Link to="/" className="btn primary">Go to Overview</Link>
            </Empty>
          </div>
        ) : item.kind === "tx" ? (
          <div className="card">
            <div className="head">
              <TxIcon tx={item.tx} cats={cats} size="lg" />
              <div className="min0">
                <div className="big num">€ {money(item.tx.amount)}</div>
                <div className="title-line">{txTitle(item.tx)}</div>
                <div className="meta">{[accountName(item.tx.accountId), longDate(item.tx.date), txSubtitle(item.tx)].filter(Boolean).join(" · ")}</div>
              </div>
            </div>
            <div className="picks">
              {picks.map((p, i) => {
                const c = cats.byId.get(p.categoryId)!;
                return (
                  <button key={p.categoryId} className={`pick ${i === 0 && p.here > 0 ? "top" : ""}`} onClick={() => assign(p.categoryId)}>
                    <CategoryIcon cat={c} size="sm" />
                    <span className="min0">
                      <span className="strong ellipsis">{c.name}</span>
                      {p.here > 0 && <span className="hint">Used {p.here}× here</span>}
                    </span>
                    <span className="kbd">{i + 1}</span>
                  </button>
                );
              })}
              <CategoryPicker cats={cats} onPick={assign} open={pickerOpen} onOpenChange={setPickerOpen} defaultKind={item.tx.amount < 0 ? "expense" : "income"}>
                <button className="pick muted"><Icon name="search" /><span>All categories</span><span className="kbd">/</span></button>
              </CategoryPicker>
            </div>
            {cats.ordered.length === 0 && <p className="hint">No categories yet. Add them under Categories in the sidebar.</p>}
            <div className="actions">
              <button className="btn" onClick={() => open({ kind: "split", tx: item.tx })}><Icon name="split" />Split <span className="kbd">S</span></button>
              <button className="btn" onClick={() => open({ kind: "link", tx: item.tx })}>
                <Icon name="back" />{item.tx.amount < 0 ? "Link Payments Back" : "Link to an Expense"} <span className="kbd">L</span>
              </button>
              <TransferMenu
                tx={item.tx}
                onDone={(potId) => {
                  const tx = item.tx;
                  setDone((d) => d + 1);
                  next();
                  if (potId != null) propose(tx, { potId });
                }}
              >
                <button className="btn"><Icon name="swap" />Transfer</button>
              </TransferMenu>
              <span className="spacer" />
              <button className="btn plain" onClick={skip}>Skip <span className="kbd">J</span></button>
              <button className="btn plain" disabled={!last} onClick={() => last && undo.mutate([last.txId, []])}>Undo <span className="kbd">U</span></button>
            </div>
          </div>
        ) : (
          <TransferCard item={item} accountName={accountName} onLink={() => linkTransfer.mutate(["transfer", null, [item.out.id, item.in.id]])} onDismiss={dismiss} onSkip={skip} />
        )}
      </section>
    </div>
  );
}

function TransferCard({
  item,
  accountName,
  onLink,
  onDismiss,
  onSkip,
}: {
  item: Extract<Item, { kind: "transfer" }>;
  accountName: (id: number) => string;
  onLink: () => void;
  onDismiss: () => void;
  onSkip: () => void;
}) {
  const days = Math.abs(daysBetween(item.out.date, item.in.date));
  const side = (t: Tx) => (
    <div className="side">
      <div className="meta">{accountName(t.accountId)} · {shortDate(t.date)}</div>
      <div className="nm">{txTitle(t)}</div>
      <Amount cents={t.amount} className="amt" />
    </div>
  );
  return (
    <div className="card">
      <div className="head spread">
        <b className="title-line">Transfer between your accounts?</b>
        <span className="meta">Opposite amounts, {days === 0 ? "same day" : `${days} day${days === 1 ? "" : "s"} apart`}</span>
      </div>
      <div className="pair">
        {side(item.out)}
        <span className="swap"><Icon name="swap" /></span>
        {side(item.in)}
      </div>
      <div className="actions">
        <button className="btn plain" onClick={onSkip}>Skip <span className="kbd">J</span></button>
        <span className="spacer" />
        <button className="btn" onClick={onDismiss}>Not a Transfer <span className="kbd">N</span></button>
        <button className="btn primary" onClick={onLink}>Link as Transfer <span className="kbd on-accent">T</span></button>
      </div>
    </div>
  );
}

function Ring({ value }: { value: number }) {
  const c = 2 * Math.PI * 18;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--fill)" strokeWidth="6" />
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--green)" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${Math.max(value, 0.001) * c} ${c}`} transform="rotate(-90 22 22)" />
    </svg>
  );
}
