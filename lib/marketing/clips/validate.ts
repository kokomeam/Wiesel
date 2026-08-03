/**
 * Validation pass (PRD 1.5 §7.4) — deterministic checks FIRST (free), the ONE
 * small-tier model call's verdicts applied after. PURE — the selection engine
 * orchestrates IO.
 *
 * Repairable vs. droppable is explicit per rule:
 *   - repairable (span out of bounds, overlapping candidates, unsupported hook
 *     numbers, safety-lint hits) → ONE repair call (Phase 1 semantics), then
 *     survivors re-checked and still-flagged candidates DROP with a reason.
 *   - droppable-only (rubric below the §8.3 bar) → dropped immediately; we
 *     never ask the model to inflate its own scores.
 *   - coherence failures (model verdict) → the proposed ±8s adjustment is
 *     applied when it stays in bounds, else DROP — never repaired into
 *     incoherence (§7.3/§7.4.2).
 *   - unsupported hooks (model verdict) → first supported hook is promoted,
 *     none supported → DROP (§7.4.3, the anti-clickbait gate).
 */

import {
  CLIP_COHERENCE_ADJUST_MS,
  CLIP_DEMO_PAYOFF_ACTION_BOOST,
  CLIP_OVERLAP_MAX_RATIO,
  CLIP_PLATFORM_SPECS,
  CLIP_RUBRIC_THRESHOLDS,
  CLIP_SPAN_MAX_MS,
  CLIP_SPAN_MIN_MS,
  type ClipPlatform,
} from "./constants";
import { scoreActionDensity } from "./actionDensity";
import { lintClipTextSurfaces, lintHookNumbers, lintHookSlideRef } from "./lint";
import { hasSlideWithinSpan, resolveClipLayout, slideSyncCoversSpan } from "./routing";
import { meetsRubricThreshold, rubricTotal, type CandidateVerdict, type ModelMoment } from "./schemas";
import { snapToSentenceBounds, transcriptSlice } from "./transcripts";
import type { ClipLayout, RecordingFormat, SlideSyncEntry, TranscriptWord } from "./schemas";

export interface ClipDrop {
  rank: number;
  rule: string;
  /** Creator-facing reason, surfaced in the UI + tool summary. */
  reason: string;
  excerpt?: string;
}

export interface RepairIssue {
  rank: number;
  issue: string;
}

/** A candidate that survived normalization, with its derived span text. */
export interface NormalizedCandidate extends ModelMoment {
  /** Envelope-normalized: startMs = first segment start, endMs = last end. */
  spanTranscript: string;
  /** True when the caption was clamped to the tightest target-platform cap. */
  captionClamped: boolean;
  /** FR-2: the resolved layout for this candidate's FINAL span. */
  layout: ClipLayout;
  /** FR-3's verdict for the final span (rides ai_metadata). */
  actionDense: boolean;
  /** FR-4: whether the demo_payoff action boost lifted visual_interest. */
  visualInterestBoosted: boolean;
}

/** The format facts every check/routing decision reads (amendment §1). */
export interface FormatCheckContext {
  recordingFormat: RecordingFormat;
  /** Slide-sync entries, or null — no platform producer exists yet (FR-7(g)). */
  slideSync: SlideSyncEntry[] | null;
  /** Coarse frame-diff signal when media is locally accessible; null = the
   *  documented degraded mode (transcript cues alone decide density). */
  frameDiffRatio: number | null;
}

/** FR-2/FR-3 for one span: density verdict + routed layout. */
function routingFor(
  span: { startMs: number; endMs: number },
  words: TranscriptWord[],
  format: FormatCheckContext
): { layout: ClipLayout; actionDense: boolean } {
  const action = scoreActionDensity(words, span, { frameDiffRatio: format.frameDiffRatio });
  return {
    layout: resolveClipLayout(format.recordingFormat, {
      slideSyncCoversSpan: slideSyncCoversSpan(format.slideSync, span),
      actionDense: action.dense,
    }),
    actionDense: action.dense,
  };
}

/** Effective playing ranges: contiguous span → one range. */
function ranges(m: ModelMoment): { startMs: number; endMs: number }[] {
  return m.segments ?? [{ startMs: m.startMs, endMs: m.endMs }];
}

function effectiveDurationMs(m: ModelMoment): number {
  return ranges(m).reduce((s, r) => s + (r.endMs - r.startMs), 0);
}

function intersectionMs(a: ModelMoment, b: ModelMoment): number {
  let total = 0;
  for (const ra of ranges(a)) {
    for (const rb of ranges(b)) {
      total += Math.max(0, Math.min(ra.endMs, rb.endMs) - Math.max(ra.startMs, rb.startMs));
    }
  }
  return total;
}

