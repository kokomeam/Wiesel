"use client";

/**
 * Marketing hub — the creator surface, restructured in UI-1 Wave 2 around
 * one rule: the only LOUD things are what needs the creator right now and
 * the agent's visible work log.
 *
 *   1. Ask bar — the agent, one keystroke away (the product's front door).
 *   2. Section nav — every marketing destination, grouped, one click
 *      (SectionNav; replaces the old rail-resident Explore list).
 *   3. "Needs your attention" — pending approvals + open questions, only
 *      when they exist. The single loud zone.
 *   4. Status strip + work column: stat tiles from already-loaded data, the
 *      campaign card, and the landing pages.
 *   5. Quiet rail (right): the Activity log and the Autonomy status pill
 *      (which opens the settings Drawer).
 *
 * Every button routes a server action → the shared tool layer + gate.
 */

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  Check,
  ExternalLink,
  Eye,
  HelpCircle,
  Loader2,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatusChip, type UiStatus } from "@/components/ui/StatusChip";
import { ActivityFeed, type ActivityFeedEntryVM } from "@/components/marketing/ActivityFeed";
import { ApprovalCard } from "@/components/marketing/ApprovalCard";
import { AutonomyPill } from "@/components/marketing/AutonomyPill";
import { CampaignCard, type CampaignVM } from "@/components/marketing/CampaignCard";
import { HubStats } from "@/components/marketing/HubStats";
import { QuestionCard, type QuestionCardOption } from "@/components/marketing/QuestionCard";
import { SectionNav } from "@/components/marketing/SectionNav";
import type { AutonomySettingsWithMeta } from "@/lib/marketing/autonomyStore";
import { useAgentDockStore } from "@/lib/marketing/agentDockStore";
import { PUBLISH_CHAT_SUGGESTIONS } from "@/components/marketing/publish/ChatPublishCards";
import { useHubUi } from "@/lib/marketing/hubUiStore";
import {
  generateKitAction,
  generateLandingPageAction,
  publishPageAction,
  unpublishPageAction,
  type ActionResult,
  type PendingActionPayload,
} from "./actions";

export interface QuestionVM {
  id: string;
  question: string;
  options: QuestionCardOption[];
}

export interface LandingPageVM {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published" | "unpublished";
  sectionCount: number;
  hasOpenAction: boolean;
}

const pageStatus: Record<LandingPageVM["status"], UiStatus> = {
  draft: "neutral",
  published: "success",
  unpublished: "destructive",
};

// The connected-publishing chip strings come from the allowlisted publish
// module — this file carries no publish vocabulary of its own (AC-MD.5).
const ASK_SUGGESTIONS = [
  "Put everyone who consented on a mailing list",
  "How is my funnel doing?",
  "Draft a follow-up for people who viewed but didn't enroll",
  ...PUBLISH_CHAT_SUGGESTIONS,
];

