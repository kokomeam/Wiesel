"use client";

/**
 * The evidence card (Milestone 5) — THE core product moment of a maintenance
 * run: above every agent-proposed change, the creator sees WHY, verbatim from
 * the learner data ("Q3: 64% incorrect over 41 attempts; distractor B chosen
 * 3× the key — likely ambiguous wording") before deciding Accept/Reject.
 *
 * Renders the `evidence` jsonb stamped on the change-set items (shape =
 * findingEvidenceJson in lib/ai/maintenance.ts) — parsed defensively so a
 * malformed payload degrades to nothing rather than breaking the block frame.
 */

import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ParsedEvidence {
  title: string;
  summary: string;
  severity: "low" | "medium" | "high";
  kind: string;
  metrics: Record<string, number>;
  recommendation?: string;
}

/** Defensive parse of the evidence jsonb — null hides the card entirely. */
export function parseEvidence(value: unknown): ParsedEvidence | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string" || v.summary.length === 0) return null;
  const severity =
    v.severity === "high" || v.severity === "medium" || v.severity === "low"
      ? v.severity
      : "medium";
  const metrics: Record<string, number> = {};
  if (typeof v.metrics === "object" && v.metrics !== null) {
    for (const [key, val] of Object.entries(v.metrics as Record<string, unknown>)) {
      if (typeof val === "number" && Number.isFinite(val)) metrics[key] = val;
    }
  }
  return {
    title: typeof v.title === "string" ? v.title : "Learner-data finding",
    summary: v.summary,
    severity,
    kind: typeof v.kind === "string" ? v.kind : "content_issue",
    metrics,
    recommendation: typeof v.recommendation === "string" ? v.recommendation : undefined,
  };
}

const METRIC_LABEL: Record<string, string> = {
  pctCorrect: "% correct",
  n: "responses",
  topDistractorCount: "top distractor",
  keyCount: "chose the key",
  discrimination: "discrimination",
};

export function EvidenceCard({
  evidence,
  compact = false,
}: {
  evidence: ParsedEvidence;
  compact?: boolean;
}) {
  const tone =
    evidence.severity === "high"
      ? "border-rose-200 bg-rose-50/70 text-rose-900"
      : "border-amber-200 bg-amber-50/70 text-amber-900";
  const chipTone =
    evidence.severity === "high"
      ? "bg-rose-100 text-rose-700"
      : "bg-amber-100 text-amber-700";
  return (
    <div
      data-ai-component="evidence-card"
      className={cn("rounded-xl border px-3 py-2.5", tone, compact && "px-2.5 py-2")}
    >
      <div className="flex items-start gap-2">
        <BarChart3 className="mt-0.5 size-3.5 shrink-0 opacity-70" aria-hidden />
        <div className="min-w-0">
          <p className={cn("font-medium leading-snug", compact ? "text-xs" : "text-[13px]")}>
            {evidence.summary}
          </p>
          {!compact && evidence.recommendation ? (
            <p className="mt-1 text-xs opacity-80">{evidence.recommendation}</p>
          ) : null}
          {Object.keys(evidence.metrics).length > 0 ? (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {Object.entries(evidence.metrics)
                .slice(0, 5)
                .map(([key, value]) => (
                  <span
                    key={key}
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                      chipTone
                    )}
                  >
                    {METRIC_LABEL[key] ?? key}: {value}
                  </span>
                ))}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
