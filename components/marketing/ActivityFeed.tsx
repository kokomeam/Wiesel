"use client";

/**
 * The Activity timeline (UI-1 Wave 3) — the agent's visible work log, and the
 * product's signature element: everything the agent did, one line each, with
 * status, expandable detail, and inline revert while the window is open.
 *
 * Entry anatomy (W3.2): category icon · ≤80-char verb-first summary
 * (deterministic template over the tool union — never stored prose) ·
 * StatusChip · relative timestamp (tabular; absolute on hover). Click
 * expands: clean rationale, translated metadata chips, entity link, the
 * humanized policy routing (W3.7/D-14), and Revert/Dismiss.
 *
 * Historical prose-only rows (no summary_fields) render under the generic
 * humanized template; their stored prose appears ONLY in the expanded detail,
 * clearly dated — internal vocabulary and baked URLs never render collapsed
 * (D-11/D-12/D-19). Short links resolve against the CURRENT origin.
 */

import { useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ExternalLink, Loader2, Undo2 } from "lucide-react";
import {
  acceptStagedAction,
  rejectStagedAction,
  type ActionResult,
} from "@/app/(app)/marketing/actions";
import {
  activityChip,
  detailMetadata,
  explainGuardrail,
  parseSummaryFields,
  summarizeAction,
  type ActionSummaryFields,
} from "@/lib/marketing/activitySummaries";
import { humanizeToolName } from "@/lib/marketing/humanize";
import { useAgentDockStore as useAgentDockStoreRef } from "@/lib/marketing/agentDockStore";
import { useAutonomyDrawer } from "@/lib/marketing/autonomyDrawerStore";
import { useHubUi } from "@/lib/marketing/hubUiStore";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";

export interface ActivityFeedEntryVM {
  id: string;
  toolName: string;
  status: string;
  requestedBy: "user" | "agent";
  /** parsed marketing_action.summary_fields (null on historical rows). */
  fields: ActionSummaryFields | null;
  /** The stored prose summary — expanded detail only, never collapsed. */
  legacyProse: string | null;
  /** Autonomy routing (D-14/D-16): failed guardrail NAMES + how it routed. */
  routedToApproval: boolean;
  autoExecuted: boolean;
  failedGuardrails: string[];
  targetRef: { entity: string; id: string } | null;
  /** Server-computed against one clock (no hydration drift). */
  relative: string;
  absolute: string;
  day: string;
  canRevert: boolean;
  revertWindowLabel: string | null;
}

const DEFAULT_VISIBLE = 7;
const SHOW_MORE_STEP = 20;

/** Exported for the copy-lint corpus (W5.1). */
export const REVERT_EXPLAINER =
  "Drafts and edits the agent makes apply automatically and stay revertible here while their window is open (24 hours by default — configurable in Agent autonomy). Anything that reaches a real person still asks you first.";

/** Exported for the copy-lint corpus (W5.1); one of the three trust-copy
 *  locations (W3.8). */
export const ACTIVITY_HINT_COPY =
  "This is the agent's work log. Drafts and edits apply automatically and stay revertible while their window is open. WiseSel never posts to social platforms for you — anything outward always asks first.";

export const ACTIVITY_EMPTY_COPY =
  "No activity yet — ask the agent to draft your first campaign. Everything it does lands here, revertible.";

/** Where an entry's target entity can be opened. */
function targetHref(ref: { entity: string; id: string } | null): string | null {
  if (!ref) return null;
  switch (ref.entity) {
    case "landing_page":
      return `/marketing/preview/${ref.id}`;
    case "social_post":
      return "/marketing/social";
    case "clip_render_job":
    case "clip_moment_candidate":
      return "/marketing/clips";
    case "lead_list":
      return "/marketing/leads";
    case "campaign":
      return "/marketing/email";
    case "email_sequence":
      return `/marketing/sequences/${ref.id}`;
    default:
      return null;
  }
}

function subscribeToNothing() {
  return () => {};
}

function ShortLink({ code }: { code: string }) {
  // Origin resolved at RENDER time (the ClipsView pattern) — a baked env URL
  // never reaches the creator (D-12/D-19).
  const origin = useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => ""
  );
  const href = `${origin}/l/${code}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
      {origin ? `${origin.replace(/^https?:\/\//, "")}/l/${code}` : `/l/${code}`}
      <ExternalLink className="size-3" />
    </a>
  );
}

