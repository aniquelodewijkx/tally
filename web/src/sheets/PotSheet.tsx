import { useState } from "react";

import { api } from "../api";
import { useAction } from "../queries";
import { Sheet } from "../ui/Sheet";

/** Creates a pot: an account you never import, such as savings or cash you keep. */
export function PotSheet({ onClose, then }: { onClose: () => void; then?: (potId: number) => void }) {
  const [name, setName] = useState("");
  const create = useAction(api.createAccount, {
    success: (a) => `${a.name} created`,
    onSuccess: (a) => {
      onClose();
      then?.(a.id);
    },
  });
  const submit = () => name.trim() && create.mutate([name.trim()]);
  return (
    <Sheet
      title="New Pot"
      subtitle="A pot is money you keep outside the accounts you import, like savings or cash. Its balance comes from the transfers you mark as going to it."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || create.isPending} onClick={submit}>Create Pot</button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="pot-name">Name</label>
        <input id="pot-name" className="field" autoFocus placeholder="Savings, Cash savings…" value={name}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </div>
    </Sheet>
  );
}