/** Pairwise overlap ratio over the SHORTER candidate (§7.2: distinct spans). */
export function overlapRatio(a: ModelMoment, b: ModelMoment): number {
  const shorter = Math.min(effectiveDurationMs(a), effectiveDurationMs(b));
  if (shorter <= 0) return 1;
  return intersectionMs(a, b) / shorter;
}

export interface DeterministicResult {
  kept: NormalizedCandidate[];
  dropped: ClipDrop[];
  /** Issues worth ONE repair call (empty ⇒ no repair needed). */
  repairIssues: RepairIssue[];
}

/**
 * §7.4.1 bounds/shape checks + §7.4.4 safety lint + deterministic hook
 * numbers + the FR-4 slide-ref hook lint, plus overlap pruning, the FR-4
 * demo_payoff action boost, and the §8.3 rubric bar. `sourceContext`
 * whitelists the creator's own claims (the Phase 1 lint escape). `format`
 * carries the recording-format facts (FR-1) that routing (FR-2), density
 * (FR-3), and the boost read.
 */
export function runDeterministicChecks(
  candidates: ModelMoment[],
  ctx: {
    durationMs: number;
    words: TranscriptWord[];
    sourceContext: string;
    format: FormatCheckContext;
  }
): DeterministicResult {
  const kept: NormalizedCandidate[] = [];
  const dropped: ClipDrop[] = [];
  const repairIssues: RepairIssue[] = [];

  const ordered = [...candidates].sort((a, b) => a.rank - b.rank);

  for (const raw of ordered) {
    // Snap every range to sentence edges FIRST (model boundaries are
    // interpolated guesses; a 1.5s-early start drags in the previous
    // sentence's tail and poisons the coherence check — the live-eval fix).
    const snappedRanges = ranges(raw).map((r) => snapToSentenceBounds(ctx.words, r.startMs, r.endMs));
    const snapped: ModelMoment =
      raw.segments === null
        ? { ...raw, startMs: snappedRanges[0].startMs, endMs: snappedRanges[0].endMs }
        : { ...raw, segments: snappedRanges };
    // Envelope-normalize a multi-segment candidate's top-level span.
    const rs = ranges(snapped);
    const m: ModelMoment = { ...snapped, startMs: rs[0].startMs, endMs: rs[rs.length - 1].endMs };
    const duration = effectiveDurationMs(m);

    // Bounds vs. media duration (500ms slack for cue rounding) — repairable.
    const outOfMedia = rs.some((r) => r.startMs < 0 || r.endMs > ctx.durationMs + 500);
    if (outOfMedia) {
      repairIssues.push({
        rank: m.rank,
        issue: `candidate ${m.rank}: span exceeds the media duration (${ctx.durationMs}ms) — cite spans from the transcript anchors only`,
      });
      dropped.push({
        rank: m.rank,
        rule: "span_out_of_bounds",
        reason: "its span lies outside the recording",
      });
      continue;
    }

    // 20-90s effective duration — repairable.
    if (duration < CLIP_SPAN_MIN_MS || duration > CLIP_SPAN_MAX_MS) {
      repairIssues.push({
        rank: m.rank,
        issue: `candidate ${m.rank}: effective duration ${Math.round(duration / 1000)}s is outside ${CLIP_SPAN_MIN_MS / 1000}-${CLIP_SPAN_MAX_MS / 1000}s`,
      });
      dropped.push({
        rank: m.rank,
        rule: "span_duration",
        reason: `it runs ${Math.round(duration / 1000)}s (clips must be ${CLIP_SPAN_MIN_MS / 1000}-${CLIP_SPAN_MAX_MS / 1000}s)`,
      });
      continue;
    }

    // Platform fit: prune platforms whose hard cap the span exceeds
    // (clamp-not-reject); no platforms left → droppable + repairable.
    const fit = m.targetPlatformFit.filter((p) => duration <= CLIP_PLATFORM_SPECS[p].hardCapMs);
    if (fit.length === 0) {
      repairIssues.push({
        rank: m.rank,
        issue: `candidate ${m.rank}: ${Math.round(duration / 1000)}s exceeds every claimed platform's hard cap`,
      });
      dropped.push({
        rank: m.rank,
        rule: "platform_cap",
        reason: "it exceeds the duration cap of every platform it targets",
      });
      continue;
    }

    // FR-4: demo_payoff earns a deterministic visual_interest boost when the
    // recording is screen-only and the span is action-dense — the demo IS the
    // visual payoff. Applied BEFORE the rubric bar; capped at 5; recorded on
    // the candidate so ai_metadata stays honest about the lift.
    const envelopeSpan = { startMs: m.startMs, endMs: m.endMs };
    const routing = routingFor(envelopeSpan, ctx.words, ctx.format);
    let rubricScores = m.rubricScores;
    let visualInterestBoosted = false;
    if (
      ctx.format.recordingFormat === "screen_only" &&
      m.momentType === "demo_payoff" &&
      routing.actionDense
    ) {
      const boosted = Math.min(
        rubricScores.visual_interest + CLIP_DEMO_PAYOFF_ACTION_BOOST,
        CLIP_RUBRIC_THRESHOLDS.maxPerDimension
      );
      if (boosted !== rubricScores.visual_interest) {
        rubricScores = { ...rubricScores, visual_interest: boosted };
        visualInterestBoosted = true;
      }
    }

    // Rubric bar (§8.3) — droppable ONLY (never ask the model to re-score).
    if (!meetsRubricThreshold(rubricScores)) {
      dropped.push({
        rank: m.rank,
        rule: "rubric_below_threshold",
        reason: `it scores ${rubricTotal(rubricScores)}/35 on the quality rubric (bar: 21, hook ≥3, standalone ≥4)`,
      });
      continue;
    }

    // Overlap vs. already-kept, higher-ranked candidates — repairable.
    const clash = kept.find((k) => overlapRatio(k, m) > CLIP_OVERLAP_MAX_RATIO);
    if (clash) {
      repairIssues.push({
        rank: m.rank,
        issue: `candidate ${m.rank}: overlaps candidate ${clash.rank} by more than ${Math.round(CLIP_OVERLAP_MAX_RATIO * 100)}% — pick distinct spans`,
      });
      dropped.push({
        rank: m.rank,
        rule: "overlapping_span",
        reason: `it overlaps the stronger candidate ${clash.rank}`,
      });
      continue;
    }

    const spanTranscript =
      m.stitchedScript?.trim() ||
      rs.map((r) => transcriptSlice(ctx.words, r.startMs, r.endMs)).join(" … ");

    // Deterministic hook-integrity: prune hooks with unsupported numbers, and
    // (FR-4) hooks citing a slide/diagram no slide-sync window backs. The
    // slide-ref lint only speaks when sync data EXISTS for the lesson.
    const syncCtx = {
      syncAvailable: (ctx.format.slideSync?.length ?? 0) > 0,
      slideWithinSpan: hasSlideWithinSpan(ctx.format.slideSync, envelopeSpan),
    };
    const hooks = [m.hookText, ...m.altHooks];
    const supportedHooks = hooks.filter(
      (h) =>
        lintHookNumbers(h, spanTranscript).length === 0 &&
        lintHookSlideRef(h, syncCtx).length === 0
    );
    if (supportedHooks.length === 0) {
      const slideRefOnly = hooks.some((h) => lintHookNumbers(h, spanTranscript).length === 0);
      repairIssues.push({
        rank: m.rank,
        issue: slideRefOnly
          ? `candidate ${m.rank}: every hook points at a slide/diagram that is not on screen during the span — hook what the clip actually shows`
          : `candidate ${m.rank}: every hook makes a numeric claim its own transcript never states — write hooks the span cashes`,
      });
      dropped.push({
        rank: m.rank,
        rule: slideRefOnly ? "hook_slide_ref_unsupported" : "hook_number_unsupported",
        reason: slideRefOnly
          ? "every proposed hook cites a slide the clip never shows"
          : "every proposed hook claims a number the clip never says",
        excerpt: m.hookText,
      });
      continue;
    }

    // Caption clamp to the tightest surviving platform cap (clamp-not-reject).
    const captionCap = Math.min(...fit.map((p) => CLIP_PLATFORM_SPECS[p].captionCap));
    let captionDraft = m.captionDraft;
    let captionClamped = false;
    if (captionDraft && captionDraft.length > captionCap) {
      captionDraft = `${captionDraft.slice(0, captionCap - 1)}…`;
      captionClamped = true;
    }

    // Safety lint (§7.4.4) over hook + caption + CTA — repairable.
    const safety = lintClipTextSurfaces(
      { hookText: supportedHooks[0], captionDraft, endCardCta: m.endCardCta },
      ctx.sourceContext
    );
    if (safety.length > 0) {
      repairIssues.push({
        rank: m.rank,
        issue: `candidate ${m.rank}: ${safety[0].reason} ("${safety[0].excerpt}")`,
      });
      dropped.push({
        rank: m.rank,
        rule: safety[0].rule,
        reason: safety[0].reason,
        excerpt: safety[0].excerpt,
      });
      continue;
    }

    kept.push({
      ...m,
      rubricScores,
      hookText: supportedHooks[0],
      altHooks: supportedHooks.slice(1),
      targetPlatformFit: fit as ClipPlatform[],
      captionDraft,
      spanTranscript,
      captionClamped,
      layout: routing.layout,
      actionDense: routing.actionDense,
      visualInterestBoosted,
    });
  }

  return { kept, dropped, repairIssues };
}

