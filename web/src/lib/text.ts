import type { Source, Tx } from "../api";

/** The name to show for a transaction. */
export function txTitle(tx: Tx): string {
  return tx.name?.trim() || tx.description.trim() || "Transaction";
}

/**
 * A short second line from the bank's long remittance text:
 * ING transfers carry "Description: …", card payments "Card no: … Time: 21:40 …".
 */
export function txSubtitle(tx: Tx): string {
  const d = tx.description.replace(/\s+/g, " ").trim();
  const desc = d.match(/Description: (.*?)(?: (?:IBAN|Reference|Value date|Mandate ID|Creditor ID|Other party|Date\/time):|$)/);
  if (desc?.[1]) return desc[1];
  if (/^Card no:/.test(d)) {
    const time = d.match(/Time: (\d{2}:\d{2})/)?.[1];
    const what = / RRN:/.test(d) ? "Cash withdrawal" : / Apple Pay/.test(d) ? "Apple Pay" : "Card payment";
    return time ? `${what} · ${time}` : what;
  }
  const rest = d
    .replace(/ ?Value date: \S+$/, "")
    .replace(/^Name: .*? (?=IBAN:)/, "")
    .replace(/^IBAN: \S+ ?/, "")
    .trim();
  return rest === txTitle(tx) ? "" : rest;
}

/** Folds a counterparty name to what stays the same across payments: "ALBERT HEIJN 1234 AMSTERDAM" -> "albert heijn". */
export function counterpartyKey(tx: Tx): string {
  return txTitle(tx)
    .toLowerCase()
    .replace(/[^a-zÀ-ɏ ]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 2)
    .join(" ");
}

export interface DetectedExport {
  source: Source;
  bank: string;
  rows: number;
  from: string | null;
  to: string | null;
}

/** Recognises an ING or AMEX export from its header row, without parsing the whole file. */
export function detectExport(text: string): DetectedExport | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0] ?? "";
  let dates: string[];
  let source: Source;
  let bank: string;
  if (header.startsWith('"Date","Name / Description"')) {
    source = "ing_csv";
    bank = "ING";
    dates = lines.slice(1).map((l) => l.slice(1, 9)).filter((s) => /^\d{8}$/.test(s)).map((s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`);
  } else if (header.startsWith("Datum,Omschrijving,Bedrag")) {
    source = "amex_csv";
    bank = "American Express";
    dates = lines
      .slice(1)
      .map((l) => l.split(",")[0].match(/^(\d{2})\/(\d{2})\/(\d{4})$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => `${m[3]}-${m[1]}-${m[2]}`);
  } else {
    return null;
  }
  const sorted = [...dates].sort();
  return { source, bank, rows: lines.length - 1, from: sorted[0] ?? null, to: sorted[sorted.length - 1] ?? null };
}

/**
 * The pattern to offer for an "Always label…" rule: the name in lowercase, up to the first word
 * with a digit, at most two words. "ALBERT HEIJN 1001 AMSTERDAM" -> "albert heijn".
 */
export function suggestPattern(tx: Tx): string {
  const words = txTitle(tx).toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (/\d/.test(w) || out.length === 2) break;
    out.push(w);
  }
  return out.join(" ") || words[0] || "";
}
