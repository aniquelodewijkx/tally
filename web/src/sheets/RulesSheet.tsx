import { useEffect, useMemo, useState } from "react";

import { api, type CategoryKind, type MatchState, type Rule, type RuleDirection, type RuleDraft, type RuleScope } from "../api";
import { txVisual, type CatIndex } from "../lib/categories";
import { groupRules, subcategoryLabel, type RuleGroup } from "../lib/rules";
import { money, parseMoney, shortDate } from "../lib/format";
import { txTitle } from "../lib/text";
import { useAccountRoles, useAction, useCats, useRulePreview, useRules } from "../queries";
import { CategoryPicker } from "../ui/CategoryPicker";
import { Amount, CategoryIcon, Empty, Segmented, TxIcon } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { potIcon } from "../ui/TransferMenu";
import { Sheet } from "../ui/Sheet";

const DIRECTIONS: { value: string; label: string }[] = [
  { value: "", label: "Money in and out" },
  { value: "out", label: "Money out" },
  { value: "in", label: "Money in" },
];
const toDirection = (v: string): RuleDirection => (v === "out" ? "out" : v === "in" ? "in" : null);

type TargetKind = "category" | "pot";
type Target = { kind: TargetKind; categoryId: number | null; potId: number | null };

const targetOf = (d?: { categoryId?: number | null; potId?: number | null }): Target =>
  d?.potId != null
    ? { kind: "pot", categoryId: null, potId: d.potId }
    : { kind: "category", categoryId: d?.categoryId ?? null, potId: null };
const targetReady = (t: Target) => (t.kind === "category" ? t.categoryId != null : t.potId != null);
const targetDraft = (t: Target) =>
  t.kind === "category" ? { categoryId: t.categoryId, potId: null } : { categoryId: null, potId: t.potId };

/** "" -> no limit; otherwise a size in cents, or "invalid". */
const parseLimit = (text: string): number | null | "invalid" => {
  if (!text.trim()) return null;
  const v = parseMoney(text);
  return v == null || v < 0 ? "invalid" : Math.abs(v);
};
const limitText = (cents: number | null | undefined) => (cents == null ? "" : money(cents));

