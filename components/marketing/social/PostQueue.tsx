"use client";

/**
 * The content queue (PRD §11): cards grouped by batch, filter chips (status /
 * platform / stage), bulk "mark ready", and the seeded empty state. Stage
 * chips are color-coded and text-labeled; a posted post's card swaps its
 * action to Log performance (opens the editor).
 *
 * PERF-1 D2 (diagnosis A5 §6: "PostQueue ≤100, unmemoized cards, whole-array
 * replacement per save") — deliberate NON-windowing decision: cards are
 * variable-height (line-clamp-2 body = 1–2 lines, chip/meta rows wrap at
 * narrow widths) and interleaved with per-batch headers, so fixed-size
 * windows (lib/perf/virtualRows' contract) would mis-measure the scroll
 * space. The honest fix here is (a) PostCard memoized on post identity —
 * `upsertPost` preserves the identity of untouched posts, so a save
 * re-renders ONE card instead of all ≤100 — and (b) `.cv-row` rendering
 * containment so off-screen cards skip layout/paint entirely.
 */

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  PLATFORM_LIMITS,
  POST_STATUSES,
  type SocialPlatform,
  type SocialPostStatus,
} from "@/lib/marketing/social/constants";
import type { SocialBatch } from "@/lib/marketing/social/repository";
import type { SocialPostListItem } from "@/lib/marketing/social/schemas";
import { StageChip } from "./StageChip";

export interface QueueFilters {
  status?: SocialPostStatus;
  platform?: SocialPlatform;
  funnelStage?: string;
}

const STATUS_CLS: Record<SocialPostStatus, string> = {
  draft: "bg-amber-50 text-amber-700 ring-amber-200",
  ready: "bg-sky-50 text-sky-700 ring-sky-200",
  planned: "bg-violet-50 text-violet-700 ring-violet-200",
  posted_manual: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  archived: "bg-stone-100 text-stone-500 ring-stone-200",
};

export const STATUS_LABELS: Record<SocialPostStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  planned: "Planned",
  posted_manual: "Posted manually",
  archived: "Archived",
};

export function StatusPill({ status }: { status: SocialPostStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1 ring-inset",
        STATUS_CLS[status]
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function fmtPlanned(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function FilterChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
        props.active
          ? "border-brand-300 bg-brand-50 text-brand-800"
          : "border-stone-200 bg-white text-stone-500 hover:border-stone-300"
      )}
    >
      {props.label}
    </button>
  );
}

/** Memoized on post identity (+ selection): the default shallow compare holds
 *  because `selectPost` below is render-stable and `upsertPost` keeps
 *  untouched posts' identities — one saved post re-renders one card. */
