"use client";

/**
 * Marketing hub — the creator surface. A unified approval inbox sits up top:
 * staged reversible changes (Accept/Reject) and pending irreversible actions
 * (Approve/Deny), whatever surface created them (Generate Kit, a card, or the
 * agent). Below: the landing pages, and links to the analytics dashboard + the
 * Marketing Agent. Every button routes a server action → the shared tool layer
 * + gate.
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
  Globe,
  Loader2,
  Mail,
  Sparkles,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import {
  acceptStagedAction,
  approvePendingAction,
  denyPendingAction,
  generateKitAction,
  generateLandingPageAction,
  publishPageAction,
  rejectStagedAction,
  unpublishPageAction,
  type ActionResult,
} from "./actions";

export interface ActionVM {
  id: string;
  actionKind: string;
  summary: string;
  requestedBy: "user" | "agent";
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

function prettyKind(k: string): string {
  return k.replace(/_/g, " ");
}

export function MarketingHub({
  courseId,
  courseTitle,
  campaignName,
  campaignStatus,
  pages,
  staged,
  pending,
  courses,
}: {
  courseId: string;
  courseTitle: string;
  campaignName: string | null;
  campaignStatus: string | null;
  pages: LandingPageVM[];
  staged: ActionVM[];
  pending: ActionVM[];
  courses: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [toast, setToast] = useState<ActionResult | null>(null);
  const run = (fn: () => Promise<ActionResult | void>) =>
    startTransition(async () => {
      const r = await fn();
      if (r) setToast(r);
    });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
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
            <Link
              href={`/marketing/agent?course=${courseId}`}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-300/80 bg-white px-4 text-sm font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50"
            >
              <Wand2 className="size-4" /> Open agent
            </Link>
            <Button onClick={() => run(() => generateKitAction(courseId))} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Generate Kit
            </Button>
          </div>
        }
      />

      {campaignName ? (
        <div className="flex items-center gap-2 text-sm text-stone-500">
          <Globe className="size-4 text-brand-500" />
          Campaign <span className="font-medium text-stone-700">{campaignName}</span>
          {campaignStatus ? <Badge tone="slate">{campaignStatus}</Badge> : null}
        </div>
      ) : null}

      {/* Needs approval (irreversible) */}
      {pending.length > 0 ? (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-700">
            <AlertTriangle className="size-4" /> Needs your approval
          </h2>
          <div className="space-y-2">
            {pending.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
              >
                <Badge tone="rose">{prettyKind(a.actionKind)}</Badge>
                <span>{a.summary}</span>
                {a.requestedBy === "agent" ? <span className="text-xs text-red-400">· agent</span> : null}
                <span className="flex-1" />
                <Button size="sm" onClick={() => run(() => approvePendingAction(a.id))} disabled={busy}>
                  <Check className="size-3.5" /> Approve
                </Button>
                <Button size="sm" variant="ghost" onClick={() => run(() => denyPendingAction(a.id))} disabled={busy}>
                  Deny
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Staged for review (reversible) */}
      {staged.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-amber-700">Staged for review</h2>
          <div className="space-y-2">
            {staged.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              >
                <Badge tone="amber">{prettyKind(a.actionKind)}</Badge>
                <span>{a.summary}</span>
                {a.requestedBy === "agent" ? <span className="text-xs text-amber-500">· agent</span> : null}
                <span className="flex-1" />
                <Button size="sm" variant="outline" onClick={() => run(() => acceptStagedAction(a.id))} disabled={busy}>
                  <Check className="size-3.5" /> Accept
                </Button>
                <Button size="sm" variant="ghost" onClick={() => run(() => rejectStagedAction(a.id))} disabled={busy}>
                  <X className="size-3.5" /> Reject
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Landing pages */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-900">Landing pages</h2>
        {pages.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-10 text-center">
            <p className="text-stone-600">No landing page yet.</p>
            <p className="mt-1 text-sm text-stone-400">
              Generate the kit, or just a page — you’ll review every section before it goes live.
            </p>
            <Button className="mt-4" onClick={() => run(() => generateLandingPageAction(courseId))} disabled={busy}>
              <Sparkles className="size-4" /> Generate landing page
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {pages.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
              >
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
                {p.hasOpenAction ? (
                  <span className="text-xs italic text-stone-400">in review above</span>
                ) : p.status === "published" ? (
                  <Button size="sm" variant="outline" onClick={() => run(() => unpublishPageAction(courseId, p.id))} disabled={busy}>
                    Unpublish…
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => run(() => publishPageAction(courseId, p.id))} disabled={busy}>
                    Publish…
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* More of the engine */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-900">More of the engine</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Link
            href={`/marketing/sequences?course=${courseId}`}
            className="group rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-all hover:border-brand-200 hover:shadow-md"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <Mail className="size-5" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-stone-900">Email &amp; sequences</h3>
            <p className="mt-1 text-sm leading-relaxed text-stone-500">
              What each email says, the schedule, and who&apos;s on which email.
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-600 transition-all group-hover:gap-2">
              Open emails <ExternalLink className="size-3.5" />
            </span>
          </Link>
          <Link
            href={`/marketing/analytics?course=${courseId}`}
            className="group rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-all hover:border-brand-200 hover:shadow-md"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <BarChart3 className="size-5" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-stone-900">Analytics</h3>
            <p className="mt-1 text-sm leading-relaxed text-stone-500">Views, leads, opens, clicks, enrollments — one funnel.</p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-600 transition-all group-hover:gap-2">
              Open dashboard <ExternalLink className="size-3.5" />
            </span>
          </Link>
          <Link
            href={`/marketing/agent?course=${courseId}`}
            className="group rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-all hover:border-brand-200 hover:shadow-md"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <Wand2 className="size-5" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-stone-900">Marketing Agent</h3>
            <p className="mt-1 text-sm leading-relaxed text-stone-500">
              Chat to generate assets, observe the funnel, and propose the next move.
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-600 transition-all group-hover:gap-2">
              Open agent <ExternalLink className="size-3.5" />
            </span>
          </Link>
          <Link
            href={`/marketing/audience?course=${courseId}`}
            className="group rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-all hover:border-brand-200 hover:shadow-md"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <Users className="size-5" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-stone-900">Audience</h3>
            <p className="mt-1 text-sm leading-relaxed text-stone-500">
              Your mailing list + each subscriber’s funnel position. Test the email flow here.
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-600 transition-all group-hover:gap-2">
              Open audience <ExternalLink className="size-3.5" />
            </span>
          </Link>
        </div>
      </section>
    </div>
  );
}