export function MarketingHub({
  courseId,
  courseTitle,
  campaign,
  pages,
  pending,
  questions,
  activity,
  autonomy,
  courses,
}: {
  courseId: string;
  courseTitle: string;
  campaign: CampaignVM | null;
  pages: LandingPageVM[];
  pending: PendingActionPayload[];
  questions: QuestionVM[];
  activity: ActivityFeedEntryVM[];
  autonomy: AutonomySettingsWithMeta;
  courses: { id: string; title: string }[];
}) {
  const router = useRouter();
  const openDock = useAgentDockStore((s) => s.openDock);
  const [ask, setAsk] = useState("");
  const [busy, startTransition] = useTransition();
  const [toast, setToast] = useState<ActionResult | null>(null);
  /** In-place approval cards for pages whose publish/unpublish was just
   *  requested — the card renders on the page row, no scroll-to-inbox. */
  const [pagePending, setPagePending] = useState<Record<string, PendingActionPayload>>({});

  // Disclosure state persists per browser; skipHydration keeps SSR stable.
  useEffect(() => {
    void useHubUi.persist.rehydrate();
  }, []);

  const run = (fn: () => Promise<ActionResult | void>) =>
    startTransition(async () => {
      const r = await fn();
      if (r) setToast(r);
    });
  const runPageRequest = (pageId: string, fn: () => Promise<ActionResult>) =>
    startTransition(async () => {
      const r = await fn();
      if (r.pending) {
        setPagePending((cur) => ({ ...cur, [pageId]: r.pending! }));
      } else {
        setToast(r);
      }
    });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const attentionCount = pending.length + questions.length;
  const revertable = activity.filter((a) => a.canRevert).length;

  return (
    <div className="mx-auto max-w-7xl space-y-section-gap p-6 lg:p-8">
      {toast ? (
        // Above the FAB's reserved dock (z + offset): the toast never covers it.
        <div className="fixed bottom-24 right-6 z-60 flex max-w-sm items-center gap-3 rounded-panel border border-stone-200 bg-white px-4 py-3 text-body shadow-overlay">
          <Check className="size-4 shrink-0 text-status-success" />
          <span className="min-w-0 text-stone-700">{toast.message}</span>
          {toast.href ? (
            <Link
              href={toast.href}
              target={toast.href.startsWith("/p/") ? "_blank" : undefined}
              className="shrink-0 font-medium text-brand-700 hover:underline"
            >
              {toast.hrefLabel ?? "Open"}
            </Link>
          ) : null}
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="shrink-0 text-stone-500 hover:text-stone-600">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <PageHeader
        title="Marketing Assistant"
        description={`Sell “${courseTitle}.” Generate the kit, review every draft, and approve anything that reaches a real person.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {courses.length > 1 ? (
              <select
                value={courseId}
                onChange={(e) => router.push(`/marketing?course=${e.target.value}`)}
                className="h-9 rounded-full border border-stone-300/80 bg-white px-3 text-body text-stone-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                aria-label="Choose course"
              >
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            ) : null}
            <Link
              href="/marketing/overview"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-300/80 bg-white px-4 text-body font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50"
            >
              <BarChart3 className="size-4" /> Overview
            </Link>
            <Button onClick={() => run(() => generateKitAction(courseId))} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Generate Kit
            </Button>
          </div>
        }
      />

      {/* every destination, grouped, one click (replaces the Explore rail) */}
      <SectionNav courseId={courseId} />

      {/* the agent, front and center — one keystroke away from any ask */}
      <Card className="p-card-pad">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ask.trim()) return openDock();
            openDock(ask);
            setAsk("");
          }}
          className="flex items-center gap-3"
        >
          <span className="brand-gradient grid size-9 shrink-0 place-items-center rounded-panel font-display text-lg text-white">
            *
          </span>
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Ask your marketing agent anything — it can build lists, draft campaigns, pause sends, and read your funnel…"
            className="h-10 min-w-0 flex-1 rounded-panel border border-stone-200 bg-stone-50/60 px-3.5 text-body text-stone-900 placeholder:text-stone-500 focus:border-brand-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/15"
            aria-label="Ask the marketing agent"
          />
          <Button type="submit">
            <Wand2 className="size-4" /> Ask
          </Button>
        </form>
        <div className="mt-2.5 flex flex-wrap gap-1.5 sm:pl-12">
          {ASK_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => openDock(s)}
              className="rounded-full border border-stone-200 bg-white px-3 py-1 text-meta text-stone-500 transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-800"
            >
              {s}
            </button>
          ))}
        </div>
      </Card>

      {/* Needs your attention — the ONE loud zone (approvals + questions) */}
      {attentionCount > 0 ? (
        <section className="scroll-mt-6 space-y-2.5" id="attention" data-testid="attention-zone">
          <h2 className="flex items-center gap-2 text-body font-semibold text-stone-900">
            {pending.length > 0 ? (
              <AlertTriangle className="size-4 text-status-attention" />
            ) : (
              <HelpCircle className="size-4 text-status-attention" />
            )}
            Needs your attention
            <Badge tone="rose">{attentionCount}</Badge>
          </h2>
          <div className="space-y-3">
            {pending.map((p) => (
              <ApprovalCard key={p.actionId} pending={p} onResult={setToast} />
            ))}
            {questions.map((q) => (
              <QuestionCard key={q.id} questionId={q.id} question={q.question} options={q.options} onResult={setToast} />
            ))}
          </div>
        </section>
      ) : null}

      {/* status strip — data the page already loads, nothing new queried */}
      <HubStats
        stats={{
          campaignStatus: campaign?.status ?? null,
          campaignGoal: campaign?.goalLabel ?? null,
          queued: campaign?.queued ?? 0,
          sent: campaign?.sent ?? 0,
          needsReview: attentionCount,
          revertable,
          pagesPublished: pages.filter((p) => p.status === "published").length,
          pagesTotal: pages.length,
        }}
      />

      <div className="grid grid-cols-1 items-start gap-gutter lg:grid-cols-[minmax(0,1fr)_var(--spacing-rail)]">
        {/* ── work column ── */}
        <div className="min-w-0 space-y-section-gap">
          <CampaignCard campaign={campaign} courseId={courseId} />

          <Card>
            <CardHeader
              as="h2"
              title="Landing pages"
              subtitle={pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"}` : undefined}
              action={
                pages.length > 0 ? (
                  <Button size="sm" variant="outline" onClick={() => run(() => generateLandingPageAction(courseId))} disabled={busy}>
                    <Sparkles className="size-3.5" /> Generate
                  </Button>
                ) : undefined
              }
            />
            <div className="p-card-pad">
              {pages.length === 0 ? (
                <div className="rounded-panel border border-dashed border-stone-300 bg-white/60 p-8 text-center">
                  <p className="text-stone-600">No landing page yet.</p>
                  <p className="mt-1 text-body text-stone-500">
                    Generate the kit, or just a page — you’ll review every section before it goes live.
                  </p>
                  <Button className="mt-4" onClick={() => run(() => generateLandingPageAction(courseId))} disabled={busy}>
                    <Sparkles className="size-4" /> Generate landing page
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-stone-100">
                  {pages.map((p) => (
                    <div key={p.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <span className="min-w-0 truncate font-medium text-stone-900">{p.title}</span>
                      <StatusChip status={pageStatus[p.status]}>{p.status}</StatusChip>
                      <code className="rounded-control bg-stone-100 px-2 py-0.5 font-mono text-meta text-stone-600">/p/{p.slug}</code>
                      <span className="text-meta text-stone-500">{p.sectionCount} sections</span>
                      <span className="flex-1" />
                      <Link
                        href={`/marketing/landing/${p.id}`}
                        className="inline-flex items-center gap-1.5 text-body font-medium text-brand-700 hover:text-brand-800"
                      >
                        <Wand2 className="size-3.5" /> Edit with AI
                      </Link>
                      <Link
                        href={`/marketing/preview/${p.id}`}
                        className="inline-flex items-center gap-1.5 text-body font-medium text-stone-600 hover:text-stone-900"
                      >
                        <Eye className="size-3.5" /> Preview
                      </Link>
                      {p.status === "published" ? (
                        <Link
                          href={`/p/${p.slug}`}
                          target="_blank"
                          className="inline-flex items-center gap-1.5 text-body font-medium text-brand-700 hover:gap-2"
                        >
                          View live <ExternalLink className="size-3.5" />
                        </Link>
                      ) : null}
                      {p.hasOpenAction && !pagePending[p.id] ? (
                        <span className="text-meta italic text-stone-500">awaiting approval above</span>
                      ) : pagePending[p.id] ? null : p.status === "published" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runPageRequest(p.id, () => unpublishPageAction(courseId, p.id))}
                          disabled={busy}
                        >
                          Unpublish
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => runPageRequest(p.id, () => publishPageAction(courseId, p.id))}
                          disabled={busy}
                        >
                          Publish
                        </Button>
                      )}
                      {pagePending[p.id] ? (
                        <div className="w-full">
                          <ApprovalCard
                            pending={pagePending[p.id]}
                            onResult={setToast}
                            onResolved={() =>
                              setPagePending((cur) => {
                                const next = { ...cur };
                                delete next[p.id];
                                return next;
                              })
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ── quiet rail: the agent's work log + the autonomy pill ── */}
        <div className="min-w-0 space-y-section-gap">
          <ActivityFeed entries={activity} onResult={setToast} />

          <AutonomyPill courseId={courseId} autonomy={autonomy} onResult={setToast} />
        </div>
      </div>
    </div>
  );
}
