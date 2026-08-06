"use client";

/**
 * Tutor enablement card (TUTOR-1 Wave 5, P5.1).
 *
 * The tutor is ON BY DEFAULT — the Toggle is an opt-OUT switch driving
 * setTutorEnabledAction, and enabling is NEVER gated on a concept graph. Below the
 * toggle, an HONEST status line frames the concept graph as an optional QUALITY
 * enhancement (mastery-aware guidance), never a prerequisite: when no graph exists
 * it's an info note with an "Extract concept graph" enhancement action (via
 * requestGraphExtractionAction), not a blocking amber gate.
 *
 * Client component (the Toggle + the two actions), but it holds NO learner data —
 * only the boolean enabled state + the derived graph-status signals from the bundle.
 */

import { useState, useTransition } from "react";
import { Waypoints, GraduationCap } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";
import { StatusChip } from "@/components/ui/StatusChip";
import { IconTile } from "@/components/ui/IconTile";
import { toolAttrs } from "@/lib/course/aiAttributes";
import {
  setTutorEnabledAction,
  requestGraphExtractionAction,
} from "@/app/(app)/studio/[courseId]/tutor/actions";

export function EnablementCard({
  courseId,
  enabled: initialEnabled,
  nodeCount,
  pendingGraphChangeSetId,
}: {
  courseId: string;
  enabled: boolean;
  nodeCount: number;
  pendingGraphChangeSetId: string | null;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [extractionRequested, setExtractionRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onToggle = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await setTutorEnabledAction(courseId, next);
      if (result.ok) {
        setEnabled(result.enabled);
      } else {
        setError(result.error);
      }
    });
  };

  const onRequestExtraction = () => {
    setError(null);
    startTransition(async () => {
      const result = await requestGraphExtractionAction(courseId);
      if (result.ok) {
        setExtractionRequested(true);
      } else {
        setError(result.error);
      }
    });
  };

  // Graph status is a QUALITY signal, never a gate: pending review · concepts in
  // the graph · no graph yet (the tutor still answers from the lessons).
  const hasGraph = nodeCount > 0 && pendingGraphChangeSetId === null;
  const graphStatus =
    pendingGraphChangeSetId !== null
      ? "A concept-graph review is waiting in the Concept graph tab."
      : hasGraph
        ? `${nodeCount} concept${nodeCount === 1 ? "" : "s"} in the graph — the tutor uses these for mastery-aware guidance.`
        : null;

  return (
    <div className="rounded-card border border-stone-200/80 bg-white shadow-card">
      <div className="flex items-start justify-between gap-4 border-b border-stone-200/70 px-card-pad py-4">
        <div className="flex items-start gap-3">
          <IconTile icon={GraduationCap} tone={enabled ? "gradient" : "brand"} />
          <div>
            <h3 className="font-display text-title font-medium tracking-tight text-stone-900">
              AI tutor
            </h3>
            <p className="mt-0.5 text-xs text-stone-600">
              Learners get a course-grounded tutor in the lesson player. It&apos;s on by
              default — turn it off here if you&apos;d rather not offer it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <StatusChip status={enabled ? "success" : "neutral"}>
            {enabled ? "On" : "Off"}
          </StatusChip>
          <span
            {...toolAttrs({
              tool: "tutor-enable",
              action: "SET_TUTOR_ENABLED",
              targetType: "toggle",
              label: "Enable or disable the AI tutor",
            })}
          >
            <Toggle
              checked={enabled}
              onChange={onToggle}
              disabled={pending}
              aria-label="Enable the AI tutor for this course"
            />
          </span>
        </div>
      </div>

      <div className="px-card-pad py-4 text-sm text-stone-600">
        {graphStatus ? (
          <p>{graphStatus}</p>
        ) : (
          <div className="rounded-xl border border-stone-200/80 bg-stone-50/60 p-4">
            <p className="text-sm font-medium text-stone-800">Add mastery-aware guidance</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-600">
              Your tutor already answers from this course&apos;s lessons. Build the concept graph
              to add mastery-aware guidance — it scaffolds answers around what each learner has
              and hasn&apos;t mastered. Optional; the tutor works without it.
            </p>
            {extractionRequested ? (
              <p className="mt-3 text-xs font-medium text-stone-700">
                Extraction requested — check the Concept graph tab shortly for the staged review.
              </p>
            ) : (
              <button
                type="button"
                onClick={onRequestExtraction}
                disabled={pending}
                className="mt-3 inline-flex items-center gap-1.5 rounded-full brand-gradient px-4 py-1.5 text-xs font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95 disabled:opacity-60"
                {...toolAttrs({
                  tool: "tutor-request-extraction",
                  action: "REQUEST_GRAPH_EXTRACTION",
                  targetType: "button",
                  label: "Request a concept-graph extraction",
                })}
              >
                <Waypoints className="size-3.5" aria-hidden />
                Extract concept graph
              </button>
            )}
          </div>
        )}

        {error ? (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
