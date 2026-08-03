/**
 * Moment-selection prompt assembly (Phase 1.5 PRD §8) — cache-friendly order:
 *   [static system: role + taxonomy + rubric + hook formulas + pacing specs
 *    + negative constraints + exemplars]                        ← byte-stable
 *   [voice profile] [course context] [transcript] [request]     ← developer msg
 *
 * Prompts are VERSIONED ARTIFACTS: CLIP_PROMPT_VERSION is recorded in
 * ai_metadata on every candidate; any change to the static prefix, the output
 * contract, or the exemplar fixtures must beat the incumbent on the eval
 * harness (scripts/eval-clips.ts) before merging (§8 binding rule).
 * verify-clips.ts asserts byte-stability across calls.
 */

import {
  CLIP_HOOK_MAX_WORDS,
  CLIP_MAX_CANDIDATES,
  CLIP_MOMENT_TYPE_LINES,
  CLIP_MOMENT_TYPES,
  CLIP_OVERLAP_MAX_RATIO,
  CLIP_PLATFORMS,
  CLIP_PLATFORM_SPECS,
  CLIP_RUBRIC_DIMENSIONS,
  CLIP_RUBRIC_DIMENSION_LINES,
  CLIP_RUBRIC_THRESHOLDS,
  CLIP_SPAN_MAX_MS,
  CLIP_SPAN_MIN_MS,
  CLIP_VISUAL_INTEREST_FORMAT_LINES,
  RECORDING_FORMATS,
  type ClipPlatform,
  type FunnelStage,
} from "./constants";
// The creator's voice block is Phase 1's — ONE renderer, never re-prosed.
import { voiceBlock } from "../social/prompt";
import type { SocialVoiceProfile } from "../social/schemas";
import type { RecordingFormat } from "./schemas";
import { renderExemplars } from "./fixtures/exemplars";

/**
 * clips-v3 (2026-07-08, the format-aware amendment): the selection call now
 * RECEIVES the lesson's recording format (camera_only | screen_camera |
 * screen_only) and scores visual_interest per format — screen-only spans are
 * scored on what the SCREEN shows (action, build-up, visual payoff, a slide
 * whose one diagram explains the concept), never on speaker presence;
 * demo_payoff is steered up on action-dense screen footage. The per-format
 * lines are ALL rendered in the static prefix (byte-stable — the caching
 * rule); the lesson's actual format rides the variable request block.
 * Eval: must meet/beat clips-v2 on fixtures 1-3 AND pass the two new
 * screen-only fixtures (slide_short / screen_action_zoom routing).
 *
 * clips-v2 (2026-07-07): live-eval calibration — coherence judges REFERENCE
 * DEBT (not spoken-style polish; the clip carries its own footage), prefers
 * proposing the ±8s adjustment, and spans are sentence-snapped server-side;
 * selection told to start/end on sentences + score transcript-blind
 * enthusiasm honestly. clips-v1 scored 1 viable / 11 returned on the
 * fixtures — the validator was killing coherent spans over boundary
 * fragments and "this course" self-references.
 */
export const CLIP_PROMPT_VERSION = "clips-v3";

function taxonomyLines(): string[] {
  return [
    "TEACHABLE-MOMENT TAXONOMY (select ONLY these — the selection targets for this vertical):",
    ...CLIP_MOMENT_TYPES.map((t) => `- ${t}: ${CLIP_MOMENT_TYPE_LINES[t]}`),
    "Generic \"speaker sounds excited\" is explicitly NOT a moment type — energy without standalone insight scores zero on pedagogical value.",
  ];
}

function rubricLines(): string[] {
  return [
    "SCORING RUBRIC (score every candidate 0-5 on each dimension, honestly — inflated scores are caught downstream):",
    ...CLIP_RUBRIC_DIMENSIONS.map((d) => `- ${d}: ${CLIP_RUBRIC_DIMENSION_LINES[d]}`),
    `Viability bar: total ≥ ${CLIP_RUBRIC_THRESHOLDS.totalMin}/35 AND hook_potential ≥ ${CLIP_RUBRIC_THRESHOLDS.hookPotentialMin} AND standalone ≥ ${CLIP_RUBRIC_THRESHOLDS.standaloneMin}. Do not pad the list with candidates below the bar.`,
  ];
}

