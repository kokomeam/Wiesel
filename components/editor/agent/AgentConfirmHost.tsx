"use client";

/**
 * The agent's pause-to-confirm dialog, mounted at the EDITOR shell level (not
 * inside the collapsible AgentPanel) so a destructive delete the agent proposes
 * always surfaces — even if the creator has the agent panel collapsed. Driven
 * by `agentStore.pendingConfirmation`; the decision resumes the run.
 */

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAgentStore } from "@/lib/editor/agentStore";
import { useAgentStream } from "./useAgentStream";

export function AgentConfirmHost() {
  const pending = useAgentStore((s) => s.pendingConfirmation);
  const { confirmAction } = useAgentStream();

  return (
    <ConfirmDialog
      open={!!pending}
      title={pending?.kind === "module" ? "Delete this module?" : "Delete this lesson?"}
      tone="danger"
      confirmLabel={pending?.kind === "module" ? "Delete module" : "Delete lesson"}
      cancelLabel="Keep it"
      message={
        pending ? (
          <>
            The agent wants to delete{" "}
            <b className="font-semibold text-stone-700">{pending.label}</b>
            {pending.kind === "module" ? " and every lesson in it" : " and all of its content"}.
            This can&rsquo;t be undone.
          </>
        ) : (
          ""
        )
      }
      onConfirm={() => void confirmAction("confirm")}
      onCancel={() => void confirmAction("cancel")}
    />
  );
}
