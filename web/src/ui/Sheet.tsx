import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

/** A macOS-style sheet: centered, title on top, actions bottom-right. */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className={`sheet ${wide ? "wide" : ""}`} aria-describedby={undefined}>
          <Dialog.Title className="sheet-title">{title}</Dialog.Title>
          {subtitle && <p className="sheet-sub">{subtitle}</p>}
          <div className="sheet-body">{children}</div>
          {footer && <div className="sheet-foot">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
