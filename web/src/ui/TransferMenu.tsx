import * as Popover from "@radix-ui/react-popover";
import { useState, type ReactNode } from "react";

import { api, type Account, type Tx } from "../api";
import { useSheets } from "../sheets/context";
import { useAccountRoles, useAction } from "../queries";
import { Icon } from "./Icon";

export const potIcon = (a: Account) => (/cash|contant/i.test(a.name) ? "cash" : "jar");

/**
 * Marks a transaction as a transfer and asks where the money went (or came from): one of your
 * pots, or an account you don't track. "New Pot" creates one on the spot.
 */
export function TransferMenu({
  tx,
  children,
  onDone,
}: {
  tx: Tx;
  children: ReactNode;
  /** Called after marking, with the pot chosen (null for an account you don't track). */
  onDone?: (potId: number | null) => void;
}) {
  const mark = useAction(api.createGroup, { success: "Marked as transfer", onSuccess: (g) => onDone?.(g.counterAccountId) });
  return (
    <PotMenu
      heading={tx.amount < 0 ? "Where did the money go?" : "Where did the money come from?"}
      direction={tx.amount < 0 ? "To" : "From"}
      excludeAccountIds={[tx.accountId]}
      onChoose={(potId) => mark.mutate(["transfer", null, [tx.id], potId])}
    >
      {children}
    </PotMenu>
  );
}

/** The list of pots, "an account I don't track" and "New Pot…"; calls `onChoose` with the pick. */
export function PotMenu({
  heading,
  direction,
  excludeAccountIds = [],
  onChoose,
  children,
}: {
  heading: string;
  /** "To", "From" or "To or from", before each pot's name. */
  direction: string;
  excludeAccountIds?: number[];
  onChoose: (potId: number | null) => void;
  children: ReactNode;
}) {
  const roles = useAccountRoles();
  const openSheet = useSheets();
  const [open, setOpen] = useState(false);
  const choose = (potId: number | null) => {
    setOpen(false);
    onChoose(potId);
  };
  const pots = (roles?.pots ?? []).filter((p) => !excludeAccountIds.includes(p.id));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="picker" sideOffset={6} align="start" collisionPadding={12}>
          <div className="picker-head">{heading}</div>
          <div className="picker-list" role="menu">
            {pots.map((p) => (
              <button key={p.id} type="button" role="menuitem" className="picker-item" onClick={() => choose(p.id)}>
                <span className="ci sm pot"><Icon name={potIcon(p)} /></span>
                <span>{direction} {p.name}</span>
              </button>
            ))}
            <button type="button" role="menuitem" className="picker-item" onClick={() => choose(null)}>
              <span className="ci sm xfer"><Icon name="swap" /></span>
              <span>{direction} an account I don't track</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="picker-item accent"
              onClick={() => {
                setOpen(false);
                openSheet({ kind: "pot", then: (id) => choose(id) });
              }}
            >
              <span className="ci sm none"><Icon name="plus" /></span>
              <span>New Pot…</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
