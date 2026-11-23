import { useNavigate } from "@tanstack/react-router";
import { useState, type DragEvent } from "react";

import { api, type ImportResult } from "../api";
import { shortDate } from "../lib/format";
import { detectExport, type DetectedExport } from "../lib/text";
import { useAccountRoles, useAction } from "../queries";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";

type Picked = { name: string; bytes: Uint8Array; detected: DetectedExport | null };

export function ImportSheet({ onClose }: { onClose: () => void }) {
  // Pots are never imported, so only banks and cards are offered.
  const accounts = useAccountRoles()?.banks ?? [];
  const navigate = useNavigate();
  const [file, setFile] = useState<Picked | null>(null);
  const [accountId, setAccountId] = useState<number | "new">("new");
  const [newName, setNewName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const createAccount = useAction(api.createAccount);
  const importFile = useAction(api.importFile, { onSuccess: setResult });
  const undo = useAction(api.undoBatch, { success: "Import undone", onSuccess: () => setResult(null) });

  async function pick(f: File | undefined) {
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const detected = detectExport(new TextDecoder().decode(bytes.subarray(0, 4_000_000)));
    setFile({ name: f.name, bytes, detected });
    setResult(null);
    const hint = detected?.source === "ing_csv" ? /ing/i : /amex|american/i;
    const match = accounts.find((a) => hint.test(a.name));
    setAccountId(match?.id ?? "new");
    setNewName(detected?.source === "ing_csv" ? "ING Betaalrekening" : detected ? "AMEX" : "");
  }

  async function run() {
    if (!file?.detected) return;
    try {
      const id = accountId === "new" ? (await createAccount.mutateAsync([newName.trim()])).id : accountId;
      importFile.mutate([id, file.detected.source, file.name, file.bytes]);
    } catch {
      // the toast already explains what went wrong
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  };
  const busy = createAccount.isPending || importFile.isPending;

  if (result) {
    const { batch, alreadyImported, autoLabelled } = result;
    const left = batch.inserted - autoLabelled;
    return (
      <Sheet
        title="Import Statement"
        subtitle={alreadyImported ? "This exact file was imported before; nothing changed." : file?.name}
        onClose={onClose}
        footer={
          <>
            {!alreadyImported && batch.inserted > 0 && (
              <button className="btn" disabled={undo.isPending} onClick={() => undo.mutate([batch.id])}>
                Undo Import
              </button>
            )}
            {left > 0 ? (
              <button className="btn primary" onClick={() => { onClose(); navigate({ to: "/inbox" }); }}>
                Categorize {left}
              </button>
            ) : (
              <button className="btn primary" onClick={onClose}>Done</button>
            )}
          </>
        }
      >
        <div className="stats three">
          <div><b className="num pos">{batch.inserted}</b><span>new transactions</span></div>
          <div><b className="num">{autoLabelled}</b><span>labelled by rules</span></div>
          <div><b className="num">{batch.duplicates}</b><span>already imported</span></div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Import Statement"
      subtitle="The bank is recognised from the file's header row."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!file?.detected || busy || (accountId === "new" && !newName.trim())}
            onClick={run}
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <label
        className={`drop ${dragging ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <Icon name="doc" />
        <span>{file ? "Choose another file" : "Drop an ING or AMEX export here, or click to choose"}</span>
        <input id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
      </label>

      {file && !file.detected && (
        <p className="error-text">{file.name} doesn't look like an ING or AMEX export. Export it again as CSV from your bank.</p>
      )}

      {file?.detected && (
        <>
          <div className="file">
            <span className="badge">CSV</span>
            <div className="min0">
              <div className="strong">{file.detected.bank} export</div>
              <div className="meta">
                {file.detected.rows} rows
                {file.detected.from && file.detected.to && ` · ${shortDate(file.detected.from)} – ${shortDate(file.detected.to)} ${file.detected.to.slice(0, 4)}`}
              </div>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="import-account">Account</label>
            <select
              id="import-account"
              className="field"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value === "new" ? "new" : Number(e.target.value))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
              <option value="new">New account…</option>
            </select>
          </div>
          {accountId === "new" && (
            <div className="form-row">
              <label htmlFor="import-new-account">Name</label>
              <input id="import-new-account" className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ING Betaalrekening" />
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