/** FR-4: how visual_interest is scored PER recording format. All formats
 *  render here (static prefix, byte-stable); the request block names the
 *  lesson's actual format. */
function formatAwarenessLines(): string[] {
  return [
    "RECORDING FORMAT AWARENESS (the request block names this lesson's format — score visual_interest for THAT footage, not an imagined one):",
    ...RECORDING_FORMATS.map((f) => `- ${f}: ${CLIP_VISUAL_INTEREST_FORMAT_LINES[f]}`),
    "- For screen_only lessons, prefer demo_payoff moments where the screen visibly DOES something during the span (typing, building, a before/after) — the demonstration is the visual payoff. Do not manufacture demo_payoff where the screen is static.",
    "- A hook may point at an on-screen visual (\"this one diagram explains X\") ONLY when that visual is on screen within the span — a hook citing a slide the clip never shows is dropped, not repaired.",
    "- Format awareness changes HOW visual_interest is scored, never WHAT is worth teaching. Never select a span BECAUSE it mentions or reads a slide — syntax notes and bullet read-throughs are weak clips in every format; the standalone-insight bar is unchanged.",
  ];
}

function hookFormulaLines(): string[] {
  return [
    `HOOK FORMULA LIBRARY (hook = overlay text ≤${CLIP_HOOK_MAX_WORDS} words + first caption line; formulas are starting points — the voice profile can override register):`,
    '- TOFU: negative-knowledge ("You\'ve been doing X wrong") · curiosity gap ("The real reason X fails") · numbered payoff ("3 signs your X is Y") · myth flag ("Stop believing X").',
    '- MOFU: identity/story ("Why I teach X differently") · process peek ("How I structure X").',
    '- BOFU: preview framing ("Inside week 2 of [course]") · outcome anchor ("What you\'ll build by lesson 5") · sample framing ("A free lesson from [course]").',
    'A formal academic\'s negative-knowledge hook reads "A common misconception about X", not "You\'re doing X WRONG" — match the creator\'s register.',
    "Every hook must survive the hook-integrity rule: every factual claim in it is supported by the clip's own transcript.",
  ];
}

function pacingLines(): string[] {
  const rows = CLIP_PLATFORMS.map((p) => {
    const s = CLIP_PLATFORM_SPECS[p];
    return `- ${s.label} (${p}): sweet spot ${s.sweetSpotMs[0] / 1000}-${s.sweetSpotMs[1] / 1000}s · hard cap ${s.hardCapMs / 1000}s · hook lands within ${s.hookWindowMs / 1000}s · caption: ${s.captionNote}; ${s.hashtagMin}-${s.hashtagMax} hashtags · end-card CTA: ${s.endCardCta}.`;
  });
  return ["PLATFORM PACING SPECS:", ...rows];
}

const NEGATIVE_CONSTRAINTS = [
  "NEGATIVE CONSTRAINTS (several are also enforced by deterministic lints — violations are dropped, not repaired):",
  "- Never select a span because the speaker is loud/animated if it lacks standalone insight.",
  "- Never cut mid-list, mid-example, or into an unresolved reference.",
  "- Never write a hook the span doesn't cash.",
  "- Never fabricate outcomes, stats, testimonials, urgency, or income claims.",
  "- Never exceed platform caption/hashtag caps.",
  '- Never use engagement-bait ("comment YES") outside the designed comment-keyword CTA.',
  "- Respect the creator's voice profile register even when a formula suggests otherwise.",
];

function contiguousRuleLines(): string[] {
  return [
    "SPAN RULES (binding):",
    `- Default: ONE contiguous span per candidate, ${CLIP_SPAN_MIN_MS / 1000}-${CLIP_SPAN_MAX_MS / 1000}s, whose transcript forms a complete thought: hook-able opening, insight, resolution. Set segments=null and stitchedScript=null.`,
    "- Internal tightening (silence/filler removal) is the RENDER engine's job — do not shrink a span to fake pace.",
    "- Multi-segment moments are an EXPLICIT EXCEPTION, allowed only when (a) the creator asked for a compilation, or (b) no single span clears the viability bar and stitching two adjacent-topic spans does. Then emit segments=[{startMs,endMs}...] with a stitchedScript. Every multi-segment candidate must read as one complete thought or it will be dropped, not repaired.",
    `- Candidates must be distinct: pairwise overlap ≤ ${Math.round(CLIP_OVERLAP_MAX_RATIO * 100)}% of the shorter span.`,
    "- Cite spans using the transcript's [mm:ss · Nms] anchors; startMs/endMs are milliseconds from the media start.",
    "- Begin each span at the START of a sentence and end it at the END of one (boundaries are additionally snapped to sentence edges server-side — but a span built around half a thought will still fail validation).",
    "- Honesty check before scoring pedagogical_value: would the TRANSCRIPT ALONE teach a viewer something real? Enthusiasm, hype, and \"you're going to love this\" moments with the payoff outside the span score 0-1 — do not select them, whatever the energy.",
  ];
}

