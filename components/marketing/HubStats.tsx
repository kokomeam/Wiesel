/**
 * The hub status strip (UI-1 W2.3): 3–4 compact tiles sourced ONLY from data
 * the page already loads — no new backend queries.
 */

import { Card } from "@/components/ui/Card";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { StatusChip, type UiStatus } from "@/components/ui/StatusChip";

export interface HubStatsVM {
  campaignStatus: string | null;
  campaignGoal: string | null;
  queued: number;
  sent: number;
  needsReview: number;
  revertable: number;
  pagesPublished: number;
  pagesTotal: number;
}

/** Domain campaign status → the fixed semantic status (colors live in the chip). */
function campaignChipStatus(status: string): UiStatus {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "pending";
    case "archived":
      return "destructive";
    default:
      return "neutral";
  }
}

function Tile({
  label,
  value,
  sub,
  href,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  href?: string;
  testId: string;
}) {
  const body = (
    <>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1.5 flex min-h-7 items-center text-section font-semibold tabular-nums text-stone-900">
        {value}
      </div>
      <p className="mt-0.5 truncate text-meta text-stone-500">{sub}</p>
    </>
  );
  const cls = "block min-w-0 p-4";
  return (
    <Card data-testid={testId} className={href ? "transition-shadow hover:shadow-overlay" : undefined}>
      {href ? (
        <a href={href} className={cls}>
          {body}
        </a>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </Card>
  );
}

export function HubStats({ stats }: { stats: HubStatsVM }) {
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4" data-testid="hub-stats">
      <Tile
        testId="stat-campaign"
        label="Campaign"
        value={
          stats.campaignStatus ? (
            <StatusChip status={campaignChipStatus(stats.campaignStatus)} className="text-secondary">
              {stats.campaignStatus}
            </StatusChip>
          ) : (
            "None yet"
          )
        }
        sub={
          stats.campaignStatus
            ? `${stats.queued} queued · ${stats.sent} sent${stats.campaignGoal ? ` · ${stats.campaignGoal}` : ""}`
            : "Create one to start selling"
        }
      />
      <Tile
        testId="stat-review"
        label="Needs review"
        value={stats.needsReview}
        sub={stats.needsReview > 0 ? "waiting for your call" : "all clear"}
        href={stats.needsReview > 0 ? "#attention" : undefined}
      />
      <Tile
        testId="stat-revertable"
        label="Revertable changes"
        value={stats.revertable}
        sub="open revert windows"
      />
      <Tile
        testId="stat-pages"
        label="Landing pages"
        value={`${stats.pagesPublished}/${stats.pagesTotal}`}
        sub="published"
      />
    </div>
  );
}
