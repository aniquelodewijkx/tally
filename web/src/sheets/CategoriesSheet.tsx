import { Code, ConnectError } from "@connectrpc/connect";
import { useState } from "react";

import { api, type CategoryKind } from "../api";
import { STARTER_CATEGORIES, type CatIndex, type CatInfo } from "../lib/categories";
import { useAction, useCats } from "../queries";
import { CategoryIcon, Empty } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";

const friendly = (e: unknown, message: string) => {
  if (e instanceof ConnectError && e.code === Code.FailedPrecondition) return new Error(message);
  return e;
};

/** Categories this one may move under: same kind, not itself or one of its own descendants. */
function parentOptions(cats: CatIndex, self: CatInfo | null, kind: CategoryKind) {
  const isInside = (c: CatInfo): boolean => {
    for (let cur: CatInfo | undefined = c; cur; cur = cur.parentId != null ? cats.byId.get(cur.parentId) : undefined) {
      if (self && cur.id === self.id) return true;
    }
    return false;
  };
  return cats.ordered.filter((c) => c.kind === kind && !isInside(c));
}

export function CategoriesSheet({ onClose }: { onClose: () => void }) {
  const cats = useCats();
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState<number | null>(null);
  const [newKind, setNewKind] = useState<CategoryKind>("expense");

  const create = useAction(
    async (parentId: number | null, n: string, kind: CategoryKind) => {
      try {
        return await api.createCategory(parentId, n, kind);
      } catch (e) {
        throw friendly(e, `There's already a category called "${n}" there.`);
      }
    },
    { onSuccess: () => setNewName("") },
  );
  const update = useAction(
    async (id: number, n: string, parentId: number | null) => {
      try {
        return await api.updateCategory(id, n, parentId);
      } catch (e) {
        throw friendly(e, `There's already a category called "${n}" there.`);
      }
    },
    { onSuccess: () => setEditing(null) },
  );
  const remove = useAction(
    async (c: CatInfo) => {
      try {
        await api.deleteCategory(c.id);
      } catch (e) {
        throw friendly(e, `${c.name} still has transactions or subcategories, so it can't be deleted.`);
      }
    },
    { onSuccess: () => setEditing(null) },
  );
  const starter = useAction(
    async () => {
      for (const top of STARTER_CATEGORIES) {
        const created = await api.createCategory(null, top.name, top.kind);
        for (const child of top.children ?? []) await api.createCategory(created.id, child, top.kind);
      }
    },
    { success: "Starter categories added" },
  );

  if (!cats) return null;
  const newKindEffective = newParent != null ? cats.byId.get(newParent)!.kind : newKind;

  return (
    <Sheet title="Categories" subtitle="Rename or move a category with the pencil. A category in use can't be deleted." onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      {cats.ordered.length === 0 ? (
        <Empty title="No categories yet">
          <p>Start with a common set (Housing, Food, Shopping, Travel and more) and adjust it to your own.</p>
          <button className="btn primary" disabled={starter.isPending} onClick={() => starter.mutate([])}>Add Starter Categories</button>
        </Empty>
      ) : (
        <div className="tree">
          {cats.ordered.map((c) =>
            editing === c.id ? (
              <div className="grow editing" key={c.id} style={{ paddingLeft: 12 + c.depth * 24 }}>
                <input className="field grow-1" aria-label="Name" value={name} autoFocus onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && name.trim() && update.mutate([c.id, name.trim(), parent])} />
                <select className="field" aria-label="Parent" value={parent ?? ""} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Top level</option>
                  {parentOptions(cats, c, c.kind).map((p) => <option key={p.id} value={p.id}>{p.path}</option>)}
                </select>
                <button className="btn primary" disabled={!name.trim() || update.isPending} onClick={() => update.mutate([c.id, name.trim(), parent])}>Save</button>
                <button className="icon-btn danger" aria-label={`Delete ${c.name}`} onClick={() => remove.mutate([c])}><Icon name="trash" /></button>
                <button className="icon-btn" aria-label="Cancel" onClick={() => setEditing(null)}><Icon name="x" /></button>
              </div>
            ) : (
              <div className="grow" key={c.id} style={{ paddingLeft: 12 + c.depth * 24 }}>
                <CategoryIcon cat={c} size="sm" />
                <span className="grow-1">{c.name}</span>
                {c.depth === 0 && <span className="v">{c.kind === "income" ? "Income" : "Expense"}</span>}
                <button className="icon-btn" aria-label={`Edit ${c.name}`} onClick={() => { setEditing(c.id); setName(c.name); setParent(c.parentId); }}>
                  <Icon name="pencil" />
                </button>
              </div>
            ),
          )}
        </div>
      )}

      <div className="add-row">
        <input id="new-category" className="field grow-1" placeholder="New category" value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newName.trim() && create.mutate([newParent, newName.trim(), newKindEffective])} />
        <select className="field" aria-label="Parent of the new category" value={newParent ?? ""} onChange={(e) => setNewParent(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Top level</option>
          {cats.ordered.map((p) => <option key={p.id} value={p.id}>{p.path}</option>)}
        </select>
        {newParent == null && (
          <select className="field" aria-label="Kind" value={newKind} onChange={(e) => setNewKind(e.target.value as CategoryKind)}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        )}
        <button className="btn" disabled={!newName.trim() || create.isPending} onClick={() => create.mutate([newParent, newName.trim(), newKindEffective])}>
          <Icon name="plus" />Add
        </button>
      </div>
    </Sheet>
  );
}
