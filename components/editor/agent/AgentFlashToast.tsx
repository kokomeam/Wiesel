"use client";

/**
 * Transient failure toast for optimistic agent-review rollbacks (PERF-1 B3):
 * "Couldn't accept the changes — they're back under review." Driven by
 * `agentStore.flash` / `flashId`; auto-dismisses. Mounted statically by the
 * editor shell (AgentPlanHost is lazy-loaded since PERF-1 D and the AgentPanel
 * collapses), so the rollback surfaces unconditionally. Fixed bottom-center,
 * purely informational (pointer-events: none). Keep this framer-free.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";
import { useAgentStore } from "@/lib/editor/agentStore";

export function AgentFlashToast() {
  const flash = useAgentStore((s) => s.flash);
  const flashId = useAgentStore((s) => s.flashId);
  // Visibility is DERIVED (no synchronous setState in the effect): the effect
  // only schedules the async dismiss; the latest flash is visible until then.
  const [dismissedId, setDismissedId] = useState(0);

  useEffect(() => {
    if (!flash || flashId === 0) return;
    const t = setTimeout(() => setDismissedId(flashId), 4000);
    return () => clearTimeout(t);
  }, [flashId, flash]);

  const visible = !!flash && flashId > dismissedId;
  if (!visible || typeof document === "undefined") return null;
  // Portal to <body> (the placement it always had inside AgentPlanHost's
  // portal) so a transformed ancestor in the shell can never re-anchor the
  // fixed positioning.
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[120] flex justify-center"
      role="alert"
      data-ai-id="agent-flash-toast"
    >
      <div className="flex items-center gap-2 rounded-full bg-stone-900/90 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur">
        <CircleAlert className="size-3.5 text-rose-300" />
        {flash}
      </div>
    </div>,
    document.body
  );
}
