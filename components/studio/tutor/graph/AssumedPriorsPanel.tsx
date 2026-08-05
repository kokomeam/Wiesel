"use client";

/**
 * Assumed-priors panel (TUTOR-1 Wave 5, P5.2 · step 5). Lists the concepts the
 * course LEANS ON but never teaches (assumed_prior_nodes), with the slides that
 * reference each, plus a "Draft a primer lesson" button. The button FILES A REQUEST
 * to the Course orchestrator via its normal flow (requestPrimerLessonAction seeds a
 * user-message on the agent thread) — this wave authors NO course content; the
 * docked agent picks the request up. On success we deep-link the creator to the
 * studio with the agent panel implied (the returned conversation id is available
 * for a future direct link; today we route to the studio editor).
 *
 * No editor-store imports.
 */

import { useState, useTransition } from "react";
import { BookOpen, ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconTile } from "@/components/ui/IconTile";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { requestPrimerLessonAction } from "@/app/(app)/studio/[courseId]/tutor/graphActions";
import { buildTeachingDeepLink } from "./GraphCanvas";
import type { AssumedPriorRow } from "@/lib/studio/graphConsole";

type EvidenceAnchor = { lessonId?: string; blockId?: string };

export interface AssumedPriorsPanelProps {
  courseId: string;
  assumedPriors: AssumedPriorRow[];
}

export function AssumedPriorsPanel({ courseId, assumedPriors }: AssumedPriorsPanelProps) {
  const active = assumedPriors.filter((a) => a.status === "active");
  if (active.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No assumed prerequisites flagged"
        hint="When the tutor sees the course lean on a concept it never teaches, it lands here so you can add a primer."
      />
    );
  }
  return (
    <section aria-label="Assumed prerequisites" className="space-y-3">
      <div className="flex items-start gap-3">
        <IconTile icon={BookOpen} tone="brand" />
        <div>
          <h3 className="font-display text-title font-medium tracking-tight text-stone-900">
            Assumed prerequisites
          </h3>
          <p className="text-xs text-stone-600">
            Concepts the course relies on but never teaches. Draft a primer so learners who lack the background can catch up.
          </p>
        </div>
      </div>
      <ul className="space-y-2.5">
        {active.map((prior) => (
          <AssumedPriorItem key={prior.id} courseId={courseId} prior={prior} />
        ))}
      </ul>
    </section>
  );
}

function AssumedPriorItem({ courseId, prior }: { courseId: string; prior: AssumedPriorRow }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "filed" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const anchors = (prior.evidence ?? []) as EvidenceAnchor[];

  const requestPrimer = () => {
    startTransition(async () => {
      const res = await requestPrimerLessonAction(courseId, prior.title, prior.id);
      if (res.ok) {
        setState("filed");
        setMessage("Primer request filed — the course agent will draft it on its next run.");
      } else {
        setState("error");
        setMessage(res.error);
      }
    });
  };

  return (
    <li className="rounded-2xl border border-stone-200/80 bg-white p-3.5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-stone-900">{prior.title}</p>
          {prior.description ? (
            <p className="mt-0.5 text-sm text-stone-600">{prior.description}</p>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={requestPrimer}
          disabled={pending || state === "filed"}
          {...toolAttrs({
            tool: "tutor-primer-request",
            action: "requestPrimerLesson",
            targetType: "assumed_prior",
            label: `Draft a primer lesson for ${prior.title}`,
          })}
        >
          <Sparkles className="size-3.5" aria-hidden />
          {state === "filed" ? "Requested" : "Draft a primer lesson"}
        </Button>
      </div>

      {anchors.length > 0 ? (
        <div className="mt-2.5">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-stone-400">Referenced by</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {anchors.slice(0, 6).map((a, i) =>
              a.lessonId ? (
                <li key={`${a.lessonId}:${a.blockId ?? i}`}>
                  <a
                    href={buildTeachingDeepLink(courseId, a.lessonId, a.blockId)}
                    className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                  >
                    <ExternalLink className="size-3" aria-hidden />
                    slide
                  </a>
                </li>
              ) : null
            )}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p
          role="status"
          className={
            "mt-2 rounded-lg px-2.5 py-1.5 text-xs " +
            (state === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700")
          }
        >
          {message}
        </p>
      ) : null}
    </li>
  );
}