function Entry({ entry, onResult }: { entry: ActivityFeedEntryVM; onResult?: (r: ActionResult) => void }) {
  const router = useRouter();
  const openAutonomy = useAutonomyDrawer((s) => s.setOpen);
  const [expanded, setExpanded] = useState(false);
  const [gone, setGone] = useState<"reverted" | "dismissed" | null>(null);
  const [busy, startTransition] = useTransition();

  if (gone) {
    return (
      <div className="py-1.5 text-meta text-stone-500">
        {gone === "reverted" ? "Reverted — the change was rolled back." : null}
      </div>
    );
  }

  const run = (kind: "revert" | "dismiss") =>
    startTransition(async () => {
      const r = kind === "revert" ? await rejectStagedAction(entry.id) : await acceptStagedAction(entry.id);
      onResult?.(r);
      if (!r.error) setGone(kind === "revert" ? "reverted" : "dismissed");
      router.refresh();
    });

  const line = summarizeAction(entry.toolName, entry.fields);
  const chip = activityChip({
    toolName: entry.toolName,
    status: entry.status,
    summaryFields: entry.fields,
    routedToApproval: entry.routedToApproval,
    autoExecuted: entry.autoExecuted,
  });
  const { icon: Icon } = humanizeToolName(entry.toolName);
  const metadata = detailMetadata(entry.fields);
  const href = targetHref(entry.targetRef);
  const hasDetail = true; // every entry expands: actions/routing live there

  return (
    <div className="border-b border-stone-100 last:border-b-0" data-testid="activity-entry">
      {/* One line (W3.2): the expand toggle is the flexible left segment;
          chip/revert/time are SIBLINGS (a control inside the toggle would be
          a nested button). Collapsed rows keep one-click revert via the
          compact icon control (INV-2). */}
      <div className="flex items-center gap-2 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control text-left transition-colors hover:bg-stone-50/80"
        >
          <Icon className="size-4 shrink-0 text-stone-500" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-secondary font-medium text-stone-800" data-testid="activity-line">
            {line}
          </span>
        </button>
        <StatusChip status={chip.status}>{chip.label}</StatusChip>
        {!expanded && !entry.autoExecuted && entry.canRevert ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => run("revert")}
            aria-label={`Revert · ${entry.revertWindowLabel}`}
            title={`Revert · ${entry.revertWindowLabel}`}
            className="grid size-6 shrink-0 place-items-center rounded-full text-stone-500 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-700"
            data-testid="activity-revert-inline"
          >
            <Undo2 className="size-3.5" />
          </button>
        ) : null}
        <time className="shrink-0 text-meta tabular-nums text-stone-500" title={entry.absolute}>
          {entry.relative}
        </time>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => setExpanded((v) => !v)}
          className="grid size-5 shrink-0 place-items-center text-stone-300"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      </div>

      {expanded && hasDetail ? (
        <div className="space-y-2 pb-3 pl-6" data-testid="activity-detail">
          {entry.fields?.note ? (
            <p className="text-secondary leading-relaxed text-stone-600">{entry.fields.note}</p>
          ) : null}

          {metadata.length > 0 || entry.fields?.shortCode ? (
            <div className="flex flex-wrap items-center gap-1.5 text-meta">
              {metadata.map((m) => (
                <span key={m.label} className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">
                  <span className="font-medium">{m.label}</span> {m.value}
                </span>
              ))}
              {entry.fields?.shortCode ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">
                  <span className="font-medium">Link</span> <ShortLink code={entry.fields.shortCode} />
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Policy routing, in creator language (W3.7 / D-14 / D-16). */}
          {entry.routedToApproval && entry.status === "executed" ? (
            <div className="rounded-panel bg-stone-50 p-2.5 text-meta leading-relaxed text-stone-500">
              <p>
                This asked you first{entry.failedGuardrails.length ? " — " : "."}
                {entry.failedGuardrails.map((g) => explainGuardrail(g)).join(" ")}
              </p>
              <p className="mt-0.5 text-stone-600">You approved it.</p>
              <button
                type="button"
                onClick={() => openAutonomy(true)}
                className="mt-1 font-medium text-brand-700 hover:underline"
              >
                Change autonomy settings
              </button>
            </div>
          ) : entry.autoExecuted ? (
            <div className="rounded-panel bg-stone-50 p-2.5 text-meta leading-relaxed text-stone-500">
              <p>Ran on its own under your auto policy — every guardrail passed.</p>
              <button
                type="button"
                onClick={() => openAutonomy(true)}
                className="mt-1 font-medium text-brand-700 hover:underline"
              >
                Change autonomy settings
              </button>
            </div>
          ) : null}

          {/* Historical rows: the stored prose, clearly framed, detail-only. */}
          {!entry.fields && entry.legacyProse ? (
            <p className="whitespace-pre-wrap text-meta leading-relaxed text-stone-500">{entry.legacyProse}</p>
          ) : null}

          <div className="flex items-center gap-1.5">
            {href ? (
              <Link href={href} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium text-brand-700 hover:bg-brand-50">
                Open <ExternalLink className="size-3" />
              </Link>
            ) : null}
            <span className="flex-1" />
            {busy ? <Loader2 className="size-3 animate-spin text-stone-500" /> : null}
            {!entry.autoExecuted && entry.canRevert ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => run("revert")}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta text-stone-500 hover:bg-stone-900/[0.06] hover:text-stone-800"
              >
                <Undo2 className="size-3" /> Revert · {entry.revertWindowLabel}
              </button>
            ) : null}
            {entry.status === "auto_approved" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => run("dismiss")}
                className="rounded-full px-2 py-0.5 text-meta text-stone-500 hover:bg-stone-900/[0.06] hover:text-stone-600"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

    </div>
  );
}