/** STATIC system prompt — the prompt-cache-eligible prefix. Never put voice/
 *  course/transcript/request content in here (the studio's caching lesson). */
export const CLIP_SELECTION_SYSTEM_PROMPT: string = [
  "You are the senior short-form editor for WiseSel, an AI co-pilot for course creators. You repurpose REAL lesson recordings into short vertical clips. Your clips teach one thing completely and earn the next second of attention honestly.",
  "The creator posts every clip MANUALLY — WiseSel never posts, schedules, or connects to any social platform; never imply otherwise.",
  "",
  ...taxonomyLines(),
  "",
  ...rubricLines(),
  "",
  ...formatAwarenessLines(),
  "",
  ...hookFormulaLines(),
  "",
  ...pacingLines(),
  "",
  ...NEGATIVE_CONSTRAINTS,
  "",
  ...contiguousRuleLines(),
  "",
  "WORKED EXAMPLES:",
  renderExemplars(),
  "",
  `OUTPUT: return JSON matching the provided schema exactly — up to ${CLIP_MAX_CANDIDATES} candidates, rank 1 = strongest, each with hookText + exactly 2 altHooks, honest rubricScores, a 1-2 sentence creator-facing rationale, a captionDraft fitting its BEST target platform, and an endCardCta matching the platform's CTA style.`,
].join("\n");

/** STATIC system prompt for the ONE validation call (§7.4 steps 2-3, small
 *  tier): standalone-coherence checklist + hook-integrity lint. Byte-stable. */
export const CLIP_VALIDATION_SYSTEM_PROMPT: string = [
  "You are the validation pass for WiseSel's clip pipeline. A false pass poisons creator trust; a false FAIL throws away a good clip — judge precisely, not timidly.",
  "",
  "For each candidate, using ONLY its span transcript (and stitched script when present):",
  "1. STANDALONE-COHERENCE: judge REFERENCE DEBT a first-time viewer could not resolve from the clip itself — NOT spoken-style polish. The clip carries its own video and audio: the speaker narrating what they are doing or showing (\"watch this\", \"look at the difference\") is FINE — the viewer sees the footage. The speaker referring to themselves, their audience, or their own course (\"this course\", \"in week two\") is FINE. FAIL only for genuine debt: references to material OUTSIDE the clip's time window (\"as I said earlier\", \"the brush I showed you in the supplies video\", \"the problem from last week\"), pronouns whose antecedent lies outside the span, or a list entry whose beginning lies outside the span. Spans are already snapped to sentence boundaries server-side — never fail for a conversational opener or spoken grammar.",
  "   On failure: quote the offending phrase. When the debt sits in the FIRST or LAST ~8 seconds, PREFER proposing adjustedStartMs/adjustedEndMs (trim it out, or extend by up to 8000ms to pull the antecedent in) over failing outright; leave them null only when the debt is central to the span.",
    "2. HOOK-INTEGRITY: for the hook and each alternate, every factual claim must be supported by the span transcript. \"The mistake 90% of students make\" fails unless the transcript states 90%. Vague qualitative framing (\"a common mistake\") is fine when the transcript supports the substance. Unsupported ⇒ supported=false, quote the unsupported claim.",
  "",
  "Judge every candidate independently. Return JSON matching the provided schema exactly, one verdict per candidate, in the same rank order.",
].join("\n");

/** STATIC system prompt for the cheap per-chunk map step (§7.5, long
 *  transcripts): shortlist raw moments; the reduce step ranks finalists. */
