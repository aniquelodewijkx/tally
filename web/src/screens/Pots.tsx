import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

import { longDate, money, shortDate } from "../lib/format";
import { txTitle } from "../lib/text";
import { useAccountRoles, useTransactions } from "../queries";
import { Empty } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { potIcon } from "../ui/TransferMenu";

/** A pot's page: every transfer marked as going to or coming from it, seen from the pot's side. */
export function Pots() {
  const { id } = useSearch({ from: "/pots" });
  const navigate = useNavigate();
  const roles = useAccountRoles();
  const moves = useTransactions({ counterAccountId: id }, id != null).data;
  const pot = roles?.all.find((a) => a.id === id);
  const total = useMemo(() => (moves ?? []).reduce((s, t) => s - t.amount, 0), [moves]);

  if (!roles || !moves) return <div className="page grouped" />;
  if (!pot) return <div className="page grouped"><Empty title="This pot doesn't exist" /></div>;
  const first = moves.length ? moves[moves.length - 1].date : null;

  return (
    <div className="page grouped">
      <div className="ov pot-page">
        <div className="pot-head">
          <span className="ci lg pot"><Icon name={potIcon(pot)} /></span>
          <div>
            <h1>{pot.name}</h1>
            <div className="meta">Pot · not imported, filled by the transfers you mark as going here</div>
          </div>
        </div>
        <div className="summary pot-summary">
          <div>
            <div className="l">{first ? `Moved in since ${longDate(first)}` : "Moved in"}</div>
            <div className={`v ${total > 0 ? "pos" : ""}`}>{money(total, { plus: true })}</div>
          </div>
          <div>
            <div className="l">Transfers</div>
            <div className="v">{moves.length}</div>
          </div>
        </div>
        {moves.length === 0 ? (
          <div className="card">
            <Empty title={`Nothing in ${pot.name} yet`}>
              <p>In Transactions, select money you moved here, then choose Mark as Transfer › To {pot.name}.</p>
            </Empty>
          </div>
        ) : (
          <div className="group cat-list">
            {moves.map((t) => (
              <button key={t.id} className="grow" onClick={() => navigate({ to: "/transactions", search: { month: t.date.slice(0, 7), tx: t.id } })}>
                <span className="ci md xfer"><Icon name="swap" /></span>
                <span className="grow-1 min0">
                  <span className="nm ellipsis">{txTitle(t)}</span>
                  <span className="note">{t.amount < 0 ? "From" : "To"} {roles.name(t.accountId)} · {shortDate(t.date)} {t.date.slice(0, 4)}</span>
                </span>
                <span className={`amt num ${t.amount < 0 ? "pos" : ""}`}>{money(-t.amount, { plus: true })}</span>
                <Icon name="right" className="chev" />
              </button>
            ))}
          </div>
        )}
        <p className="hint">The total is what you moved in and out since tracking started, not the pot's full balance.</p>
      </div>
    </div>
  );
}
