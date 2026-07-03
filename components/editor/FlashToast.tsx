"use client";

/**
 * A small transient toast for one-shot confirmations (e.g. "Slide is now freely
 * editable" after Edit-freely). Driven by `uiStore.flash` / `flashId`; auto-
 * dismisses. Rendered inside a `relative` container — positions top-center over
 * it. Purely informational (pointer-events: none).
 */

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useUIStore } from "@/lib/editor/uiStore";

export function FlashToast() {
  const flash = useUIStore((s) => s.flash);
  const flashId = useUIStore((s) => s.flashId);
  // Visibility is DERIVED (no synchronous setState in the effect): the effect
  // only schedules the async dismiss; the latest flash is visible until then.
  const [dismissedId, setDismissedId] = useState(0);

  useEffect(() => {
    if (!flash || flashId === 0) return;
    const t = setTimeout(() => setDismissedId(flashId), 2600);
    return () => clearTimeout(t);
  }, [flashId, flash]);

  const visible = !!flash && flashId > dismissedId;
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-2 rounded-full bg-stone-900/90 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur">
        <Check className="size-3.5 text-emerald-300" />
        {flash}
      </div>
    </div>
  );
}
