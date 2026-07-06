"use client";

/**
 * The hub's campaign card — one glance at the running campaign: status,
 * delivery counts, and the lifecycle controls (Pause / Resume / Cancel…)
 * that previously existed only inside the builder. A paused campaign says
 * exactly what "paused" means (held, not lost); a guardrail auto-pause says
 * why it tripped.
 */

import Link from "next/link";
import { AlertTriangle, ArrowRight, Megaphone, PauseCircle, Plus } from "lucide-react";
import { CampaignLifecycleControls } from "@/components/marketing/LifecycleControls";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

export interface CampaignVM {
  id: string;
  name: string;
  status: string;
  goalLabel: string | null;
  queued: number;
  sent: number;
  sequenceCount: number;
  autoPause: { metric: string; value: number; threshold: number } | null;
}

const STATUS_TONE: Record<string, "slate" | "sky" | "amber" | "green" | "rose" | "brand"> = {
  draft: "slate",
  generated: "sky",
  in_review: "amber",
  approved: "green",
  active: "brand",
  sending: "brand",
  paused: "sky",
  completed: "green",
  cancelled: "rose",
  failed: "rose",
};

export function CampaignCard({ campaign, courseId }: { campaign: CampaignVM | null; courseId: string }) {
  if (!campaign) {
    return (
      <Card className="p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">Campaign</p>
        <p className="mt-2 text-sm text-stone-600">No campaign yet — pick a goal and the AI drafts the full email sequence for review.</p>
        <Link
          href={`/marketing/email/new?course=${courseId}`}
          className="brand-gradient mt-3 inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
        >
          <Plus className="size-4" /> Create campaign
        </Link>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
          <Megaphone className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-stone-900">{campaign.name}</span>
            <Badge tone={STATUS_TONE[campaign.status] ?? "slate"} dot>
              {campaign.status.replace(/_/g, " ")}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-stone-500">
            {campaign.goalLabel ? `${campaign.goalLabel} · ` : ""}
            {campaign.sequenceCount} sequence{campaign.sequenceCount === 1 ? "" : "s"} · {campaign.queued} queued ·{" "}
            {campaign.sent} sent
          </p>
        </div>
        <CampaignLifecycleControls campaignId={campaign.id} status={campaign.status} />
        <Link
          href={`/marketing/email/${campaign.id}`}
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-600 transition-all hover:gap-2"
        >
          Open <ArrowRight className="size-3.5" />
        </Link>
      </div>

      {campaign.autoPause ? (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>
            <span className="font-semibold">Auto-paused by a guardrail</span> —{" "}
            {campaign.autoPause.metric.replace(/_/g, " ")} hit {(campaign.autoPause.value * 100).toFixed(1)}%
            (threshold {(campaign.autoPause.threshold * 100).toFixed(1)}%). Review the list, then Resume.
          </p>
        </div>
      ) : campaign.status === "paused" ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-stone-500">
          <PauseCircle className="size-3.5 text-stone-400" />
          Paused — the {campaign.queued} queued send{campaign.queued === 1 ? " is" : "s are"} held, not deleted.
          Resume continues exactly where it stopped.
        </p>
      ) : null}
    </Card>
  );
}
