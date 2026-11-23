import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { api, errorMessage, type TxFilter } from "./api";
import { indexCategories, type CatIndex } from "./lib/categories";
import { useToast } from "./ui/toast";

// Single user and small data: every write simply refetches everything on screen.

export const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });

export const useBatches = () => useQuery({ queryKey: ["batches"], queryFn: api.listBatches });

/**
 * Accounts split by role: banks and cards you import, and pots (savings, cash) you never import,
 * whose activity is the transfers that point to them.
 */
export function useAccountRoles() {
  const accounts = useAccounts().data;
  const batches = useBatches().data;
  return useMemo(() => {
    if (!accounts || !batches) return undefined;
    const imported = new Set(batches.map((b) => b.accountId));
    return {
      all: accounts,
      banks: accounts.filter((a) => imported.has(a.id)),
      pots: accounts.filter((a) => !imported.has(a.id)),
      name: (id: number) => accounts.find((a) => a.id === id)?.name ?? "",
    };
  }, [accounts, batches]);
}

export const useCategoryList = () => useQuery({ queryKey: ["categories"], queryFn: api.listCategories });

/** The category tree with colors and icons; undefined while loading. */
export function useCats(): CatIndex | undefined {
  const { data } = useCategoryList();
  return useMemo(() => (data ? indexCategories(data) : undefined), [data]);
}

export const useTransactions = (filter: TxFilter, enabled = true) =>
  useQuery({
    queryKey: ["transactions", filter],
    queryFn: () => api.listTransactions(filter),
    placeholderData: keepPreviousData,
    enabled,
  });

/** Everything ever imported: the history quick picks learn from. */
export const useAllTransactions = () => useTransactions({});

export const useUncategorized = () => useTransactions({ uncategorizedOnly: true });

export const useTotals = (from: string, to: string) =>
  useQuery({
    queryKey: ["totals", from, to],
    queryFn: () => api.categoryTotals(from, to),
    placeholderData: keepPreviousData,
  });

export const useRules = () => useQuery({ queryKey: ["rules"], queryFn: api.listRules });

export const useRulePreview = (scope: import("./api").RuleScope, ruleId?: number | null, enabled = true) =>
  useQuery({
    queryKey: ["rule-preview", { ...scope, pattern: scope.pattern.trim().toLowerCase() }, ruleId ?? null],
    queryFn: () => api.previewRule(scope, ruleId),
    enabled: enabled && scope.pattern.trim().length > 0,
    placeholderData: keepPreviousData,
  });

export const useTransferSuggestions = () => useQuery({ queryKey: ["suggestions"], queryFn: api.suggestTransfers });

export const useGroup = (id: number | null) =>
  useQuery({ queryKey: ["group", id], queryFn: () => api.getGroup(id!), enabled: id != null });

/** A write: shows errors as a toast and refreshes all data on success. */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { success?: string | ((r: R) => string); onSuccess?: (r: R) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: async (r) => {
      opts.onSuccess?.(r);
      if (opts.success) toast(typeof opts.success === "string" ? opts.success : opts.success(r));
      await qc.invalidateQueries();
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
}
