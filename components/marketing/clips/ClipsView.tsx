"use client";

/**
 * Lesson Clips — the M-E client view (PRD §15 + amendment FR-9):
 *   1. lesson picker (only lessons with a ≥20s ready video)
 *   2. "Find moments" → ranked candidate cards with LAYOUT CHIPS
 *      (CLIP_LAYOUT_LABELS — imported, never copied) + the audiogram caveat
 *      (CLIP_AUDIOGRAM_CAVEAT) + hook/span/rationale + render/dismiss
 *   3. render-job progress cards (queued/precutting/… + cancel + a dev
 *      "Process renders now" button driving the same scheduler tick cron runs)
 *   4. finished-clip cards: signed-URL player + the posting kit panel
 *      (generate/copy buttons + the /preview share link)
 *   5. the usage meter (jobs today / minutes this month vs quotas)
 * Every mutation rides the REST surface → executeMarketingTool → the gate.
 * ManualPublishNotice is THE language component (reused, not re-worded).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Clapperboard,
  Copy,
  Film,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  CLIP_AUDIOGRAM_CAVEAT,
  CLIP_LAYOUT_LABELS,
} from "@/lib/marketing/clips/constants";
import type { ClipLayout, ClipMomentCandidate } from "@/lib/marketing/clips/schemas";
import type { ClipRenderJob } from "@/lib/marketing/clips/render/jobs";
import { ManualPublishNotice } from "@/components/marketing/social/ManualPublishNotice";

/* ─────────────────────────────── types ────────────────────────────────── */

interface LessonOption {
  id: string;
  title: string;
  videoSeconds: number;
}

interface ClipPostRef {
  id: string;
  clipJobId: string | null;
  platform: string;
  body: string;
}

interface KitView {
  postId: string;
  caption: string;
  hashtags: string[];
  commentKeyword: string | null;
  disclosureLine: string;
  shortCode: string | null;
}

interface Usage {
  jobsToday: number;
  jobsPerDay: number;
  minutesThisMonth: number;
  minutesPerMonth: number;
}

/* ───────────────────────────── helpers ────────────────────────────────── */

function fmtSpan(startMs: number, endMs: number): string {
  const f = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return `${f(startMs)}–${f(endMs)} · ${Math.round((endMs - startMs) / 1000)}s`;
}

/** FR-9: the layout chip — labeled human copy, audiogram visibly caveated. */
function LayoutChip({ layout }: { layout: ClipLayout }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ring-1 ring-inset",
        layout === "audiogram"
          ? "bg-stone-100 text-stone-500 ring-stone-200"
          : "bg-brand-50 text-brand-700 ring-brand-100"
      )}
    >
      <Film className="size-3" />
      {CLIP_LAYOUT_LABELS[layout]}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

const ACTIVE_JOB_STATUSES = new Set(["queued", "precutting", "submitted", "rendering_local"]);

/* ─────────────────────────────── view ─────────────────────────────────── */

