import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api, type Tx } from "../api";
import type { CatIndex } from "../lib/categories";
import { longDate, money, shortDate } from "../lib/format";
import { txTitle } from "../lib/text";
import { useSheets } from "../sheets/context";
import { useAccountRoles, useAction, useRules, useTransactions } from "../queries";
import { RuleOfferCard, useRuleOffer } from "../ui/RuleOffer";
import { CategoryPicker } from "../ui/CategoryPicker";
import { CategoryIcon, TxIcon } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { potIcon, TransferMenu } from "../ui/TransferMenu";

export function Inspector({ tx, cats, account, onClose }: { tx: Tx | undefined; cats: CatIndex; account: string; onClose: () => void }) {
  if (!tx) {
    return (
      <aside className="insp empty-insp">
        <p>Select a transaction to see its category, links and notes.</p>
      </aside>
    );
  }
  return <Details key={tx.id} tx={tx} cats={cats} account={account} onClose={onClose} />;
}

function Details({ tx, cats, account, onClose }: { tx: Tx; cats: CatIndex; account: string; onClose: () => void }) {
  const open = useSheets();
  const members = useTransactions({ groupId: tx.groupId ?? undefined }, tx.groupId != null).data ?? [];
  const others = members.filter((m) => m.id !== tx.id);
  const setSplits = useAction(api.setSplits);
  const uncategorize = useAction(api.setSplits, { success: "Category removed" });
  const setNotes = useAction(api.setNotes, { success: "Note saved" });
  const unlink = useAction(api.deleteGroup, { success: "Unlinked" });
  const leave = useAction(api.updateGroupMembers, { success: "Removed from the group" });
  const roles = useAccountRoles();
  const pot = tx.linkCounterAccountId != null ? roles?.all.find((a) => a.id === tx.linkCounterAccountId) : undefined;
  const [notes, setNotesText] = useState(tx.notes ?? "");
  useEffect(() => setNotesText(tx.notes ?? ""), [tx.notes]);

  const { offer, propose, dismiss } = useRuleOffer();
  const rule = useRules().data?.find((r) => r.id === tx.ruleId);
  const categorize = (id: number) =>
    setSplits.mutate([tx.id, [{ categoryId: id, amount: tx.amount }]], { onSuccess: () => propose(tx, { categoryId: id }) });
  const share = members.reduce((s, m) => s + m.amount, 0);
  const expense = members.find((m) => m.amount < 0) ?? (tx.amount < 0 ? tx : undefined);

  return (
    <aside className="insp" aria-label="Transaction details">
      <button className="icon-btn insp-close" aria-label="Close details" onClick={onClose}><Icon name="x" /></button>
      <div className="insp-head">
        <TxIcon tx={tx} cats={cats} size="lg" />
        <div className="big num">€ {money(tx.amount)}</div>
        <div className="nm">{txTitle(tx)}</div>
        <div className="meta">{longDate(tx.date)} · {account}</div>
      </div>

      {tx.linkKind === "transfer" ? (
        <section>
          <div className="glabel">Transfer</div>
          <div className="group">
            {pot && (
              <Link className="grow" to="/pots" search={{ id: pot.id }}>
                <span className="ci sm pot"><Icon name={potIcon(pot)} /></span>
                <span className="grow-1">{tx.amount < 0 ? "To" : "From"} {pot.name}</span>
                <Icon name="right" className="chev" />
              </Link>
            )}
            {others.map((o) => (
              <div className="grow" key={o.id}>
                <span className="ci sm xfer"><Icon name="swap" /></span>
                <span className="grow-1 min0 ellipsis">{txTitle(o)}</span>
                <span className="v num">{money(o.amount, { plus: true })}</span>
              </div>
            ))}
            {others.length === 0 && !pot && <div className="grow muted">The other side is an account you don't track.</div>}
            {rule && (
              <div className="grow muted rule-note">
                <Icon name="sparkle" className="accent" /> Marked by rule <span className="rule-pattern">{rule.pattern}</span>
                <button className="link-btn" onClick={() => open({ kind: "rules", focus: rule.id })}>Edit Rule</button>
              </div>
            )}
            <button className="grow action" onClick={() => unlink.mutate([tx.groupId!])}><Icon name="x" />Unlink Transfer</button>
          </div>
          <div className="gfoot">Not counted as spending or income: money moved between your own accounts.</div>
        </section>
      ) : (
        <section>
          <div className="glabel">Category</div>
          <div className="group">
            {tx.splits.length <= 1 ? (
              <CategoryPicker cats={cats} onPick={categorize} defaultKind={tx.amount < 0 ? "expense" : "income"}>
                <button className="grow">
                  {tx.splits[0] && cats.byId.get(tx.splits[0].categoryId) ? (
                    <>
                      <CategoryIcon cat={cats.byId.get(tx.splits[0].categoryId)!} size="sm" />
                      <span className="grow-1">{cats.byId.get(tx.splits[0].categoryId)!.path}</span>
                    </>
                  ) : (
                    <>
                      <span className="ci sm none"><Icon name="q" /></span>
                      <span className="grow-1 accent">Choose Category</span>
                    </>
                  )}
                  <Icon name="right" className="chev" />
                </button>
              </CategoryPicker>
            ) : (
              tx.splits.map((s) => {
                const c = cats.byId.get(s.categoryId);
                return (
                  <div className="grow" key={s.categoryId}>
                    {c && <CategoryIcon cat={c} size="sm" />}
                    <span className="grow-1">{c?.path ?? "Unknown category"}</span>
                    <span className="v num">{money(s.amount)}</span>
                  </div>
                );
              })
            )}
            <button className="grow action" onClick={() => open({ kind: "split", tx })}>
              <Icon name="split" />{tx.splits.length > 1 ? "Edit Split" : "Split Across Categories"}
            </button>
            {tx.splits.length > 0 && (
              <button className="grow action danger" disabled={uncategorize.isPending} title={tx.linkKind === "reimbursement" ? "Also removes it from the linked transactions" : undefined} onClick={() => { dismiss(); uncategorize.mutate([tx.id, []]); }}>
                <Icon name="x" />{tx.splits.length > 1 ? "Remove Split" : "Remove Category"}
              </button>
            )}
          </div>
          {tx.linkKind === "reimbursement" && (
            <div className="gfoot">
              {tx.amount < 0
                ? "Its payments back get this category too."
                : "Shares the category of the expense it pays back. Choosing another one here changes the expense too."}
            </div>
          )}
          {rule && (
            <div className="gfoot">
              <Icon name="sparkle" className="accent" /> Labelled by rule <span className="rule-pattern">{rule.pattern}</span>.{" "}
              <button className="link-btn" onClick={() => open({ kind: "rules", focus: rule.id })}>Edit Rule</button>
            </div>
          )}
        </section>
      )}

      {offer && (
        <section>
          <RuleOfferCard offer={offer} cats={cats} onDone={dismiss} />
        </section>
      )}

      {tx.linkKind === "reimbursement" && (
        <section>
          <div className="glabel">{tx.amount < 0 ? "Paid back" : "Pays back"}{tx.linkTitle ? ` · ${tx.linkTitle}` : ""}</div>
          <div className="group">
            {others.map((o) => (
              <div className="grow" key={o.id}>
                <span className={`ci sm ${o.amount > 0 ? "person" : ""}`} style={{ ["--cc" as string]: "var(--gray)" }}>
                  <Icon name={o.amount > 0 ? "people" : "back"} />
                </span>
                <span className="grow-1 min0 ellipsis">{txTitle(o)} <span className="muted">· {shortDate(o.date)}</span></span>
                <span className={`v num ${o.amount > 0 ? "pos" : ""}`}>{money(o.amount, { plus: true })}</span>
              </div>
            ))}
            <div className="grow total">Your share<span className="v num">{money(share, { plus: true })}</span></div>
            {expense && <button className="grow action" onClick={() => open({ kind: "link", tx: expense })}><Icon name="plus" />Link More Payments Back</button>}
            {tx.amount > 0 && <button className="grow action" onClick={() => open({ kind: "link", tx })}><Icon name="plus" />Link More Expenses</button>}
            <button
              className="grow action danger"
              onClick={() => (others.length > 0 ? leave.mutate([tx.groupId!, [], [tx.id]]) : unlink.mutate([tx.groupId!]))}
            >
              <Icon name="x" />Remove From Group
            </button>
          </div>
          <div className="gfoot">Payments back count in the month of the expense.</div>
        </section>
      )}

      {tx.linkKind == null && (
        <section>
          <div className="glabel">Links</div>
          <div className="group">
            <button className="grow action" onClick={() => open({ kind: "link", tx })}>
              <Icon name="back" />{tx.amount < 0 ? "Link Payments Back" : "Link to Expenses"}
            </button>
            <TransferMenu tx={tx} onDone={(potId) => potId != null && propose(tx, { potId })}>
              <button className="grow action">
                <Icon name="swap" /><span className="grow-1">Mark as Transfer</span><Icon name="right" className="chev" />
              </button>
            </TransferMenu>
          </div>
          <div className="gfoot">Mark as transfer when the money went to or came from your own account or a pot, such as savings or cash you keep.</div>
        </section>
      )}

      <section>
        <div className="glabel">Notes</div>
        <textarea
          id="tx-notes"
          className="notes"
          rows={3}
          placeholder="Add a note"
          value={notes}
          onChange={(e) => setNotesText(e.target.value)}
          onBlur={() => notes !== (tx.notes ?? "") && setNotes.mutate([tx.id, notes])}
        />
      </section>

      <section>
        <div className="glabel">From the bank</div>
        <div className="group details">
          {tx.iban && <div className="grow"><span className="muted">IBAN</span><span className="v mono">{tx.iban}</span></div>}
          <div className="grow raw">{tx.description}</div>
        </div>
      </section>
    </aside>
  );
}
