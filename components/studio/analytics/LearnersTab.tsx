import { AlertTriangle, Users } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import type { RosterRow } from "@/lib/analytics/dashboard";
import type { LearnerFlagType } from "@/lib/analytics/flags";
import { cn } from "@/lib/cn";
import { EmptyState } from "./EmptyState";
import { formatDate, timeAgo } from "./format";

interface RosterFlag {
  type: LearnerFlagType;
  detail: Record<string, unknown>;
}

/** Parse a flags jsonb value (an array of {type, detail, …}) defensively. */
export function parseFlags(value: unknown): RosterFlag[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((f) => {
    if (typeof f !== "object" || f === null) return [];
    const candidate = f as { type?: unknown; detail?: unknown };
    if (
      candidate.type !== "inactive_7d_incomplete" &&
      candidate.type !== "repeated_quiz_failure"
    ) {
      return [];
    }
    return [
      {
        type: candidate.type,
        detail: (candidate.detail ?? {}) as Record<string, unknown>,
      },
    ];
  });
}

/** The roster RPC's flags column, parsed. */
export function rosterFlags(row: RosterRow): RosterFlag[] {
  return parseFlags(row.flags);
}

export function RiskBadge({ flags }: { flags: RosterFlag[] }) {
  if (flags.length === 0) {
    return <span className="text-xs text-stone-400">—</span>;
  }
  const label = flags.some((f) => f.type === "repeated_quiz_failure")
    ? "Struggling"
    : "Inactive";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
        label === "Struggling" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
      )}
    >
      <AlertTriangle className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/** Learners tab: the roster. Rows link to the per-learner detail page. */
export function LearnersTab({
  roster,
  courseId,
  slug,
}: {
  roster: RosterRow[];
  courseId: string;
  slug: string;
}) {
  if (roster.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No learners yet"
        hint="Your roster appears as students enroll. Share your course link to get started."
        action={
          <Link
            href={`/learn/${slug}`}
            className="brand-gradient mt-1 rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
          >
            Open your course page
          </Link>
        }
      />
    );
  }

  return (
    <Card>
      <CardHeader
        title="Roster"
        subtitle={`${roster.length} learner${roster.length === 1 ? "" : "s"}`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {["Learner", "Enrolled", "Progress", "Last active", "Risk"].map((h) => (
                <th
                  key={h}
                  className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roster.map((row) => {
              const flags = rosterFlags(row);
              const pct = Number(row.progress_pct ?? 0);
              return (
                <tr key={row.user_id} className="group border-t border-stone-100">
                  <td className="px-5 py-3">
                    <Link
                      href={`/studio/${courseId}/analytics/learners/${row.user_id}`}
                      className="block"
                    >
                      <span className="block font-medium text-stone-800 group-hover:text-brand-700">
                        {row.display_name}
                      </span>
                      <span className="block text-xs text-stone-400">{row.email}</span>
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-stone-500">{formatDate(row.enrolled_at)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-stone-100">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            row.enrollment_status === "completed"
                              ? "bg-emerald-400"
                              : "brand-gradient"
                          )}
                          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-stone-500">
                        {pct.toFixed(0)}%
                      </span>
                      <span className="text-xs text-stone-400">
                        {row.completed_lessons}/{row.total_lessons}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-stone-500">{timeAgo(row.last_activity_at)}</td>
                  <td className="px-5 py-3">
                    <RiskBadge flags={flags} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
