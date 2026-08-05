"use client";

/**
 * Tutor enablement card (TUTOR-1 Wave 5, P5.1).
 *
 * The Toggle drives setTutorEnabledAction. ENABLING is gated on an accepted
 * concept graph: if the action returns { needsGraph:true }, the card swaps to a
 * "Build the concept graph first" CTA that fires requestGraphExtractionAction.
 * DISABLING is always allowed. When the course has no live publication the
 * enable copy is honest (extraction needs a published version).
 *
 * Client component (the Toggle + the two actions), but it holds NO learner data —
 * only the boolean enabled state + the derived gate signals from the bundle.
 */

import { useState, useTransition } from "react";
import { Waypoints } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";
import { StatusChip } from "@/components/ui/StatusChip";
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
  const [needsGraph, setNeedsGraph] = useState(false);
  const [extractionRequested, setExtractionRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onToggle = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await setTutorEnabledAction(courseId, next);
      if (result.ok) {
        setEnabled(result.enabled);
        setNeedsGraph(false);
      } else if ("needsGraph" in result) {
        setNeedsGraph(true);
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

  // The graph is either being reviewed (pending change-set) or not yet built.
  const graphStatus =
    pendingGraphChangeSetId !== null
      ? "A concept-graph review is waiting in the Concept graph tab. Accept it to enable the tutor."
      : nodeCount > 0
        ? `${nodeCount} concept${nodeCount === 1 ? "" : "s"} in the accepted graph.`
        : "No concept graph yet.";

  return (
    <div className="rounded-card border border-stone-200/80 bg-white shadow-card">
      <div className="flex items-start justify-between gap-4 border-b border-stone-200/70 px-card-pad py-4">
        <div>
          <h3 className="text-sm font-semibold text-stone-900">AI tutor</h3>
          <p className="mt-0.5 text-xs text-stone-500">
            Give learners a course-grounded tutor in the lesson player.
          </p>
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
        <p>{graphStatus}</p>

        {needsGraph ? (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
            <p className="text-sm font-medium text-amber-900">Build the concept graph first</p>
            <p className="mt-1 text-xs leading-relaxed text-amber-800">
              The tutor grounds every answer in your course&apos;s concept graph. Extract it from
              the live version, review the staged result in the Concept graph tab, then enable the
              tutor.
            </p>
            {extractionRequested ? (
              <p className="mt-3 text-xs font-medium text-amber-900">
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
        ) : null}

        {error ? (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
