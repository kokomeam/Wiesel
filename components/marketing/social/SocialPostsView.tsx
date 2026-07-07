"use client";

/**
 * Social Posts — the client view: generation controls (collapse after first
 * use — the queue is the hero), streaming draft intake, filterable queue,
 * the post editor, the voice-profile sheet, and the four designed states
 * (empty / streaming / error-with-retry / conflict toast). All mutations go
 * through the REST surface (→ tools → gate); saves thread expectedVersion and
 * resolve 409s by re-read + one re-apply, never a silent overwrite.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { SocialBatch, VoiceProfileRecord } from "@/lib/marketing/social/repository";
import type { GenerateRequest, SocialPost } from "@/lib/marketing/social/schemas";
import { GeneratorControls, type GeneratorSetup } from "./GeneratorControls";
import { ManualPublishNotice } from "./ManualPublishNotice";
import { PostEditor } from "./PostEditor";
import { PostQueue, type QueueFilters } from "./PostQueue";
import { VoiceProfileSheet } from "./VoiceProfileSheet";
import { SocialApiError, socialApi, streamGenerate } from "./api";

interface CourseRef {
  id: string;
  title: string;
}

export function SocialPostsView(props: {
  course: CourseRef;
  courses: CourseRef[];
  modules: { id: string; title: string }[];
  lessons: { id: string; title: string; moduleId: string }[];
  initialPosts: SocialPost[];
  initialBatches: SocialBatch[];
  initialVoiceProfile: VoiceProfileRecord | null;
}) {
  const [posts, setPosts] = useState<SocialPost[]>(props.initialPosts);
  const [batches, setBatches] = useState<SocialBatch[]>(props.initialBatches);
  const [filters, setFilters] = useState<QueueFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfileRecord | null>(props.initialVoiceProfile);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Generation state — parameters are RETAINED on failure for Retry.
  const [generating, setGenerating] = useState(false);
  const [genPhase, setGenPhase] = useState<string | null>(null);
  const [genExpected, setGenExpected] = useState(0);
  const [genArrived, setGenArrived] = useState(0);
  const [genError, setGenError] = useState<{ message: string; setup: GeneratorSetup; key: string } | null>(null);
  const [lastNotes, setLastNotes] = useState<{ dropped: { reason: string }[]; thin: boolean } | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const upsertPost = useCallback((post: SocialPost) => {
    setPosts((prev) => {
      const idx = prev.findIndex((p) => p.id === post.id);
      if (idx === -1) return [post, ...prev];
      const next = [...prev];
      next[idx] = post;
      return next;
    });
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      const page = await socialApi.list({ withBatches: "true", limit: "100" });
      setPosts(page.posts);
      if (page.batches) setBatches(page.batches);
    } catch {
      // keep current state — a refresh failure is non-fatal
    }
  }, []);

  /* ───────────────────────────── generation ──────────────────────────── */

  const runGenerate = useCallback(
    async (setup: GeneratorSetup, idempotencyKey: string) => {
      setGenerating(true);
      setGenError(null);
      setGenPhase("context");
      setGenExpected(setup.count);
      setGenArrived(0);
      setLastNotes(null);
      try {
        await streamGenerate(
          {
            courseId: props.course.id,
            sourceType: setup.sourceType,
            moduleId: setup.moduleId ?? undefined,
            lessonId: setup.lessonId ?? undefined,
            sourceText: setup.sourceText || undefined,
            platform: setup.platform,
            goal: setup.goal,
            funnelMix: setup.funnelMix,
            tone: setup.tone,
            count: setup.count,
            timingPreset: setup.timingPreset,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          } as Partial<GenerateRequest> & { courseId: string },
          idempotencyKey,
          (event) => {
            if (event.type === "phase") setGenPhase(String((event.data as { phase?: string })?.phase ?? ""));
            if (event.type === "draft") setGenArrived((n) => n + 1);
            if (event.type === "complete") {
              const data = event.data as {
                dropped?: { reason: string }[];
                posts?: unknown[];
              };
              setLastNotes({
                dropped: data.dropped ?? [],
                thin: Boolean((data as { thinContext?: boolean }).thinContext),
              });
            }
            if (event.type === "error") {
              const data = event.data as { error?: string };
              throw new SocialApiError(0, { error: data.error ?? "Generation failed" });
            }
          }
        );
        await refreshQueue();
        showToast("Drafts are in the queue — review, copy, and post them yourself.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Generation failed";
        setGenError({ message, setup, key: idempotencyKey });
      } finally {
        setGenerating(false);
        setGenPhase(null);
      }
    },
    [props.course.id, refreshQueue, showToast]
  );

  const handleGenerate = useCallback(
    (setup: GeneratorSetup) => {
      void runGenerate(setup, crypto.randomUUID());
    },
    [runGenerate]
  );

  /* ─────────────────── versioned saves + 409 protocol ────────────────── */

  /**
   * Save with the re-read + one-re-apply conflict protocol: on 409 fetch the
   * fresh post, re-apply the same patch on its version once; if that also
   * conflicts, adopt the fresh copy and surface the toast.
   */
  const savePatch = useCallback(
    async (post: SocialPost, patch: Record<string, unknown>): Promise<void> => {
      try {
        await socialApi.patch(post.id, { expectedVersion: post.version, ...patch });
      } catch (err) {
        if (err instanceof SocialApiError && err.status === 409) {
          const { post: fresh } = await socialApi.getPost(post.id);
          try {
            await socialApi.patch(post.id, { expectedVersion: fresh.version, ...patch });
            showToast("Updated elsewhere — refreshed and re-applied your change.");
          } catch {
            upsertPost(fresh);
            showToast("Updated elsewhere — refreshed to latest.");
            return;
          }
        } else {
          throw err;
        }
      }
      const { post: latest } = await socialApi.getPost(post.id);
      upsertPost(latest);
    },
    [showToast, upsertPost]
  );

  const selected = useMemo(
    () => (selectedId ? (posts.find((p) => p.id === selectedId) ?? null) : null),
    [posts, selectedId]
  );

  const visiblePosts = useMemo(
    () =>
      posts.filter((p) => {
        if (p.deletedAt) return false;
        if (filters.status && p.status !== filters.status) return false;
        if (filters.platform && p.platform !== filters.platform) return false;
        if (filters.funnelStage && p.funnelStage !== filters.funnelStage) return false;
        return true;
      }),
    [posts, filters]
  );

  const hasAnyPosts = posts.some((p) => !p.deletedAt);

  return (
    <div className="space-y-5">
      <GeneratorControls
        course={props.course}
        courses={props.courses}
        modules={props.modules}
        lessons={props.lessons}
        busy={generating}
        startCollapsed={hasAnyPosts}
        onGenerate={handleGenerate}
        onOpenVoice={() => setVoiceOpen(true)}
      />

      {genError && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
            <AlertTriangle className="size-4" /> Generation didn&apos;t complete
          </div>
          <p className="mt-1 text-xs text-rose-700">{genError.message} Your setup is kept — try again.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-rose-800">
            <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-rose-200">
              {genError.setup.platform} · {genError.setup.count} post(s)
            </span>
            <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-rose-200">
              {genError.setup.funnelMix === "balanced" ? "Balanced mix" : `Goal: ${genError.setup.goal}`}
            </span>
            <span className="flex-1" />
            <Button size="sm" onClick={() => void runGenerate(genError.setup, genError.key)}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        </div>
      )}

      {lastNotes && lastNotes.dropped.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {lastNotes.dropped.length} draft(s) removed by the safety check: {lastNotes.dropped.map((d) => d.reason).join("; ")}.
          </span>
        </div>
      )}
      {lastNotes?.thin && (
        <div className="rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-xs text-stone-600">
          This course has little content yet — posts will be more generic. Add a course description for better results.
        </div>
      )}

      {generating && (
        <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-brand-700">
            <Sparkles className="size-3.5 animate-pulse" />
            {genArrived > 0
              ? `${genArrived} of ${genExpected} drafts ready…`
              : genPhase === "model"
                ? "Writing drafts — quality first, this can take a couple of minutes…"
                : genPhase === "voice"
                  ? "Loading your voice profile…"
                  : "Reading your course content…"}
          </div>
          <div className="space-y-2.5">
            {Array.from({ length: Math.max(1, genExpected - genArrived) }).map((_, i) => (
              <div key={i} className="animate-pulse space-y-2 rounded-xl border border-dashed border-stone-200 p-3.5">
                <div className="h-2.5 w-1/3 rounded bg-stone-100" />
                <div className="h-2.5 w-11/12 rounded bg-stone-100" />
                <div className="h-2.5 w-3/4 rounded bg-stone-100" />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={selected ? "grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" : ""}>
        <PostQueue
          posts={visiblePosts}
          batches={batches}
          filters={filters}
          onFilters={setFilters}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
          onMarkReady={async (ids) => {
            for (const id of ids) await socialApi.status(id, "ready").catch(() => null);
            await refreshQueue();
            showToast("Marked ready.");
          }}
          empty={!hasAnyPosts && !generating}
        />
        {selected && (
          <PostEditor
            key={selected.id}
            post={selected}
            courseId={props.course.id}
            onClose={() => setSelectedId(null)}
            onSaved={upsertPost}
            savePatch={savePatch}
            onQueueChanged={refreshQueue}
            showToast={showToast}
          />
        )}
      </div>

      {!selected && hasAnyPosts && <ManualPublishNotice />}

      <VoiceProfileSheet
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        profile={voiceProfile}
        onProfile={setVoiceProfile}
        showToast={showToast}
      />

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-xl bg-stone-900 px-4 py-2.5 text-xs font-medium text-stone-50 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
