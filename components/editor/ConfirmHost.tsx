"use client";

/**
 * Renders the single app-wide confirmation dialog from the confirm store, so
 * any handler can `await confirm(...)`. Mounted once in the app layout.
 */

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useConfirmStore } from "@/lib/editor/confirmStore";

export function ConfirmHost() {
  const open = useConfirmStore((s) => s.open);
  const options = useConfirmStore((s) => s.options);
  const settle = useConfirmStore((s) => s.settle);

  return (
    <ConfirmDialog
      open={open}
      title={options?.title ?? ""}
      message={options?.message ?? ""}
      confirmLabel={options?.confirmLabel}
      cancelLabel={options?.cancelLabel}
      tone={options?.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
