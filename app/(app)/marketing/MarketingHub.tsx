"use client";

/**
 * Marketing hub — the creator surface, redesigned around one rule: the only
 * LOUD thing is what needs the creator right now.
 *
 *   1. Ask bar — the agent, one keystroke away (the product's front door).
 *   2. "Needs your attention" — pending approvals + open questions, only when
 *      they exist. The single loud zone.
 *   3. Work column (left): the campaign card (status + delivery + the
 *      Pause/Resume/Cancel controls) and the landing pages.
 *   4. Quiet rail (right): compact navigation, then Recent changes and Agent
 *      autonomy as COLLAPSIBLE cards (disclosure state persists per browser
 *      via lib/marketing/hubUiStore).
 *
 * Every button routes a server action → the shared tool layer + gate.
 */

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Check,
  ExternalLink,
  Eye,
  HelpCircle,
  Loader2,
  Mail,
  Send,
  Clapperboard,
  Share2,
  Sparkles,
  UserPlus,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { CollapsibleCard } from "@/components/ui/CollapsibleCard";
import { ActivityLogEntry, type ActivityEntryVM } from "@/components/marketing/ActivityLogEntry";
import { ApprovalCard } from "@/components/marketing/ApprovalCard";
import { AutonomySettings } from "@/components/marketing/AutonomySettings";
import { CampaignCard, type CampaignVM } from "@/components/marketing/CampaignCard";
import { QuestionCard, type QuestionCardOption } from "@/components/marketing/QuestionCard";
import type { AutonomySettings as AutonomySettingsModel } from "@/lib/marketing/autonomy";
import { useAgentDockStore } from "@/lib/marketing/agentDockStore";
import { useHubUi, type HubSectionKey } from "@/lib/marketing/hubUiStore";
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

const statusTone: Record<LandingPageVM["status"], "amber" | "green" | "slate"> = {
  draft: "amber",
  published: "green",
  unpublished: "slate",
};

const ASK_SUGGESTIONS = [
  "Put everyone who consented on a mailing list",
  "How is my funnel doing?",
  "Draft a follow-up for people who viewed but didn't enroll",
];

const EXPLORE_LINKS: { href: string; icon: typeof Mail; label: string; sub: string }[] = [
  { href: "/marketing/email", icon: Mail, label: "Email campaigns", sub: "Goal-driven sequences, reviewed by you" },
  { href: "/marketing/leads", icon: UserPlus, label: "Leads", sub: "Consent-first lists and imports" },
  { href: "/marketing/audience", icon: Users, label: "Audience", sub: "Subscribers and funnel stages" },
  { href: "/marketing/sequences", icon: Send, label: "Sequences", sub: "What sends, when, to whom" },
  { href: "/marketing/social", icon: Share2, label: "Social posts", sub: "Drafts you copy and post yourself" },
  { href: "/marketing/clips", icon: Clapperboard, label: "Lesson clips", sub: "Short verticals cut from your lessons" },
  { href: "/marketing/analytics", icon: BarChart3, label: "Analytics", sub: "Views, clicks, enrollments" },
  { href: "/marketing/agent", icon: Wand2, label: "Agent", sub: "Full-screen chat" },
];

/** A collapsible bound to the persisted hub UI store, with a per-section
 *  default for first-time visitors. */
