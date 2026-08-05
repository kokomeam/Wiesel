import { Users, MessagesSquare, DollarSign, LifeBuoy } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatusChip } from "@/components/ui/StatusChip";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { EnablementCard } from "./EnablementCard";
import type { TutorConsoleBundle } from "@/lib/studio/tutorConsole";

/**
 * Overview tab (TUTOR-1 Wave 5, P5.1). Server component. Renders:
 *   • the enablement status card (client Toggle → the enable/extraction actions),
 *   • cohort-floored usage (30d) — a SUPPRESSED empty state below the ≥5 floor,
 *   • tutor spend by job type from REAL telemetry (honest empty state when none),
 *   • an escalation badge ONLY when TUTOR_ESCALATIONS_UI==='true' (else absent).
 *
 * Every number here is already floored/aggregated by the definer RPC — this
 * component never touches a raw learner table and never recomputes a floor.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});
const INT = new Intl.NumberFormat("en-US");

const JOB_TYPE_LABEL: Record<string, string> = {
  graph_extraction: "Graph extraction",
  reconciliation: "Reconciliation",
  embedding: "Embeddings",
  tutor_turn: "Tutor turns",
};

export function OverviewTutorTab({
  courseId,
  bundle,
}: {
  courseId: string;
  bundle: TutorConsoleBundle;
}) {
  const { enablement, overview } = bundle;
  // overview is always present on this tab (the RPC populates it for p_tab=overview);
  // guard defensively so a null never crashes the render.
  const usage = overview?.usage ?? null;
  const suppressed = overview?.usageSuppressed ?? true;
  const cost = overview?.cost ?? { byJobType: [], totalUsd: 0 };
  const showEscalations = process.env.TUTOR_ESCALATIONS_UI === "true";

  return (
    <div className="space-y-6">
      <EnablementCard
        courseId={courseId}
        enabled={enablement.enabled}
        nodeCount={enablement.nodeCount}
        pendingGraphChangeSetId={enablement.pendingGraphChangeSetId}
      />

      {/* ── Usage (30d, cohort-floored ≥5) ── */}
      <Card>
        <CardHeader
          title="Tutor usage"
          subtitle="Learner activity over the last 30 days"
          action={
            showEscalations ? (
              <StatusChip status="attention">
                <LifeBuoy className="mr-1 inline size-3" aria-hidden />
                Escalations
              </StatusChip>
            ) : undefined
          }
        />
        {usage && !suppressed ? (
          <div className="grid grid-cols-1 gap-4 p-card-pad sm:grid-cols-3">
            <UsageStat icon={Users} label="Learners" value={INT.format(usage.uniqueLearners)} />
            <UsageStat
              icon={MessagesSquare}
              label="Sessions"
              value={INT.format(usage.sessions)}
            />
            <UsageStat icon={MessagesSquare} label="Turns" value={INT.format(usage.turns)} />
          </div>
        ) : (
          <div className="p-card-pad">
            <EmptyState
              icon={Users}
              title="Not enough learners yet"
              hint="Usage is shown only once at least 5 learners have used the tutor — individual activity is never disclosed. Check back as more learners try it."
            />
          </div>
        )}
      </Card>

      {/* ── Tutor spend by job type (author's own spend — real telemetry) ── */}
      <Card>
        <CardHeader
          title="Tutor spend"
          subtitle="Model cost for this course's tutor, by job type"
          action={
            cost.byJobType.length > 0 ? (
              <span className="text-sm font-semibold text-stone-900">
                {USD.format(cost.totalUsd)}
              </span>
            ) : undefined
          }
        />
        {cost.byJobType.length > 0 ? (
          <div className="divide-y divide-stone-200/70">
            {cost.byJobType.map((row) => (
              <div
                key={row.jobType}
                className="flex items-center justify-between gap-4 px-card-pad py-3"
              >
                <div>
                  <p className="text-sm font-medium text-stone-800">
                    {JOB_TYPE_LABEL[row.jobType] ?? row.jobType}
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500">
                    {INT.format(row.calls)} call{row.calls === 1 ? "" : "s"} ·{" "}
                    {INT.format(row.inputTokens)} in / {INT.format(row.outputTokens)} out
                  </p>
                </div>
                <span className="text-sm font-medium text-stone-700">
                  {row.costUsd === null ? "—" : USD.format(row.costUsd)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-card-pad">
            <EmptyState
              icon={DollarSign}
              title="No tutor spend yet"
              hint="Once the tutor extracts a concept graph or answers a learner, its model cost appears here — grouped by job type, with no learner attribution."
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function UsageStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-stone-200/70 bg-stone-50/40 p-4">
      <span className="grid size-9 place-items-center rounded-xl bg-brand-50 text-brand-600">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium text-stone-500">{label}</p>
        <p className="text-2xl font-semibold text-stone-900">{value}</p>
      </div>
    </div>
  );
}
