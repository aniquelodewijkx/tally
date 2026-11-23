// The only module that talks to the backend. It converts the generated protobuf types (int64 as
// bigint, enums as numbers, optional fields) into plain domain types the rest of the app uses.

import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";

import { AccountService, type Account as PbAccount } from "./gen/finance/accounts_pb";
import {
  CategoryKind as PbCategoryKind,
  CategoryService,
  type Category as PbCategory,
} from "./gen/finance/categories_pb";
import type { Date as PbDate } from "./gen/finance/common_pb";
import { ImportService, type ImportBatch as PbBatch } from "./gen/finance/imports_pb";
import { LinkKind as PbLinkKind, LinkService, type LinkGroup as PbGroup } from "./gen/finance/links_pb";
import { Direction, ReportService } from "./gen/finance/reports_pb";
import { RuleDirection as PbRuleDirection, RuleMatchState, RuleService, type Rule as PbRule } from "./gen/finance/rules_pb";
import { TransactionService, type Transaction as PbTransaction } from "./gen/finance/transactions_pb";

const transport = createGrpcWebTransport({ baseUrl: window.location.origin });
const accounts = createClient(AccountService, transport);
const categories = createClient(CategoryService, transport);
const imports = createClient(ImportService, transport);
const links = createClient(LinkService, transport);
const reports = createClient(ReportService, transport);
const rules = createClient(RuleService, transport);
const transactions = createClient(TransactionService, transport);

// ---------- domain types ----------

export type CategoryKind = "expense" | "income";
export type LinkKind = "transfer" | "reimbursement";
export type Source = "ing_csv" | "amex_csv";
export type RuleDirection = "out" | "in" | null;

export interface Account {
  id: number;
  name: string;
}

export interface Category {
  id: number;
  parentId: number | null;
  name: string;
  kind: CategoryKind;
}

export interface Split {
  categoryId: number;
  /** Signed cents, same sign as the transaction. */
  amount: number;
}

export interface Tx {
  id: number;
  accountId: number;
  batchId: number;
  /** ISO booking date. */
  date: string;
  /** Signed cents; negative means money left the account. */
  amount: number;
  name: string | null;
  iban: string | null;
  description: string;
  groupId: number | null;
  linkKind: LinkKind | null;
  linkTitle: string | null;
  /** For a one-sided transfer: the pot (an account that isn't imported) on its other side. */
  linkCounterAccountId: number | null;
  notes: string | null;
  /** Empty means uncategorized. */
  splits: Split[];
  /** Set when a rule labelled this transaction. */
  ruleId: number | null;
}

export interface TxFilter {
  accountId?: number;
  from?: string;
  to?: string;
  uncategorizedOnly?: boolean;
  groupId?: number;
  search?: string;
  /** A pot's activity: one-sided transfers whose other side is this account. */
  counterAccountId?: number;
}

export interface Group {
  id: number;
  kind: LinkKind;
  title: string | null;
  txIds: number[];
  counterAccountId: number | null;
}

export interface Batch {
  id: number;
  accountId: number;
  source: string;
  fileName: string | null;
  inserted: number;
  duplicates: number;
  importedAt: Date | null;
}

export interface ImportResult {
  batch: Batch;
  alreadyImported: boolean;
  /** New transactions that rules labelled. */
  autoLabelled: number;
}

export interface Rule {
  id: number;
  pattern: string;
  /** The target: a category, or a pot (transfer). Exactly one is set. */
  categoryId: number | null;
  potId: number | null;
  direction: RuleDirection;
  accountId: number | null;
  /** Amount size range in cents, inclusive; null for no limit. */
  minAmount: number | null;
  maxAmount: number | null;
  labels: number;
}

/** What a rule matches, without its target. */
export interface RuleScope {
  pattern: string;
  direction: RuleDirection;
  accountId?: number | null;
  minAmount?: number | null;
  maxAmount?: number | null;
}

export type MatchState = "will-label" | "this-rule" | "handled";

export interface RulePreview {
  willLabel: number;
  labelledByRule: number;
  handled: number;
  matches: { tx: Tx; state: MatchState }[];
}

export interface RuleDraft {
  pattern: string;
  /** Exactly one of categoryId and potId. */
  categoryId?: number | null;
  potId?: number | null;
  direction: RuleDirection;
  accountId?: number | null;
  minAmount?: number | null;
  maxAmount?: number | null;
}

export interface Total {
  year: number;
  month: number;
  /** Set for a category; null for the uncategorized buckets. */
  categoryId: number | null;
  bucket: "in" | "out" | null;
  amount: number;
  spent: number;
  received: number;
}

export interface TransferSuggestion {
  outgoingId: number;
  incomingId: number;
}

// ---------- conversions ----------

const num = (v: bigint) => Number(v);
const optNum = (v: bigint | undefined) => (v === undefined ? null : Number(v));
const big = (v: number) => BigInt(v);
const optBig = (v: number | null | undefined) => (v == null ? undefined : BigInt(v));
const tsDate = (t: Timestamp | undefined) => (t ? timestampDate(t) : null);

export function toPbDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

