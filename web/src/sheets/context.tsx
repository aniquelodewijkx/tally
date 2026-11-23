import { createContext, useContext, useState, type ReactNode } from "react";

import type { RuleDraft, Tx } from "../api";
import { CategoriesSheet } from "./CategoriesSheet";
import { ImportSheet } from "./ImportSheet";
import { LinkSheet } from "./LinkSheet";
import { PotSheet } from "./PotSheet";
import { RulesSheet } from "./RulesSheet";
import { SplitSheet } from "./SplitSheet";

export type SheetState =
  | { kind: "import" }
  | { kind: "categories" }
  | { kind: "split"; tx: Tx }
  | { kind: "link"; tx: Tx }
  | { kind: "pot"; then?: (potId: number) => void }
  | { kind: "rules"; draft?: RuleDraft; focus?: number }
  | null;

const SheetContext = createContext<(s: SheetState) => void>(() => {});

/** Opens one of the app's sheets. */
export const useSheets = () => useContext(SheetContext);

export const anySheetOpen = () => !!document.querySelector(".sheet, .picker");

export function SheetHost({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<SheetState>(null);
  const close = () => setSheet(null);
  return (
    <SheetContext.Provider value={setSheet}>
      {children}
      {sheet?.kind === "import" && <ImportSheet onClose={close} />}
      {sheet?.kind === "categories" && <CategoriesSheet onClose={close} />}
      {sheet?.kind === "split" && <SplitSheet tx={sheet.tx} onClose={close} />}
      {sheet?.kind === "link" && <LinkSheet tx={sheet.tx} onClose={close} />}
      {sheet?.kind === "pot" && <PotSheet onClose={close} then={sheet.then} />}
      {sheet?.kind === "rules" && <RulesSheet onClose={close} draft={sheet.draft} focus={sheet.focus} />}
    </SheetContext.Provider>
  );
}