function amountLabel(min: number | null, max: number | null): string | null {
  if (min != null && max != null) return `${money(min)} – ${money(max)}`;
  if (min != null) return `≥ ${money(min)}`;
  if (max != null) return `≤ ${money(max)}`;
  return null;
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Lists the auto-label rules, grouped by category (then pots), and adds, edits or deletes them. */
export function RulesSheet({ onClose, draft, focus }: { onClose: () => void; draft?: RuleDraft; focus?: number }) {
  const cats = useCats();
  const rules = useRules().data;
  const roles = useAccountRoles();
  const [editing, setEditing] = useState<number | null>(focus ?? null);
  const [open, setOpen] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const remove = useAction(api.deleteRule, { success: "Rule deleted. Its labels stay." });

  if (!cats || !rules || !roles) return null;
  const groups = groupRules(rules, cats, roles.name, query);

  return (
    <Sheet
      title="Rules"
      subtitle="A rule labels transactions whose counterparty contains its text, with a category or as a transfer to a pot. Rules only fill in transactions you haven't handled; your own choices always win."
      onClose={onClose}
      wide
      footer={<button className="btn primary" onClick={onClose}>Done</button>}
    >
      <RuleForm cats={cats} initial={draft} key={draft ? `${draft.pattern}-${draft.categoryId}-${draft.potId}` : "new"} />
      {rules.length === 0 ? (
        <Empty title="No rules yet">Categorize a transaction or mark it as a transfer, then accept "Always…", or add one above.</Empty>
      ) : (
        <>
          <div className="rules-toolbar">
            <span className="muted">{rules.length} rule{rules.length === 1 ? "" : "s"} · {rules.reduce((n, r) => n + r.labels, 0)} labels</span>
            <span className="spacer" />
            {rules.length > 6 && (
              <div className="field with-icon rules-filter">
                <Icon name="search" />
                <input id="rules-filter" aria-label="Filter rules" placeholder="Filter rules or categories" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            )}
          </div>
          {groups.length === 0 && <div className="coverage-empty">No rule or category matches "{query}".</div>}
          {groups.map((g) => (
            <section className="rule-group" key={g.key} aria-label={g.title}>
              <div className="rule-group-head">
                <GroupIcon group={g} cats={cats} />
                <b className="min0 ellipsis">{g.potId != null ? `Transfer to or from ${g.title}` : g.title}</b>
                <span className="muted">{g.rules.length} rule{g.rules.length === 1 ? "" : "s"} · {g.labels} label{g.labels === 1 ? "" : "s"}</span>
              </div>
              <div className="tree rules-list">
                {g.rules.map((r) =>
                  editing === r.id ? (
                    <RuleEditor key={r.id} rule={r} cats={cats} onDone={() => setEditing(null)} />
                  ) : (
                    <div key={r.id} className={`rule-item ${open === r.id ? "open" : ""}`}>
                      <div className="grow">
                        <button className="rule-summary grow-1 min0" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                          <Icon name="right" className={`chev disclosure ${open === r.id ? "turned" : ""}`} />
                          <span className="min0">
                            <span className="rule-pattern">{r.pattern}</span>
                            {subcategoryLabel(r, cats) && <span className="muted"> → {subcategoryLabel(r, cats)}</span>}
                            {r.direction && <span className="tag xfer scope">{r.direction === "out" ? "Money out" : "Money in"}</span>}
                            {amountLabel(r.minAmount, r.maxAmount) && <span className="tag xfer scope num">{amountLabel(r.minAmount, r.maxAmount)}</span>}
                            {r.accountId != null && <span className="tag xfer scope">{roles.name(r.accountId)}</span>}
                          </span>
                        </button>
                        <span className="v num">{r.labels} label{r.labels === 1 ? "" : "s"}</span>
                        <button className="icon-btn" aria-label={`Edit rule ${r.pattern}`} onClick={() => setEditing(r.id)}><Icon name="pencil" /></button>
                        <button className="icon-btn danger" aria-label={`Delete rule ${r.pattern}`} onClick={() => remove.mutate([r.id])}><Icon name="trash" /></button>
                      </div>
                      {open === r.id && (
                        <div className="rule-coverage">
                          <Coverage
                            cats={cats}
                            scope={{ pattern: r.pattern, direction: r.direction, accountId: r.accountId, minAmount: r.minAmount, maxAmount: r.maxAmount }}
                            ruleId={r.id}
                          />
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
            </section>
          ))}
        </>
      )}
    </Sheet>
  );
}

function GroupIcon({ group, cats }: { group: RuleGroup; cats: CatIndex }) {
  const roles = useAccountRoles();
  if (group.potId != null) {
    const pot = roles?.all.find((a) => a.id === group.potId);
    return <span className="ci sm pot"><Icon name={pot ? potIcon(pot) : "jar"} /></span>;
  }
  const cat = group.categoryId != null ? cats.byId.get(group.categoryId) : undefined;
  return cat ? <CategoryIcon cat={cat} size="sm" /> : <span className="ci sm none"><Icon name="q" /></span>;
}

const STATE_LABEL: Record<MatchState, string> = { "will-label": "Will label", "this-rule": "This rule", handled: "Handled" };

/**
 * Every transaction a rule matches, scrollable, each marked with what the rule does with it:
 * label it, it already did (when previewing a saved rule), or leave it alone.
 */
function Coverage({ cats, scope, ruleId }: { cats: CatIndex; scope: RuleScope; ruleId?: number }) {
  const roles = useAccountRoles();
  const debounced = useDebounced(scope);
  const { data, isFetching } = useRulePreview(debounced, ruleId);
  const [filter, setFilter] = useState<MatchState | "all">("all");
  const shown = useMemo(() => (data?.matches ?? []).filter((m) => filter === "all" || m.state === filter), [data, filter]);
  if (!scope.pattern.trim()) return null;
  if (!data) return <div className="coverage-empty">Looking for matches…</div>;
  const total = data.willLabel + data.labelledByRule + data.handled;
  if (total === 0) return <div className="coverage-empty">No transactions match yet. Future imports will be checked.</div>;

  const options: { value: MatchState | "all"; label: string }[] = [{ value: "all", label: `All ${total}` }];
  if (data.willLabel) options.push({ value: "will-label", label: `Will label ${data.willLabel}` });
  if (data.labelledByRule) options.push({ value: "this-rule", label: `This rule ${data.labelledByRule}` });
  if (data.handled) options.push({ value: "handled", label: `Handled ${data.handled}` });

  return (
    <div className={`coverage ${isFetching ? "refreshing" : ""}`}>
      <div className="coverage-head">
        <Segmented label="Show" value={options.some((o) => o.value === filter) ? filter : "all"} options={options} onChange={setFilter} />
        {data.matches.length < total && <span className="hint">Newest {data.matches.length} shown</span>}
      </div>
      <div className="coverage-list" role="list">
        {shown.map(({ tx, state }) => {
          const v = txVisual(tx, cats);
          return (
            <div className="coverage-row" role="listitem" key={tx.id}>
              <span className="date num">{shortDate(tx.date)} {tx.date.slice(2, 4)}</span>
              <TxIcon tx={tx} cats={cats} size="sm" />
              <span className="min0 grow-1">
                <span className="nm ellipsis">{txTitle(tx)}</span>
                <span className="sub ellipsis">
                  {roles?.name(tx.accountId)}
                  {v.kind === "category" && state !== "will-label" ? ` · ${v.cat.path}` : v.kind === "transfer" ? " · Transfer" : ""}
                </span>
              </span>
              <Amount cents={tx.amount} className="amt" />
              <span className={`state ${state}`}>{STATE_LABEL[state]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Category or pot, with a switch between the two. */
function TargetField({ cats, value, onChange, direction }: { cats: CatIndex; value: Target; onChange: (t: Target) => void; direction: RuleDirection }) {
  const roles = useAccountRoles();
  const pots = roles?.pots ?? [];
  const defaultKind: CategoryKind = direction === "in" ? "income" : "expense";
  const cat = value.categoryId != null ? cats.byId.get(value.categoryId) : undefined;
  return (
    <>
      <Segmented
        label="What the rule does"
        value={value.kind}
        options={[{ value: "category", label: "Category" }, { value: "pot", label: "Transfer to pot" }]}
        onChange={(kind) => onChange({ ...value, kind })}
      />
      {value.kind === "category" ? (
        <CategoryPicker cats={cats} onPick={(id) => onChange({ ...value, categoryId: id })} defaultKind={defaultKind}>
          <button type="button" className="field picker-trigger">
            {cat ? <><CategoryIcon cat={cat} size="sm" />{cat.path}</> : <span className="placeholder">Choose category</span>}
          </button>
        </CategoryPicker>
      ) : pots.length === 0 ? (
        <span className="hint">Create a pot first with + under Savings &amp; Cash in the sidebar.</span>
      ) : (
        <select className="field" aria-label="Pot" value={value.potId ?? ""} onChange={(e) => onChange({ ...value, potId: e.target.value ? Number(e.target.value) : null })}>
          <option value="" disabled>Choose pot</option>
          {pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    </>
  );
}

/** Optional amount range: "between [min] and [max] euro", on the amount's size. */
function AmountRange({ min, max, onMin, onMax }: { min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void }) {
  return (
    <span className="amount-range">
      <span className="muted">Amount</span>
      <input className={`field money num ${parseLimit(min) === "invalid" ? "invalid" : ""}`} inputMode="decimal" aria-label="Minimum amount" placeholder="min" value={min} onChange={(e) => onMin(e.target.value)} />
      <span className="muted">–</span>
      <input className={`field money num ${parseLimit(max) === "invalid" ? "invalid" : ""}`} inputMode="decimal" aria-label="Maximum amount" placeholder="max" value={max} onChange={(e) => onMax(e.target.value)} />
    </span>
  );
}

function rangeProblem(min: number | null | "invalid", max: number | null | "invalid"): string | null {
  if (min === "invalid" || max === "invalid") return "Enter amounts like 12,50.";
  if (min != null && max != null && min > max) return "The minimum is larger than the maximum.";
  return null;
}

function RuleForm({ cats, initial }: { cats: CatIndex; initial?: RuleDraft }) {
  const [pattern, setPattern] = useState(initial?.pattern ?? "");
  const [target, setTarget] = useState<Target>(() => targetOf(initial));
  const [direction, setDirection] = useState<RuleDirection>(initial?.direction ?? null);
  const [minText, setMinText] = useState(limitText(initial?.minAmount));
  const [maxText, setMaxText] = useState(limitText(initial?.maxAmount));
  const [apply, setApply] = useState(true);
  const min = parseLimit(minText);
  const max = parseLimit(maxText);
  const problem = rangeProblem(min, max);
  const scope: RuleScope = { pattern, direction, minAmount: typeof min === "number" ? min : null, maxAmount: typeof max === "number" ? max : null };
  const preview = useRulePreview(useDebounced(scope), null, !problem).data;
  const create = useAction(api.createRule, {
    success: (r) => (r.labelled ? `Rule created · ${r.labelled} labelled` : "Rule created"),
    onSuccess: () => {
      setPattern("");
      setTarget(targetOf());
      setDirection(null);
      setMinText("");
      setMaxText("");
    },
  });
  const ready = pattern.trim() && targetReady(target) && !problem;
  return (
    <div className="rule-form">
      <div className="rule-form-row">
        <input id="rule-pattern" className="field grow-1" placeholder="Counterparty contains… (e.g. albert heijn)" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <select className="field" aria-label="Which money" value={direction ?? ""} onChange={(e) => setDirection(toDirection(e.target.value))}>
          {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <AmountRange min={minText} max={maxText} onMin={setMinText} onMax={setMaxText} />
      </div>
      <div className="rule-form-row">
        <TargetField cats={cats} value={target} onChange={setTarget} direction={direction} />
      </div>
      {pattern.trim() && !problem && <Coverage cats={cats} scope={scope} />}
      <div className="rule-form-row">
        <label className="check-label">
          <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
          {preview && pattern.trim() ? `Also label the ${preview.willLabel} matching transaction${preview.willLabel === 1 ? "" : "s"} now` : "Also label matching transactions now"}
        </label>
        <span className="spacer" />
        {problem && <span className="error-text">{problem}</span>}
        <button className="btn primary" disabled={!ready || create.isPending}
          onClick={() => create.mutate([{ pattern, direction, minAmount: scope.minAmount, maxAmount: scope.maxAmount, ...targetDraft(target) }, apply])}>
          <Icon name="plus" />Add Rule
        </button>
      </div>
    </div>
  );
}

function RuleEditor({ rule, cats, onDone }: { rule: Rule; cats: CatIndex; onDone: () => void }) {
  const [pattern, setPattern] = useState(rule.pattern);
  const [target, setTarget] = useState<Target>(() => targetOf(rule));
  const [direction, setDirection] = useState<RuleDirection>(rule.direction);
  const [minText, setMinText] = useState(limitText(rule.minAmount));
  const [maxText, setMaxText] = useState(limitText(rule.maxAmount));
  const min = parseLimit(minText);
  const max = parseLimit(maxText);
  const problem = rangeProblem(min, max);
  const scope: RuleScope = { pattern, direction, accountId: rule.accountId, minAmount: typeof min === "number" ? min : null, maxAmount: typeof max === "number" ? max : null };
  const update = useAction(api.updateRule, { success: "Rule updated", onSuccess: onDone });
  return (
    <div className="rule-item open">
      <div className="grow editing">
        <input className="field grow-1" aria-label="Pattern" value={pattern} autoFocus onChange={(e) => setPattern(e.target.value)} />
        <select className="field" aria-label="Which money" value={direction ?? ""} onChange={(e) => setDirection(toDirection(e.target.value))}>
          {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <AmountRange min={minText} max={maxText} onMin={setMinText} onMax={setMaxText} />
        <TargetField cats={cats} value={target} onChange={setTarget} direction={direction} />
        {problem && <span className="error-text">{problem}</span>}
        <button className="btn primary" disabled={!pattern.trim() || !targetReady(target) || !!problem || update.isPending}
          onClick={() => update.mutate([rule.id, { pattern, direction, accountId: rule.accountId, minAmount: scope.minAmount, maxAmount: scope.maxAmount, ...targetDraft(target) }])}>Save</button>
        <button className="icon-btn" aria-label="Cancel" onClick={onDone}><Icon name="x" /></button>
      </div>
      {pattern.trim() && !problem && (
        <div className="rule-coverage">
          <Coverage cats={cats} scope={scope} ruleId={rule.id} />
        </div>
      )}
    </div>
  );
}