export function ActivityFeed({
  entries,
  onResult,
}: {
  entries: ActivityFeedEntryVM[];
  onResult?: (r: ActionResult) => void;
}) {
  const [visible, setVisible] = useState(DEFAULT_VISIBLE);
  const hintDismissed = useHubUi((s) => s.activityHintDismissed);
  const dismissHint = useHubUi((s) => s.dismissActivityHint);
  const revertable = entries.filter((e) => e.canRevert).length;
  const shown = entries.slice(0, visible);

  // Group the visible slice by server-computed day labels.
  const groups: { day: string; items: ActivityFeedEntryVM[] }[] = [];
  for (const e of shown) {
    const last = groups[groups.length - 1];
    if (last && last.day === e.day) last.items.push(e);
    else groups.push({ day: e.day, items: [e] });
  }

  return (
    <Card data-testid="activity-feed">
      <div className="px-card-pad pb-1 pt-3.5">
        <SectionHeader
          title="Activity"
          badge={
            <Badge tone={revertable > 0 ? "amber" : "slate"}>
              {revertable > 0 ? `${revertable} revertable` : entries.length}
            </Badge>
          }
          info={REVERT_EXPLAINER}
        />
      </div>

      {!hintDismissed && entries.length > 0 ? (
        <div className="mx-card-pad mb-1 flex items-start gap-2 rounded-panel bg-brand-50/60 p-2.5 text-meta leading-relaxed text-stone-600" data-testid="activity-hint">
          <p className="min-w-0 flex-1">{ACTIVITY_HINT_COPY}</p>
          <button
            type="button"
            onClick={dismissHint}
            className="shrink-0 rounded-full px-2 py-0.5 font-medium text-brand-700 hover:bg-brand-100"
          >
            Got it
          </button>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="px-card-pad pb-5 pt-2 text-center" data-testid="activity-empty">
          <span className="mx-auto grid size-9 place-items-center rounded-panel bg-stone-100 text-stone-500">
            <Undo2 className="size-4" aria-hidden />
          </span>
          <p className="mt-2 text-secondary leading-relaxed text-stone-600">{ACTIVITY_EMPTY_COPY}</p>
          <button
            type="button"
            onClick={() => useAgentDockStoreRef.getState().openDock()}
            className="mt-2 text-meta font-medium text-brand-700 hover:underline"
          >
            Ask the agent
          </button>
        </div>
      ) : null}

      <div className="px-card-pad pb-2">
        {groups.map((g) => (
          <div key={g.day}>
            <div className="sticky top-0 z-10 -mx-1 bg-white/95 px-1 py-1 backdrop-blur-sm">
              <p className="font-mono text-meta uppercase tracking-eyebrow text-stone-500">{g.day}</p>
            </div>
            {g.items.map((e) => (
              <Entry key={e.id} entry={e} onResult={onResult} />
            ))}
          </div>
        ))}
      </div>

      {entries.length > visible ? (
        <div className="border-t border-stone-100 px-card-pad py-2">
          <button
            type="button"
            onClick={() => setVisible((v) => v + SHOW_MORE_STEP)}
            className="text-meta font-medium text-brand-700 hover:underline"
            data-testid="activity-show-all"
          >
            Show all activity ({entries.length})
          </button>
        </div>
      ) : null}
    </Card>
  );
}

export { parseSummaryFields };
