import { useCallback, useState } from "react";

import { api, type RuleDirection, type RuleDraft, type Tx } from "../api";
import type { CatIndex } from "../lib/categories";
import { suggestPattern } from "../lib/text";
import { useSheets } from "../sheets/context";
import { useAccountRoles, useAction } from "../queries";

export interface Offer {
  pattern: string;
  /** Exactly one of categoryId and potId. */
  categoryId?: number;
  potId?: number;
  direction: RuleDirection;
  /** Other unlabelled transactions the rule would label right away. */
  matching: number;
  /** A rule for exactly this pattern and direction already exists with another target: offer to change it. */
  existing?: { id: number; labels: number };
}

const draftOf = (o: Offer): RuleDraft => ({ pattern: o.pattern, categoryId: o.categoryId ?? null, potId: o.potId ?? null, direction: o.direction });

/** Creates the offered rule, or changes the existing one. */
export async function acceptOffer(o: Offer): Promise<string> {
  if (o.existing) {
    await api.updateRule(o.existing.id, draftOf(o));
    return "Rule changed";
  }
  const r = await api.createRule(draftOf(o), true);
  return r.labelled ? `Rule created \u00b7 ${r.labelled} more labelled` : "Rule created";
}

/**
 * After you categorize a transaction or mark it as a transfer to a pot, offers a rule for its
 * counterparty: "Always label albert heijn as Groceries?" Offered even when nothing else matches
 * yet, since the rule also labels future imports. When a rule for the same name already exists with
 * another target, offers to change that rule instead; when it already does this, offers nothing.
 */
export function useRuleOffer() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const propose = useCallback(async (tx: Tx, target: { categoryId: number } | { potId: number }) => {
    const pattern = suggestPattern(tx);
    // Money moves both ways between you and a pot (savings in, savings back out), so a pot rule
    // covers both directions. A category rule keeps the direction: paying a Tikkie isn't receiving one.
    const direction: RuleDirection = "potId" in target ? null : tx.amount < 0 ? "out" : "in";
    if (!pattern) return setOffer(null);
    try {
      const [rules, preview] = await Promise.all([api.listRules(), api.previewRule({ pattern, direction })]);
      const same = rules.find(
        (r) => r.pattern === pattern && r.direction === direction && r.accountId == null && r.minAmount == null && r.maxAmount == null,
      );
      const sameTarget =
        same && ("potId" in target ? same.potId === target.potId : same.categoryId === target.categoryId);
      if (sameTarget) return setOffer(null);
      setOffer({ pattern, direction, matching: preview.willLabel, ...target, existing: same ? { id: same.id, labels: same.labels } : undefined });
    } catch {
      setOffer(null);
    }
  }, []);
  const dismiss = useCallback(() => setOffer(null), []);
  return { offer, propose, dismiss };
}

export function RuleOfferCard({ offer, cats, onDone }: { offer: Offer; cats: CatIndex; onDone: () => void }) {
  const open = useSheets();
  const roles = useAccountRoles();
  const accept = useAction(acceptOffer, { success: (msg) => msg, onSuccess: onDone });
  const cat = offer.categoryId != null ? cats.byId.get(offer.categoryId) : undefined;
  const pot = offer.potId != null ? roles?.all.find((a) => a.id === offer.potId) : undefined;
  if (!cat && !pot) return null;
  const which = offer.direction === "out" ? "payments to " : offer.direction === "in" ? "money from " : "";
  const target = cat ? cat.name : `a transfer to or from ${pot!.name}`;
  const more =
    offer.matching > 0
      ? `${offer.matching} more transaction${offer.matching === 1 ? "" : "s"} match, and future imports too.`
      : "Nothing else matches yet; future imports will be labelled.";
  return (
    <div className="rule-offer" role="status">
      <div className="min0">
        {offer.existing ? (
          <>
            <b>
              Change the rule for {which}<span className="rule-pattern">{offer.pattern}</span> to {target}?
            </b>
            <span>
              Its {offer.existing.labels} label{offer.existing.labels === 1 ? "" : "s"} move along
              {offer.matching > 0 ? `, and ${offer.matching} more transaction${offer.matching === 1 ? "" : "s"} get labelled` : ""}.
            </span>
          </>
        ) : (
          <>
            <b>
              {cat ? `Always label ${which}` : "Always mark "}
              <span className="rule-pattern">{offer.pattern}</span>
              {` as ${target}?`}
            </b>
            <span>{more}</span>
          </>
        )}
      </div>
      <div className="rule-offer-btns">
        <button className="btn plain" onClick={onDone}>Not Now</button>
        {!offer.existing && (
          <button className="btn" onClick={() => { open({ kind: "rules", draft: draftOf(offer) }); onDone(); }}>Edit…</button>
        )}
        <button className="btn primary" disabled={accept.isPending} onClick={() => accept.mutate([offer])}>
          {offer.existing ? "Change Rule" : "Create Rule"}
        </button>
      </div>
    </div>
  );
}