export function ClipsView({
  course,
  courses,
  lessons,
  initialCandidates,
  initialJobs,
  clipPosts,
  kits,
  usage,
}: {
  course: { id: string; title: string };
  courses: { id: string; title: string }[];
  lessons: LessonOption[];
  initialCandidates: ClipMomentCandidate[];
  initialJobs: ClipRenderJob[];
  clipPosts: ClipPostRef[];
  kits: KitView[];
  usage: Usage;
}) {
  const router = useRouter();
  const [lessonId, setLessonId] = useState(lessons[0]?.id ?? "");
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ticking, setTicking] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [kitByPost, setKitByPost] = useState<Record<string, KitView & { fullText?: string }>>(
    () => Object.fromEntries(kits.map((k) => [k.postId, k]))
  );

  const candidates = useMemo(
    () => initialCandidates.filter((c) => !lessonId || c.lessonId === lessonId),
    [initialCandidates, lessonId]
  );
  const jobByCandidate = useMemo(() => {
    const m = new Map<string, ClipRenderJob>();
    for (const j of initialJobs) if (!m.has(j.candidateId)) m.set(j.candidateId, j);
    return m;
  }, [initialJobs]);
  const postByJob = useMemo(
    () => new Map(clipPosts.filter((p) => p.clipJobId).map((p) => [p.clipJobId!, p])),
    [clipPosts]
  );
  const activeJobs = initialJobs.filter((j) => ACTIVE_JOB_STATUSES.has(j.status));
  const doneJobs = initialJobs.filter((j) => j.status === "completed");

  // While jobs are in flight, THIS PAGE is the delivery loop: Reap has no
  // webhooks and dev has no cron, so nothing advances a job unless someone
  // runs the reconciliation sweep. Poll the creator-scoped tick (one edge
  // per active job per pass, idempotent — the same sweep the prod cron
  // runs), then refresh the server data. Without this a job sits at
  // "Cutting the exact span…" forever once its Mux precut is ready.
  const hasActiveJobs = activeJobs.length > 0;
  const tickBusyRef = useRef(false);
  const runTick = useCallback(async () => {
    if (tickBusyRef.current) return;
    tickBusyRef.current = true;
    try {
      await fetch("/api/marketing/clips/tick", { method: "POST" });
      router.refresh();
    } catch {
      // transient — the next poll retries
    } finally {
      tickBusyRef.current = false;
    }
  }, [router]);
  useEffect(() => {
    if (!hasActiveJobs) return;
    void runTick();
    const id = setInterval(() => void runTick(), 5_000);
    return () => clearInterval(id);
  }, [hasActiveJobs, runTick]);

  const findMoments = useCallback(async () => {
    if (!lessonId) return;
    setFinding(true);
    setError(null);
    try {
      const res = await fetch(`/api/marketing/lessons/${lessonId}/clip-moments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: course.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Moment selection failed — your setup is kept, try again.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Moment selection failed — try again.");
    } finally {
      setFinding(false);
    }
  }, [lessonId, course.id, router]);

  const queueRender = useCallback(
    async (candidateId: string) => {
      setBusyId(candidateId);
      setError(null);
      try {
        const res = await fetch("/api/marketing/clips/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId, courseId: course.id }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Could not queue the render.");
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not queue the render.");
      } finally {
        setBusyId(null);
      }
    },
    [course.id, router]
  );

  const dismiss = useCallback(
    async (candidateId: string) => {
      setBusyId(candidateId);
      try {
        await fetch(`/api/marketing/lessons/${lessonId}/clip-moments`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId, status: "dismissed", courseId: course.id }),
        });
        router.refresh();
      } finally {
        setBusyId(null);
      }
    },
    [lessonId, course.id, router]
  );

  const cancelJob = useCallback(
    async (jobId: string) => {
      setBusyId(jobId);
      try {
        await fetch(`/api/marketing/clips/jobs/${jobId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel", courseId: course.id }),
        });
        router.refresh();
      } finally {
        setBusyId(null);
      }
    },
    [course.id, router]
  );

  const processNow = useCallback(async () => {
    setTicking(true);
    try {
      await runTick();
    } finally {
      setTicking(false);
    }
  }, [runTick]);

  const loadMedia = useCallback(
    async (jobId: string) => {
      const res = await fetch(`/api/marketing/clips/jobs/${jobId}?courseId=${course.id}`);
      if (!res.ok) return;
      const body = (await res.json()) as { url?: string };
      if (body.url) setMediaUrls((m) => ({ ...m, [jobId]: body.url! }));
    },
    [course.id]
  );

  const buildKit = useCallback(
    async (postId: string) => {
      setBusyId(postId);
      setError(null);
      try {
        const res = await fetch(`/api/marketing/clips/posts/${postId}/kit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ courseId: course.id }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Could not build the posting kit.");
        }
        const body = (await res.json()) as {
          data?: KitView & { fullText: string; shortCode: string | null };
        };
        if (body.data) setKitByPost((m) => ({ ...m, [postId]: { ...body.data!, postId } }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not build the posting kit.");
      } finally {
        setBusyId(null);
      }
    },
    [course.id]
  );

  // Hydration-safe origin: this text RENDERS (and the page SSRs client
  // components), so bare `window` threw "window is not defined" the moment
  // a persisted kit loaded with the page. Server snapshot renders the
  // relative /l/ link; the client pass fills the absolute origin in.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => ""
  );
  const kitFullText = (kit: KitView & { fullText?: string }): string =>
    kit.fullText ??
    [
      kit.caption,
      kit.commentKeyword ? `Comment "${kit.commentKeyword}" and I'll DM you the link.` : null,
      kit.shortCode ? `${origin}/l/${kit.shortCode}` : null,
      kit.disclosureLine,
      kit.hashtags.length ? kit.hashtags.map((h) => `#${h}`).join(" ") : null,
    ]
      .filter(Boolean)
      .join("\n\n");

  /* ────────────────────────────── render ──────────────────────────────── */

  return (
    <div className="space-y-8">
      <ManualPublishNotice />

      {/* usage meter + course switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-xs text-stone-500">
          <span>
            Renders today{" "}
            <strong className="text-stone-800">
              {usage.jobsToday}/{usage.jobsPerDay}
            </strong>
          </span>
          <span>
            Minutes this month{" "}
            <strong className="text-stone-800">
              {usage.minutesThisMonth}/{usage.minutesPerMonth}
            </strong>
          </span>
        </div>
        {courses.length > 1 && (
          <select
            value={course.id}
            onChange={(e) => router.push(`/marketing/clips?course=${e.target.value}`)}
            className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700"
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* setup card: lesson picker + find moments */}
      <section className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-stone-400">
          1 · Pick a lesson
        </p>
        {lessons.length === 0 ? (
          <p className="text-sm text-stone-500">
            No lesson in this course has a ready video of 20 seconds or longer yet. Record one in
            the studio (captions generate automatically) and come back.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={lessonId}
              onChange={(e) => setLessonId(e.target.value)}
              className="min-w-56 rounded-full border border-stone-200 bg-white px-4 py-2 text-sm text-stone-800"
            >
              {lessons.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title} · {Math.floor(l.videoSeconds / 60)}:
                  {String(l.videoSeconds % 60).padStart(2, "0")}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={finding || !lessonId}
              onClick={() => void findMoments()}
              className="brand-gradient inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm transition-opacity disabled:opacity-60"
            >
              {finding ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {finding ? "Finding the best moments…" : "Find clip moments"}
            </button>
          </div>
        )}
        {error && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 ring-1 ring-inset ring-rose-100">
            {error}
          </p>
        )}
      </section>

      {/* moment picker */}
      <section>
        <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-stone-400">
          2 · Pick the moments worth rendering
        </p>
        {candidates.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-stone-200 px-5 py-8 text-center text-sm text-stone-400">
            No candidates yet — pick a lesson above and find its clip moments.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {candidates.map((c) => {
              const job = jobByCandidate.get(c.id);
              return (
                <article
                  key={c.id}
                  className="flex flex-col gap-2 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <LayoutChip layout={c.layout} />
                      <span className="font-mono text-[10px] uppercase tracking-wide text-stone-400">
                        {c.momentType.replace(/_/g, " ")} · {c.funnelStage}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-stone-400">
                      {fmtSpan(c.startMs, c.endMs)}
                    </span>
                  </div>
                  <h3 className="text-base font-medium text-stone-900">“{c.hookText}”</h3>
                  <p className="text-xs leading-relaxed text-stone-500">{c.rationale}</p>
                  {c.layout === "audiogram" && (
                    <p className="text-[11px] italic text-stone-400">{CLIP_AUDIOGRAM_CAVEAT}</p>
                  )}
                  {job?.status === "failed" && (
                    <p className="text-xs text-rose-600">
                      Render failed{job.error ? ` — ${job.error}` : ""}
                    </p>
                  )}
                  <div className="mt-1 flex items-center gap-2">
                    {job && job.status !== "failed" && job.status !== "cancelled" ? (
                      <span className="text-xs text-stone-500">
                        {job.status === "completed"
                          ? "Rendered — see below"
                          : "Rendering in the background…"}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === c.id}
                        onClick={() => void queueRender(c.id)}
                        className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-60"
                      >
                        {busyId === c.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Clapperboard className="size-3.5" />
                        )}
                        {job ? "Render again" : "Render this clip"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyId === c.id}
                      onClick={() => void dismiss(c.id)}
                      className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-stone-400 transition-colors hover:bg-stone-50 hover:text-stone-600"
                    >
                      <X className="size-3.5" /> Dismiss
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* in-flight jobs */}
      {activeJobs.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <p className="font-mono text-[11px] uppercase tracking-wide text-stone-400">
              Rendering ({activeJobs.length})
            </p>
            <button
              type="button"
              disabled={ticking}
              onClick={() => void processNow()}
              className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
            >
              {ticking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Process renders now
            </button>
          </div>
          <div className="space-y-2">
            {activeJobs.map((j) => (
              <div
                key={j.id}
                className="flex items-center justify-between rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-brand-500" />
                  </span>
                  <LayoutChip layout={j.layout} />
                  <span className="text-xs text-stone-500">
                    {j.status === "queued"
                      ? "Queued — starting shortly"
                      : j.status === "precutting"
                        ? "Cutting the exact span…"
                        : j.status === "submitted"
                          ? "Rendering at the provider…"
                          : "Rendering…"}
                  </span>
                  {j.error && (
                    <span className="text-xs text-amber-600">
                      Retrying — last attempt: {j.error}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={busyId === j.id}
                  onClick={() => void cancelJob(j.id)}
                  className="text-xs text-stone-400 hover:text-rose-600"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* finished clips + kit panel */}
      {doneJobs.length > 0 && (
        <section>
          <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-stone-400">
            3 · Copy the kit and post it yourself
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {doneJobs.map((j) => {
              const post = postByJob.get(j.id);
              const kit = post ? kitByPost[post.id] : undefined;
              return (
                <article
                  key={j.id}
                  className="flex flex-col gap-3 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
                >
                  <div className="flex items-center justify-between">
                    <LayoutChip layout={j.layout} />
                    <span className="font-mono text-[11px] text-stone-400">
                      {Math.round(j.output?.durationSeconds ?? 0)}s · {j.costMinutes ?? "–"} min billed
                    </span>
                  </div>
                  {mediaUrls[j.id] ? (
                    <video
                      src={mediaUrls[j.id]}
                      controls
                      playsInline
                      className="aspect-[9/16] w-full max-w-60 self-center rounded-xl bg-stone-950"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => void loadMedia(j.id)}
                      className="grid aspect-[9/16] w-full max-w-60 place-items-center self-center rounded-xl bg-stone-100 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-200"
                    >
                      ▶ Load preview
                    </button>
                  )}
                  {post ? (
                    kit ? (
                      <div className="space-y-2 rounded-xl bg-stone-50 p-3 text-xs text-stone-600">
                        <p className="whitespace-pre-wrap">{kitFullText(kit)}</p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <CopyButton text={kitFullText(kit)} label="Copy full kit" />
                          <CopyButton text={kit.caption} label="Copy caption" />
                          {kit.shortCode && (
                            <a
                              href={`/preview/${kit.shortCode}`}
                              target="_blank"
                              className="inline-flex items-center rounded-full border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
                            >
                              Share preview ↗
                            </a>
                          )}
                          <button
                            type="button"
                            disabled={busyId === post.id}
                            onClick={() => void buildKit(post.id)}
                            className="text-xs text-stone-400 hover:text-stone-600"
                          >
                            Rebuild kit
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === post.id}
                        onClick={() => void buildKit(post.id)}
                        className="inline-flex items-center justify-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-xs font-medium text-white transition-opacity disabled:opacity-60"
                      >
                        {busyId === post.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="size-3.5" />
                        )}
                        Build the posting kit
                      </button>
                    )
                  ) : (
                    <p className="text-xs text-stone-400">Preparing the post entry…</p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
