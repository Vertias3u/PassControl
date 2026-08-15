"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  preventClose = false,
  showClose = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  preventClose?: boolean;
  showClose?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("pc-dialog", className)}
      onCancel={(event) => {
        event.preventDefault();
        if (!preventClose) onOpenChange(false);
      }}
      onClose={() => {
        if (open && !preventClose) onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !preventClose) onOpenChange(false);
      }}
    >
      <div className="pc-dialog__surface" onClick={(event) => event.stopPropagation()}>
        <div className="pc-dialog__header">
          <div className="min-w-0">
            <h2 id={titleId} className="pc-dialog__title">
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="pc-dialog__description">
                {description}
              </div>
            ) : null}
          </div>
          {showClose && !preventClose ? (
            <button
              type="button"
              className="pc-icon-button"
              aria-label="Close dialog"
              onClick={() => onOpenChange(false)}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </dialog>
  );
}

