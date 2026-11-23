import type { ReactNode } from "react";

import type { Tx } from "../api";
import { txVisual, type CatIndex, type CatInfo } from "../lib/categories";
import { money } from "../lib/format";
import { Icon } from "./Icon";

type Size = "sm" | "md" | "lg";

export function CategoryIcon({ cat, size = "md" }: { cat: CatInfo; size?: Size }) {
  return (
    <span className={`ci ${size}`} style={{ ["--cc" as string]: cat.color }}>
      {cat.icon ? <Icon name={cat.icon} /> : <span className="letter">{cat.letter}</span>}
    </span>
  );
}

export function TxIcon({ tx, cats, size = "md" }: { tx: Tx; cats: CatIndex; size?: Size }) {
  const v = txVisual(tx, cats);
  if (v.kind === "category" && tx.ruleId != null) {
    return (
      <span className="ci-wrap" title="Labelled by a rule">
        <CategoryIcon cat={v.cat} size={size} />
        <span className="auto-dot"><Icon name="sparkle" /></span>
      </span>
    );
  }
  if (v.kind === "category") return <CategoryIcon cat={v.cat} size={size} />;
  if (v.kind === "transfer" && tx.ruleId != null) {
    return (
      <span className="ci-wrap" title="Marked by a rule">
        <span className={`ci ${size} xfer`}><Icon name="swap" /></span>
        <span className="auto-dot"><Icon name="sparkle" /></span>
      </span>
    );
  }
  if (v.kind === "transfer") return <span className={`ci ${size} xfer`}><Icon name="swap" /></span>;
  if (v.kind === "split") return <span className={`ci ${size} multi`}><Icon name="split" /></span>;
  return <span className={`ci ${size} none`}><Icon name="q" /></span>;
}

export function Amount({ cents, className = "" }: { cents: number; className?: string }) {
  return <span className={`num ${cents > 0 ? "pos" : ""} ${className}`}>{money(cents, { plus: true })}</span>;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={o.value === value ? "on" : ""} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
      {children}
    </label>
  );
}

export function Stepper({ onPrev, onNext, label }: { onPrev: () => void; onNext: () => void; label: string }) {
  return (
    <div className="stepper">
      <button type="button" onClick={onPrev} aria-label={`Previous ${label}`}><Icon name="left" /></button>
      <button type="button" onClick={onNext} aria-label={`Next ${label}`}><Icon name="right" /></button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <div>{children}</div>}
    </div>
  );
}
