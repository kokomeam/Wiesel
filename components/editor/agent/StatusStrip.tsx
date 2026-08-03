"use client";

/**
 * The agent's live working strip — rendered above the composer whenever
 * `thinking` is true, so there is ALWAYS an honest, humanized signal while a
 * run is in flight (long non-streaming PLAN calls and reasoning turns emit no
 * deltas — the transcript alone can go silent for 30s+).
 *
 * Copy = humanized phase ("Writing content — Linked lists (2/4)") + the
 * friendly label of the running tool ("Adding slides…"). A client heartbeat
 * watches `lastEventAt` (stamped in dispatch) and softens the copy to "Still
 * working…" after 8s of SSE silence, so a quiet stretch never reads as a hang.
 *
 * The parent renders this ONLY while thinking, so mounted ⇒ in-flight; the
 * interval lives for the strip's lifetime (cleaned up on unmount). The dots
 * use CSS animate-pulse — the global prefers-reduced-motion guard in
 * globals.css freezes them.
 */

import { useEffect, useState } from "react";
import {
  AGENT_MAINTENANCE_COPY,
  AGENT_PHASE_COPY,
  friendlyToolLabel,
} from "@/lib/ai/toolLabels";
import { useAgentStore } from "@/lib/editor/agentStore";

/** SSE silence (ms) before the copy softens to "Still working…". */
const SILENCE_MS = 8_000;

export function StatusStrip() {
  const phase = useAgentStore((s) => s.phase);
  const phaseDetail = useAgentStore((s) => s.phaseDetail);
  const maintenance = useAgentStore((s) => s.maintenance);
  const toolCards = useAgentStore((s) => s.toolCards);

  // Heartbeat: poll the last event timestamp (read via getState — no
  // per-event re-render) and flip `silent` when the stream has gone quiet.
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      const last = useAgentStore.getState().lastEventAt;
      setSilent(last !== null && Date.now() - last >= SILENCE_MS);
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  const runningTool = [...toolCards].reverse().find((c) => c.status === "running");

  const base = maintenance
    ? (AGENT_MAINTENANCE_COPY[maintenance.stage] ?? "Working")
    : phase
      ? (AGENT_PHASE_COPY[phase] ?? "Working")
      : "Working";
  const detail = phaseDetail ? ` — ${phaseDetail}` : "";
  const text = silent ? "Still working — thinking through the details…" : `${base}${detail}…`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-ai-status-strip=""
      className="flex items-center gap-2.5 border-t border-stone-200 bg-stone-50/70 px-4 py-2"
    >
      <span className="inline-flex shrink-0 items-center gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-pulse rounded-full bg-brand-400"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
      <p className="min-w-0 flex-1 truncate text-xs text-stone-600">
        <span className="font-medium">{text}</span>
        {!silent && runningTool && (
          <span className="text-stone-400"> · {friendlyToolLabel(runningTool.tool)}…</span>
        )}
      </p>
    </div>
  );
}