function fromPbDate(d: PbDate | undefined): string {
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.year}-${p(d.month)}-${p(d.day)}`;
}

const linkKindFromPb = (k: PbLinkKind | undefined): LinkKind | null =>
  k === PbLinkKind.TRANSFER ? "transfer" : k === PbLinkKind.REIMBURSEMENT ? "reimbursement" : null;
const linkKindToPb = (k: LinkKind) => (k === "transfer" ? PbLinkKind.TRANSFER : PbLinkKind.REIMBURSEMENT);

const toAccount = (a: PbAccount): Account => ({ id: num(a.id), name: a.name });

const toCategory = (c: PbCategory): Category => ({
  id: num(c.id),
  parentId: optNum(c.parentId),
  name: c.name,
  kind: c.kind === PbCategoryKind.INCOME ? "income" : "expense",
});

const toTx = (t: PbTransaction): Tx => ({
  id: num(t.id),
  accountId: num(t.accountId),
  batchId: num(t.importBatchId),
  date: fromPbDate(t.bookedOn),
  amount: num(t.amountCents),
  name: t.counterpartyName ?? null,
  iban: t.counterpartyIban ?? null,
  description: t.description,
  groupId: optNum(t.linkGroupId),
  linkKind: linkKindFromPb(t.linkKind),
  linkTitle: t.linkTitle ?? null,
  linkCounterAccountId: optNum(t.linkCounterAccountId),
  notes: t.notes ?? null,
  splits: t.splits.map((s) => ({ categoryId: num(s.categoryId), amount: num(s.amountCents) })),
  ruleId: optNum(t.ruleId),
});

const directionToPb = (d: RuleDirection) => (d === "out" ? PbRuleDirection.OUT : d === "in" ? PbRuleDirection.IN : PbRuleDirection.UNSPECIFIED);
const toRule = (r: PbRule): Rule => ({
  id: num(r.id),
  pattern: r.pattern,
  categoryId: optNum(r.categoryId),
  potId: optNum(r.counterAccountId),
  direction: r.direction === PbRuleDirection.OUT ? "out" : r.direction === PbRuleDirection.IN ? "in" : null,
  accountId: optNum(r.accountId),
  minAmount: optNum(r.minAmountCents),
  maxAmount: optNum(r.maxAmountCents),
  labels: num(r.labels),
});
const matchState = (s: RuleMatchState): MatchState =>
  s === RuleMatchState.WILL_LABEL ? "will-label" : s === RuleMatchState.LABELLED_BY_RULE ? "this-rule" : "handled";

const toGroup = (g: PbGroup): Group => ({
  id: num(g.id),
  kind: linkKindFromPb(g.kind) ?? "reimbursement",
  title: g.title ?? null,
  txIds: g.transactionIds.map(num),
  counterAccountId: optNum(g.counterAccountId),
});

const toBatch = (b: PbBatch): Batch => ({
  id: num(b.id),
  accountId: num(b.accountId),
  source: b.source,
  fileName: b.fileName ?? null,
  inserted: b.inserted,
  duplicates: b.duplicates,
  importedAt: tsDate(b.importedAt),
});

/** A message for people: the server's own text for expected errors. */
export function errorMessage(e: unknown): string {
  if (e instanceof ConnectError) {
    return e.code === 14 /* unavailable */ ? "Can't reach the server. Is the Tally server running?" : e.rawMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------- calls ----------

export const api = {
  listAccounts: async () => (await accounts.listAccounts({})).accounts.map(toAccount),
  createAccount: async (name: string) => toAccount((await accounts.createAccount({ name })).account!),
  renameAccount: async (id: number, name: string) =>
    toAccount((await accounts.updateAccount({ id: big(id), name })).account!),

  listCategories: async () => (await categories.listCategories({})).categories.map(toCategory),
  createCategory: async (parentId: number | null, name: string, kind: CategoryKind) =>
    toCategory(
      (
        await categories.createCategory({
          parentId: optBig(parentId),
          name,
          kind: kind === "income" ? PbCategoryKind.INCOME : PbCategoryKind.EXPENSE,
        })
      ).category!,
    ),
  updateCategory: async (id: number, name: string, parentId: number | null) =>
    toCategory((await categories.updateCategory({ id: big(id), name, parentId: optBig(parentId) })).category!),
  deleteCategory: async (id: number) => {
    await categories.deleteCategory({ id: big(id) });
  },

  listTransactions: async (f: TxFilter) =>
    (
      await transactions.listTransactions({
        filter: {
          accountId: optBig(f.accountId),
          bookedFrom: f.from ? toPbDate(f.from) : undefined,
          bookedTo: f.to ? toPbDate(f.to) : undefined,
          uncategorizedOnly: f.uncategorizedOnly ?? false,
          linkGroupId: optBig(f.groupId),
          search: f.search?.trim() || undefined,
          counterAccountId: optBig(f.counterAccountId),
        },
      })
    ).transactions.map(toTx),
  setSplits: async (txId: number, splits: Split[]) =>
    toTx(
      (
        await transactions.setSplits({
          transactionId: big(txId),
          splits: splits.map((s) => ({ categoryId: big(s.categoryId), amountCents: big(s.amount) })),
        })
      ).transaction!,
    ),
  /** One category for each transaction's whole amount, or none; transfers and zero amounts are skipped. */
  setCategory: async (txIds: number[], categoryId: number | null) => {
    const r = await transactions.setCategory({ transactionIds: txIds.map(big), categoryId: optBig(categoryId) });
    return { updated: Number(r.updated), skipped: Number(r.skipped) };
  },
  setNotes: async (txId: number, notes: string) =>
    toTx((await transactions.setNotes({ transactionId: big(txId), notes })).transaction!),

  getGroup: async (id: number) => toGroup((await links.getGroup({ id: big(id) })).group!),
  suggestTransfers: async (): Promise<TransferSuggestion[]> =>
    (await links.suggestTransfers({})).suggestions.map((s) => ({
      outgoingId: num(s.outgoingId),
      incomingId: num(s.incomingId),
    })),
  /** `counterAccountId`: only for a one-sided transfer, the pot on its other side. */
  createGroup: async (kind: LinkKind, title: string | null, txIds: number[], counterAccountId?: number | null) =>
    toGroup(
      (
        await links.createGroup({
          kind: linkKindToPb(kind),
          title: title ?? undefined,
          transactionIds: txIds.map(big),
          counterAccountId: optBig(counterAccountId),
        })
      ).group!,
    ),
  /** Each transaction becomes its own one-sided transfer to or from a pot (or an untracked account). */
  markTransfers: async (txIds: number[], potId: number | null) => {
    const r = await links.markTransfers({ transactionIds: txIds.map(big), counterAccountId: optBig(potId) });
    return { updated: Number(r.updated), skipped: Number(r.skipped) };
  },
  updateGroupMembers: async (groupId: number, add: number[], remove: number[]) =>
    toGroup(
      (
        await links.updateGroupMembers({
          groupId: big(groupId),
          addTransactionIds: add.map(big),
          removeTransactionIds: remove.map(big),
        })
      ).group!,
    ),
  deleteGroup: async (id: number) => {
    await links.deleteGroup({ id: big(id) });
  },

  importFile: async (accountId: number, source: Source, fileName: string, content: Uint8Array): Promise<ImportResult> => {
    const r = await imports.importFile({ accountId: big(accountId), source, fileName, content });
    return { batch: toBatch(r.batch!), alreadyImported: r.alreadyImported, autoLabelled: num(r.autoLabelled) };
  },
  listBatches: async () => (await imports.listBatches({})).batches.map(toBatch),
  undoBatch: async (batchId: number) => {
    await imports.undoBatch({ batchId: big(batchId) });
  },

  listRules: async () => (await rules.listRules({})).rules.map(toRule),
  previewRule: async (scope: RuleScope, ruleId?: number | null): Promise<RulePreview> => {
    const r = await rules.previewRule({
      pattern: scope.pattern,
      direction: directionToPb(scope.direction),
      accountId: optBig(scope.accountId),
      minAmountCents: optBig(scope.minAmount),
      maxAmountCents: optBig(scope.maxAmount),
      ruleId: optBig(ruleId),
    });
    return {
      willLabel: num(r.willLabel),
      labelledByRule: num(r.labelledByRule),
      handled: num(r.handled),
      matches: r.matches.map((m) => ({ tx: toTx(m.transaction!), state: matchState(m.state) })),
    };
  },
  createRule: async (d: RuleDraft, applyToExisting: boolean) => {
    const r = await rules.createRule({
      pattern: d.pattern,
      categoryId: optBig(d.categoryId),
      counterAccountId: optBig(d.potId),
      direction: directionToPb(d.direction),
      accountId: optBig(d.accountId),
      minAmountCents: optBig(d.minAmount),
      maxAmountCents: optBig(d.maxAmount),
      applyToExisting,
    });
    return { rule: toRule(r.rule!), labelled: num(r.labelled) };
  },
  updateRule: async (id: number, d: RuleDraft) =>
    toRule(
      (
        await rules.updateRule({
          id: big(id),
          pattern: d.pattern,
          categoryId: optBig(d.categoryId),
          counterAccountId: optBig(d.potId),
          direction: directionToPb(d.direction),
          accountId: optBig(d.accountId),
          minAmountCents: optBig(d.minAmount),
          maxAmountCents: optBig(d.maxAmount),
        })
      ).rule!,
    ),
  deleteRule: async (id: number) => {
    await rules.deleteRule({ id: big(id) });
  },

  categoryTotals: async (from: string, to: string): Promise<Total[]> =>
    (await reports.categoryTotals({ from: toPbDate(from), to: toPbDate(to) })).totals.map((t) => ({
      year: t.year,
      month: t.month,
      categoryId: t.target.case === "categoryId" ? num(t.target.value) : null,
      bucket: t.target.case === "uncategorized" ? (t.target.value === Direction.IN ? "in" : "out") : null,
      amount: num(t.amountCents),
      spent: num(t.spentCents),
      received: num(t.receivedCents),
    })),
};