const PostCard = memo(function PostCard(props: {
  post: SocialPostListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { post } = props;
  const planned = fmtPlanned(post.plannedPostAt);
  return (
    <button
      type="button"
      onClick={() => props.onSelect(post.id)}
      // .cv-row: off-screen cards skip layout/paint; 104px ≈ a two-line card
      // (contain-intrinsic-size `auto` remembers the real height after paint).
      style={{ "--cv-size": "104px" } as React.CSSProperties}
      className={cn(
        "cv-row w-full rounded-xl border bg-white p-3.5 text-left transition-colors",
        props.selected ? "border-brand-400 ring-2 ring-brand-200" : "border-stone-200 hover:border-stone-300"
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone-600">
          {PLATFORM_LIMITS[post.platform].label}
        </span>
        <StageChip stage={post.funnelStage} />
        <StatusPill status={post.status} />
        {post.imageStoragePath && <ImageIcon className="size-3.5 text-stone-400" />}
        <span className="flex-1" />
        {planned && <span className="font-mono text-[10px] text-stone-400">planned · {planned}</span>}
      </div>
      <p className="line-clamp-2 text-xs leading-relaxed text-stone-600">{post.body}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-stone-400">
        <span>CTA · {post.cta ? post.cta.slice(0, 40) : "none"}</span>
        {post.hashtags.length > 0 && <span>{post.hashtags.slice(0, 3).join(" ")}{post.hashtags.length > 3 ? ` +${post.hashtags.length - 3}` : ""}</span>}
      </div>
    </button>
  );
});

export function PostQueue(props: {
  posts: SocialPostListItem[];
  batches: SocialBatch[];
  filters: QueueFilters;
  onFilters: (f: QueueFilters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMarkReady: (ids: string[]) => void;
  empty: boolean;
}) {
  const { filters } = props;

  // props.onSelect is recreated per parent render (it closes over the current
  // selection) — latch it in a ref so the per-card callback stays identity-
  // stable and memo(PostCard) holds. The ref write lives in an effect (React
  // 19 lint: never write refs during render).
  const onSelectRef = useRef(props.onSelect);
  useEffect(() => {
    onSelectRef.current = props.onSelect;
  });
  const selectPost = useCallback((id: string) => onSelectRef.current(id), []);

  const groups = useMemo(() => {
    const byBatch = new Map<string, SocialPostListItem[]>();
    const loose: SocialPostListItem[] = [];
    for (const p of props.posts) {
      if (p.batchId) {
        const list = byBatch.get(p.batchId) ?? [];
        list.push(p);
        byBatch.set(p.batchId, list);
      } else {
        loose.push(p);
      }
    }
    const orderedBatches = props.batches
      .filter((b) => byBatch.has(b.id))
      .map((b) => ({ batch: b, posts: byBatch.get(b.id)!.sort((a, x) => (a.batchOrder ?? 9) - (x.batchOrder ?? 9)) }));
    // Batches unknown to the loaded list (older pagination) still render.
    for (const [id, list] of byBatch) {
      if (!orderedBatches.some((g) => g.batch.id === id)) {
        orderedBatches.push({ batch: null as unknown as SocialBatch, posts: list });
      }
    }
    return { orderedBatches, loose };
  }, [props.posts, props.batches]);

  if (props.empty) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 bg-[#fdfbf7] p-10 text-center">
        <div className="font-serif text-lg text-stone-800">No posts yet</div>
        <p className="mx-auto mt-1 max-w-md text-xs text-stone-500">
          Generate platform-ready drafts from your real course content — then copy and post them
          yourself, wherever you already show up.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2 text-[11px] text-stone-500">
          <span className="rounded-full border border-stone-200 bg-white px-3 py-1">Announce your course</span>
          <span className="rounded-full border border-stone-200 bg-white px-3 py-1">3 value posts from a module</span>
          <span className="rounded-full border border-stone-200 bg-white px-3 py-1">A pain-point post for beginners</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={!filters.status} label="All statuses" onClick={() => props.onFilters({ ...filters, status: undefined })} />
        {POST_STATUSES.filter((s) => s !== "archived").map((s) => (
          <FilterChip
            key={s}
            active={filters.status === s}
            label={STATUS_LABELS[s]}
            onClick={() => props.onFilters({ ...filters, status: filters.status === s ? undefined : s })}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-stone-200" />
        <FilterChip active={!filters.platform} label="All platforms" onClick={() => props.onFilters({ ...filters, platform: undefined })} />
        {(["linkedin", "facebook"] as const).map((p) => (
          <FilterChip
            key={p}
            active={filters.platform === p}
            label={PLATFORM_LIMITS[p].label}
            onClick={() => props.onFilters({ ...filters, platform: filters.platform === p ? undefined : p })}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-stone-200" />
        {(["tofu", "mofu", "bofu"] as const).map((s) => (
          <FilterChip
            key={s}
            active={filters.funnelStage === s}
            label={s}
            onClick={() => props.onFilters({ ...filters, funnelStage: filters.funnelStage === s ? undefined : s })}
          />
        ))}
      </div>

      {groups.orderedBatches.map(({ batch, posts }) => (
        <div key={batch?.id ?? posts[0].id}>
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-stone-400">
              {batch
                ? `Batch · ${new Date(batch.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${posts.length} post(s) · ${batch.funnelMix === "balanced" ? "balanced mix" : "pinned"}`
                : `Batch · ${posts.length} post(s)`}
            </span>
            <span className="flex-1" />
            {posts.some((p) => p.status === "draft") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => props.onMarkReady(posts.filter((p) => p.status === "draft").map((p) => p.id))}
              >
                Mark all ready
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {posts.map((p) => (
              <PostCard key={p.id} post={p} selected={p.id === props.selectedId} onSelect={selectPost} />
            ))}
          </div>
        </div>
      ))}

      {groups.loose.length > 0 && (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-stone-400">Individual posts</div>
          <div className="space-y-2">
            {groups.loose.map((p) => (
              <PostCard key={p.id} post={p} selected={p.id === props.selectedId} onSelect={selectPost} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