export interface VerdictResult {
  kept: NormalizedCandidate[];
  dropped: ClipDrop[];
}

/**
 * Apply the ONE validation call's verdicts (§7.4.2-3):
 *   - coherence fail + in-bound ±8s adjustment → span adjusted, transcript
 *     re-sliced (multi-segment candidates never adjust — they drop, §7.3).
 *   - coherence fail otherwise → drop.
 *   - hook verdicts: first hook the model marks supported is promoted;
 *     none → drop.
 * Verdicts are matched by rank; a candidate the model returned no verdict
 * for is kept as-is (fail-open on the MODEL forgetting, fail-closed on its
 * explicit verdicts — the deterministic layer already did the hard gating).
 */
export function applyValidationVerdicts(
  candidates: NormalizedCandidate[],
  verdicts: CandidateVerdict[],
  ctx: { durationMs: number; words: TranscriptWord[]; format: FormatCheckContext }
): VerdictResult {
  const byRank = new Map(verdicts.map((v) => [v.rank, v]));
  const kept: NormalizedCandidate[] = [];
  const dropped: ClipDrop[] = [];

  for (const m of candidates) {
    const v = byRank.get(m.rank);
    if (!v) {
      kept.push(m);
      continue;
    }

    let current = m;

    if (!v.coherence.pass) {
      const { adjustedStartMs, adjustedEndMs } = v.coherence;
      const hasAdjustment = adjustedStartMs !== null || adjustedEndMs !== null;
      const newStart = adjustedStartMs ?? current.startMs;
      const newEnd = adjustedEndMs ?? current.endMs;
      const inAdjustBound =
        Math.abs(newStart - current.startMs) <= CLIP_COHERENCE_ADJUST_MS &&
        Math.abs(newEnd - current.endMs) <= CLIP_COHERENCE_ADJUST_MS;
      const duration = newEnd - newStart;
      const inSpanBound =
        newStart >= 0 &&
        newEnd <= ctx.durationMs + 500 &&
        duration >= CLIP_SPAN_MIN_MS &&
        duration <= CLIP_SPAN_MAX_MS;

      if (current.segments !== null || !hasAdjustment || !inAdjustBound || !inSpanBound) {
        dropped.push({
          rank: current.rank,
          rule: "standalone_coherence",
          reason: v.coherence.offendingPhrase
            ? `it depends on context outside the clip ("${v.coherence.offendingPhrase}")`
            : "it depends on context outside the clip",
        });
        continue;
      }
      // FR-2: a shifted span can change the routing facts (sync coverage,
      // action density) — re-resolve the layout for the FINAL span.
      const adjusted = { startMs: newStart, endMs: newEnd };
      const routing = routingFor(adjusted, ctx.words, ctx.format);
      current = {
        ...current,
        startMs: newStart,
        endMs: newEnd,
        spanTranscript: transcriptSlice(ctx.words, newStart, newEnd),
        layout: routing.layout,
        actionDense: routing.actionDense,
      };
    }

    // Hook integrity: verdicts arrive in [hookText, ...altHooks] order.
    const orderedHooks = [current.hookText, ...current.altHooks];
    const supported = orderedHooks.filter((h) => {
      const verdict = v.hooks.find((hv) => hv.hook === h);
      return verdict ? verdict.supported : true; // no verdict for this hook ⇒ keep
    });
    if (supported.length === 0) {
      const firstBad = v.hooks.find((hv) => !hv.supported);
      dropped.push({
        rank: current.rank,
        rule: "hook_integrity",
        reason: firstBad?.unsupportedClaim
          ? `its hooks promise "${firstBad.unsupportedClaim}" but the clip never delivers it`
          : "its hooks promise things the clip never delivers",
        excerpt: current.hookText,
      });
      continue;
    }
    kept.push({ ...current, hookText: supported[0], altHooks: supported.slice(1) });
  }

  return { kept, dropped };
}