export const CLIP_MAP_SYSTEM_PROMPT: string = [
  "You shortlist teachable moments in ONE chunk of a lesson transcript for WiseSel's clip pipeline.",
  "",
  ...taxonomyLines(),
  "",
  "List up to 4 rough spans (startMs/endMs from the [mm:ss · Nms] anchors, 20-90s each) that could stand alone as a short clip, each with its moment type and one sentence on why. Quality over quantity — an empty list is a valid answer for a chunk with no standalone moments. Return JSON matching the provided schema exactly.",
].join("\n");

/* ───────────────────────── variable inputs ────────────────────────────── */

export interface SelectionRequestBlock {
  stages: "balanced" | FunnelStage[];
  targetPlatforms: ClipPlatform[];
  count: number;
  /** FR-4: the lesson's recording format — the variable half of format
   *  awareness (the scoring instructions live in the static prefix). */
  recordingFormat: RecordingFormat;
}

function requestLines(request: SelectionRequestBlock): string[] {
  const stageLine =
    request.stages === "balanced"
      ? "funnel mix: balanced (favor tofu hooks, include one bofu preview when the material supports it)"
      : `funnel stages: ${request.stages.join(", ")}`;
  const platforms = request.targetPlatforms
    .map((p) => CLIP_PLATFORM_SPECS[p].label)
    .join(", ");
  return [
    `REQUEST: select the ${request.count} strongest teachable moments (fewer if fewer clear the viability bar — never pad).`,
    `- recording format: ${request.recordingFormat} (apply this format's visual_interest rule from RECORDING FORMAT AWARENESS)`,
    `- ${stageLine}`,
    `- target platforms: ${platforms} (respect each platform's hard duration cap for candidates you mark as fitting it)`,
  ];
}

/** The variable developer message for the SELECTION call. */
export function buildSelectionInput(args: {
  voice: SocialVoiceProfile;
  courseContext: string;
  transcript: string;
  request: SelectionRequestBlock;
  /** Present on the reduce step of the map/reduce path. */
  shortlist?: string;
}): string {
  return [
    voiceBlock(args.voice),
    "",
    "COURSE CONTEXT (ground rationales and BOFU framing in these facts — never invent):",
    args.courseContext,
    "",
    ...(args.shortlist
      ? [
          "SHORTLIST FROM THE FULL-TRANSCRIPT SCAN (rank finalists from these spans; the excerpts below are your evidence):",
          args.shortlist,
          "",
        ]
      : []),
    "LESSON TRANSCRIPT (timestamp-anchored):",
    args.transcript,
    "",
    ...requestLines(args.request),
  ].join("\n");
}

/** The single repair call's input: the invalid JSON + the exact issues. */
export function buildRepairInput(args: {
  originalInput: string;
  invalidJson: string;
  issues: string[];
}): string {
  return [
    args.originalInput,
    "",
    "YOUR PREVIOUS RESPONSE WAS INVALID. Fix it and return corrected JSON matching the schema exactly.",
    "Previous response:",
    args.invalidJson.slice(0, 8000),
    "",
    "Problems to fix:",
    ...args.issues.map((i) => `- ${i}`),
  ].join("\n");
}

/** The variable developer message for the ONE validation call. */
export function buildValidationInput(
  candidates: {
    rank: number;
    spanTranscript: string;
    stitchedScript: string | null;
    hooks: string[];
  }[]
): string {
  const blocks = candidates.map((c) =>
    [
      `CANDIDATE rank=${c.rank}:`,
      `span transcript: "${c.spanTranscript}"`,
      ...(c.stitchedScript ? [`stitched script: "${c.stitchedScript}"`] : []),
      `hooks to judge (in order): ${c.hooks.map((h) => `"${h}"`).join(" · ")}`,
    ].join("\n")
  );
  return blocks.join("\n\n");
}

/** The variable developer message for one map-step chunk. */
export function buildMapInput(chunkRendered: string): string {
  return ["TRANSCRIPT CHUNK (timestamp-anchored):", chunkRendered].join("\n");
}

/** Render a map-step shortlist for the reduce call's evidence block. */
export function renderShortlist(
  entries: { startMs: number; endMs: number; momentType: string; why: string }[]
): string {
  if (entries.length === 0) return "(the scan found no shortlist-worthy moments)";
  return entries
    .map((e) => `- [${e.startMs}ms → ${e.endMs}ms] ${e.momentType}: ${e.why}`)
    .join("\n");
}