function HubSection({
  sectionKey,
  defaultOpen,
  ...rest
}: {
  sectionKey: HubSectionKey;
  defaultOpen: boolean;
} & Omit<Parameters<typeof CollapsibleCard>[0], "open" | "onToggle">) {
  const stored = useHubUi((s) => s.open[sectionKey]);
  const setOpen = useHubUi((s) => s.setOpen);
  return <CollapsibleCard {...rest} open={stored ?? defaultOpen} onToggle={(v) => setOpen(sectionKey, v)} />;
}

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
  activity: ActivityEntryVM[];
  autonomy: AutonomySettingsModel;
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
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 flex max-w-sm items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm shadow-lg">
          <Check className="size-4 shrink-0 text-emerald-600" />
          <span className="text-stone-700">{toast.message}</span>
          {toast.href ? (
            <Link
              href={toast.href}
              target={toast.href.startsWith("/p/") ? "_blank" : undefined}
              className="shrink-0 font-medium text-brand-600 hover:underline"
            >
              {toast.hrefLabel ?? "Open"}
            </Link>
          ) : null}
          <button onClick={() => setToast(null)} className="shrink-0 text-stone-400 hover:text-stone-600">
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
                className="h-9 rounded-full border border-stone-300/80 bg-white px-3 text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
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
              className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-300/80 bg-white px-4 text-sm font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50"
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

      {/* the agent, front and center — one keystroke away from any ask */}
      <Card className="p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ask.trim()) return openDock();
            openDock(ask);
            setAsk("");
          }}
          className="flex items-center gap-3"
        >
          <span className="brand-gradient grid size-9 shrink-0 place-items-center rounded-xl text-white [font-family:var(--font-display)] text-lg">
            *
          </span>
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Ask your marketing agent anything — it can build lists, draft campaigns, pause sends, and read your funnel…"
            className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 bg-stone-50/60 px-3.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-brand-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/15"
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
              className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-500 transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"
            >
              {s}
            </button>
          ))}
        </div>
      </Card>

      {/* Needs your attention — the ONE loud zone (approvals + questions) */}
      {attentionCount > 0 ? (
        <section className="space-y-2.5" data-testid="attention-zone">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            {pending.length > 0 ? (
              <AlertTriangle className="size-4 text-rose-500" />
            ) : (
              <HelpCircle className="size-4 text-sky-500" />
            )}
            Needs your attention
            <Badge tone={pending.length > 0 ? "rose" : "sky"}>{attentionCount}</Badge>
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

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── work column ── */}
        <div className="min-w-0 space-y-6">
          <CampaignCard campaign={campaign} courseId={courseId} />

          <Card>
            <CardHeader
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
            <div className="p-4">
              {pages.length === 0 ? (
                <div className="rounded-xl border border-dashed border-stone-300 bg-white/60 p-8 text-center">
                  <p className="text-stone-600">No landing page yet.</p>
                  <p className="mt-1 text-sm text-stone-400">
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
                      <span className="font-medium text-stone-900">{p.title}</span>
                      <Badge tone={statusTone[p.status]} dot>
                        {p.status}
                      </Badge>
                      <code className="rounded-md bg-stone-100 px-2 py-0.5 font-mono text-xs text-stone-500">/p/{p.slug}</code>
                      <span className="text-xs text-stone-400">{p.sectionCount} sections</span>
                      <span className="flex-1" />
                      <Link
                        href={`/marketing/landing/${p.id}`}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700"
                      >
                        <Wand2 className="size-3.5" /> Edit with AI
                      </Link>
                      <Link
                        href={`/marketing/preview/${p.id}`}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-600 hover:text-stone-900"
                      >
                        <Eye className="size-3.5" /> Preview
                      </Link>
                      {p.status === "published" ? (
                        <Link
                          href={`/p/${p.slug}`}
                          target="_blank"
                          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:gap-2"
                        >
                          View live <ExternalLink className="size-3.5" />
                        </Link>
                      ) : null}
                      {p.hasOpenAction && !pagePending[p.id] ? (
                        <span className="text-xs italic text-stone-400">awaiting approval above</span>
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

        {/* ── quiet rail ── */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Explore" className="py-3" />
            <nav className="p-2">
              {EXPLORE_LINKS.map(({ href, icon: Icon, label, sub }) => (
                <Link
                  key={href}
                  href={`${href}?course=${courseId}`}
                  className="group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-stone-50"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-brand-100">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-stone-800">{label}</span>
                    <span className="block truncate text-xs text-stone-400">{sub}</span>
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-stone-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500" />
                </Link>
              ))}
            </nav>
          </Card>

          {activity.length > 0 ? (
            <HubSection
              sectionKey="activity"
              defaultOpen={revertable > 0}
              title="Recent changes"
              subtitle="Drafts and edits apply automatically — revert anything while its window is open."
              badge={
                <Badge tone={revertable > 0 ? "amber" : "slate"}>
                  {revertable > 0 ? `${revertable} revertable` : activity.length}
                </Badge>
              }
            >
              <div className="-my-1">
                {activity.map((a) => (
                  <ActivityLogEntry key={a.id} entry={a} onResult={setToast} />
                ))}
              </div>
            </HubSection>
          ) : null}

          <HubSection
            sectionKey="autonomy"
            defaultOpen={false}
            title="Agent autonomy"
            subtitle="How much the agent may do without a card."
            badge={<Badge tone={autonomy.mode === "auto" ? "brand" : "slate"}>{autonomy.mode}</Badge>}
          >
            <AutonomySettings courseId={courseId} initial={autonomy} onResult={setToast} embedded />
          </HubSection>
        </div>
      </div>
    </div>
  );
}
