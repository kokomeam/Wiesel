import Link from "next/link";
import { CheckCircle2, ChevronRight, MailOpen, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { timeAgo } from "@/components/studio/analytics/format";
import type { AttentionFinding } from "@/lib/analytics/creatorHome";

export interface DraftGroup {
  courseId: string;
  courseTitle: string;
  count: number;
}

/**
 * "Needs your attention" — the top open maintenance-agent findings (severity
 * ranked, parsed defensively from the finding jsonb) plus per-course draft
 * message counts. Every row deep-links into the studio, where the AgentPanel's
 * findings list / DraftList carry the actual review actions. Empty = a calm
 * emerald all-clear, not a blank box. (The profile-completion nudge moved
 * into the CreatorIdentityHeader band, 2026-07-11.)
 */
export function AttentionRail({
  findings,
  drafts,
  courseTitles,
}: {
  findings: AttentionFinding[];
  drafts: DraftGroup[];
  courseTitles: Record<string, string>;
}) {
  const allClear = findings.length === 0 && drafts.length === 0;

  return (
    <Card>
      <div className="px-5 pt-5">
        <p className="font-mono text-[11px] uppercase tracking-wider text-brand-700">
          Needs your attention
        </p>
        <h2 className="mt-1 flex items-center gap-1.5 text-lg font-light text-stone-900 [font-family:var(--font-display)]">
          <Sparkles className="size-4 text-brand-500" aria-hidden />
          From your AI maintenance agent
        </h2>
      </div>

      {allClear ? (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 className="size-5" aria-hidden />
          </span>
          <p className="text-sm font-medium text-stone-700">All clear</p>
          <p className="max-w-xs text-xs leading-relaxed text-stone-400">
            No open findings or message drafts. The agent watches your live
            courses and flags anything that needs you.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5 p-4">
          {findings.map((finding) => (
            <Link
              key={finding.id}
              href={`/studio?course=${finding.courseId}`}
              className="group block rounded-xl border border-stone-200/80 bg-stone-50/40 p-3.5 transition-colors hover:border-brand-200 hover:bg-brand-50/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            >
              <div className="flex items-center justify-between gap-2">
                <Badge tone={finding.severity === "high" ? "rose" : "amber"} dot>
                  {finding.severity} severity
                </Badge>
                <span className="text-[11px] text-stone-400">
                  {timeAgo(finding.createdAt)}
                </span>
              </div>
              <p className="mt-2 text-sm font-semibold text-stone-900">
                {finding.title}
              </p>
              {finding.summary && (
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-stone-500">
                  {finding.summary}
                </p>
              )}
              <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 group-hover:text-brand-700">
                Review in {courseTitles[finding.courseId] ?? "the studio"}
                <ChevronRight className="size-3.5" aria-hidden />
              </span>
            </Link>
          ))}

          {drafts.map((group) => (
            <Link
              key={group.courseId}
              href={`/studio?course=${group.courseId}`}
              className="group flex items-center gap-3 rounded-xl border border-stone-200/80 bg-stone-50/40 p-3.5 transition-colors hover:border-brand-200 hover:bg-brand-50/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-stone-200">
                <MailOpen className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-stone-900">
                  {group.count} message draft{group.count === 1 ? "" : "s"} awaiting
                  review
                </span>
                <span className="block truncate text-xs text-stone-400">
                  {group.courseTitle}
                </span>
              </span>
              <ChevronRight
                className="size-4 shrink-0 text-stone-300 transition-colors group-hover:text-brand-500"
                aria-hidden
              />
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
