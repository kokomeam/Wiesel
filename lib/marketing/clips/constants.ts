/**
 * Lesson Clip Repurposing — single-source constants (Phase 1.5 PRD §8).
 *
 * CLIP_PLATFORM_SPECS is the §8.5 pacing table, imported by ALL sides (the
 * prompt's platform pacing block, the Zod caption caps, the eval harness, and
 * the future clips UI counters) — never copied. The moment taxonomy (§8.2) and
 * the scoring rubric thresholds (§8.3) live here so the prompt, the validation
 * pass, and the eval harness all read one table.
 *
 * Platform ids deliberately match the (future, M-C) `social_post.platform`
 * values: `facebook` reuses the Phase 1 value (a Facebook clip is a Reel);
 * `instagram` / `tiktok` / `youtube_shorts` are NEW values that the M-C
 * migration adds to the DB check constraint gated to post_type='clip' (text
 * posts stay closed at LinkedIn + Facebook — the Phase 1 rule). LinkedIn is
 * NOT a clip target in MVP (PRD §5).
 */

import type { ReasoningEffort } from "@/lib/ai/modelClient";
// Language rules are Phase 1 §3, verbatim (PRD §3): one notice string, one
// banned-phrase list — re-exported so clips UI/tests read the SAME constants.
export { BANNED_UI_PHRASES, MANUAL_PUBLISH_NOTICE, FUNNEL_STAGES } from "../social/constants";
export type { FunnelStage } from "../social/constants";

export const CLIP_PLATFORMS = ["instagram", "tiktok", "youtube_shorts", "facebook"] as const;
export type ClipPlatform = (typeof CLIP_PLATFORMS)[number];

/* ──────────── recording formats + clip layouts (amendment §1) ──────────── */

/**
 * Recording format = a FACT about the lesson recording, chosen by the teacher
 * at record time. The literals deliberately equal the platform's OWN
 * `VideoRecordingMode` union (lib/course/types.ts) — the metadata read is an
 * identity map, never a translation table. Zod mirrors live in schemas.ts
 * (`RecordingFormatSchema`); never hand-write the TS type elsewhere.
 */
export const RECORDING_FORMATS = ["camera_only", "screen_camera", "screen_only"] as const;
export const FORMAT_SOURCES = ["platform", "classifier", "creator_override"] as const;

/**
 * Layout = a DECISION about a render job/candidate. Formats are facts;
 * layouts are decisions; routing.ts maps facts → decisions (FR-2).
 */
export const CLIP_LAYOUTS = [
  "face_track",
  "stacked_split",
  "slide_short",
  "screen_action_zoom",
  "audiogram",
] as const;

/** FR-9 human copy — defined with the enum so the M-E chips import, not copy. */
export const CLIP_LAYOUT_LABELS: Record<(typeof CLIP_LAYOUTS)[number], string> = {
  face_track: "Face clip",
  stacked_split: "Split screen + camera",
  slide_short: "Slide short",
  screen_action_zoom: "Screen zoom",
  audiogram: "Audiogram",
};

/** FR-9: the honest caveat carried by audiogram candidates (simplest visual
 *  treatment) — single-sourced here for the M-E card and the tool summary. */
export const CLIP_AUDIOGRAM_CAVEAT =
  "simplest visual treatment — consider enabling slide previews for richer clips";

/* ───────────── format classifier thresholds (FR-1, binding) ────────────── */

/** ≥8 sampled frames spread across the duration (FR-1). */
export const FORMAT_CLASSIFIER_MIN_FRAMES = 8;
/** Face present in ≥60% of samples (FR-1's binding threshold). */
export const FORMAT_CLASSIFIER_FACE_PCT = 0.6;
/** "Frame-dominant screen content" bar: screen content in ≥50% of samples
 *  distinguishes screen_camera from camera_only once the face bar is met. */
export const FORMAT_CLASSIFIER_SCREEN_PCT = 0.5;

/* ─────────────── action-density lexicon + thresholds (FR-3) ────────────── */

/**
 * Demonstration cues — transcript evidence that the SCREEN is doing something
 * worth watching during a span (typing, clicking, building, a visible
 * before/after). Regex SOURCES compiled with word boundaries in
 * actionDensity.ts; adding a cue is a data change only (FR-3) — extend this
 * array, run `npm run verify:clips`, done. Maintenance guide: docs/clips.md.
 */
export const CLIP_ACTION_CUES: readonly string[] = [
  "watch what happens",
  "watch this",
  "watch as",
  "let me show you",
  "let me demonstrate",
  "i'?ll show you",
  "as i (?:type|draw|build|click|drag|write|run|scroll|paint)",
  "(?:as )?you can see",
  "you'?ll see",
  "notice (?:how|what|the)",
  "look at (?:this|that|the)",
  "if (?:i|we) (?:click|type|run|change|add|remove|drag|delete)",
  "let'?s (?:run|build|type|try|add|click|open|create|write)",
  "i'?m (?:typing|clicking|dragging|drawing|building|running|painting)",
  "on (?:the )?screen",
  "step by step",
  "now i (?:click|type|run|add|select|open|drag)",
  "here'?s what happens",
  "run (?:this|the|it)",
  "hit (?:enter|run|save)",
  "the (?:output|result|plan|number) (?:changes|updates|drops|shows|becomes)",
  "in real time",
] as const;

/**
 * Action-dense bar (FR-3): a span is action-dense when its transcript-cue
 * rate meets CLIP_ACTION_DENSITY_THRESHOLD (distinct cue hits per minute),
 * OR — when a frame-diff signal is available — the coarse frame-difference
 * ratio meets CLIP_ACTION_FRAME_DIFF_THRESHOLD.
 *
 * Default 2 cues/min, rationale (documented per FR-3): annotating the eval
 * fixtures, live demo narration ("watch this", "as I type…") lands 3-6 cues
 * per minute while slide/lecture reading lands 0-1; 2/min splits the two
 * populations with margin on both sides. Frame-diff 0.15 = ≥15% of sampled
 * adjacent-frame pairs differ materially — motion on an otherwise static
 * screen recording. Frame sampling needs locally accessible media (ffmpeg);
 * when unavailable (this runtime today) transcript cues alone decide — the
 * documented, tested degraded mode.
 */
export const CLIP_ACTION_DENSITY_DEFAULT_THRESHOLD = 2;
export const CLIP_ACTION_FRAME_DIFF_DEFAULT_THRESHOLD = 0.15;

export function clipActionDensityThreshold(): number {
  const v = Number(process.env.CLIP_ACTION_DENSITY_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : CLIP_ACTION_DENSITY_DEFAULT_THRESHOLD;
}
export function clipActionFrameDiffThreshold(): number {
  const v = Number(process.env.CLIP_ACTION_FRAME_DIFF_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : CLIP_ACTION_FRAME_DIFF_DEFAULT_THRESHOLD;
}

/** FR-4: demo_payoff's deterministic rubric boost (visual_interest +N, capped
 *  at 5) when the format is screen_only AND the span is action-dense. */
export const CLIP_DEMO_PAYOFF_ACTION_BOOST = 1;

/**
 * FR-4: the per-format visual_interest scoring instruction. ALL formats'
 * lines render in the STATIC system prompt (byte-stable — the caching rule);
 * the lesson's actual format rides the variable request block.
 */
export const CLIP_VISUAL_INTEREST_FORMAT_LINES: Record<(typeof RECORDING_FORMATS)[number], string> = {
  camera_only:
    "the footage is the speaker on camera — score gesture, physical demos, props, and shown objects; talking-head-only caps at 3",
  screen_camera:
    "the footage is the screen with a camera bubble — score what the SCREEN shows during the span (action, build-up, visual payoff) first, speaker presence second",
  screen_only:
    "the footage is the screen ONLY — score what the screen shows during the span (action, build-up, visual payoff), NOT speaker presence; a span carried by one clear slide/diagram scores on that visual's explanatory power (\"this one diagram explains X\" is a valid hook basis); narration over a static wall of text caps at 2, and reading a slide's bullets aloud IS a static wall of text",
};

export interface ClipPlatformSpec {
  /** Human label for UI + prompt ("Instagram Reels", not "instagram"). */
  label: string;
  /** Duration sweet spot in ms (the prompt steers here). */
  sweetSpotMs: readonly [number, number];
  /** Hard duration cap in ms (MVP) — enforced in Zod per platform. */
  hardCapMs: number;
  /** The hook must land within this window (ms) — prompt + preset pacing. */
  hookWindowMs: number;
  /** Caption character cap enforced in Zod (YouTube Shorts: the TITLE). */
  captionCap: number;
  /** Caption register line fed verbatim into the prompt's pacing spec. */
  captionNote: string;
  hashtagMin: number;
  hashtagMax: number;
  /** End-card CTA framing (comment-keyword vs. subscribe/link). */
  endCardCta: string;
}

export const CLIP_PLATFORM_SPECS: Record<ClipPlatform, ClipPlatformSpec> = {
  instagram: {
    label: "Instagram Reels",
    sweetSpotMs: [20_000, 45_000],
    hardCapMs: 90_000,
    hookWindowMs: 2_000,
    captionCap: 2_200,
    captionNote: "≤125 characters visible before the fold — front-load the value",
    hashtagMin: 3,
    hashtagMax: 8,
    endCardCta: "comment-keyword primary",
  },
  tiktok: {
    label: "TikTok",
    sweetSpotMs: [25_000, 60_000],
    hardCapMs: 90_000,
    hookWindowMs: 3_000,
    captionCap: 2_200,
    captionNote: "short and punchy",
    hashtagMin: 3,
    hashtagMax: 5,
    endCardCta: "comment-keyword primary",
  },
  youtube_shorts: {
    label: "YouTube Shorts",
    sweetSpotMs: [30_000, 60_000],
    hardCapMs: 60_000,
    hookWindowMs: 3_000,
    captionCap: 100,
    captionNote: "this is the video TITLE (≤100 chars) — searchable, no clickbait",
    hashtagMin: 0,
    hashtagMax: 2,
    endCardCta: "subscribe / link-in-description framing",
  },
  facebook: {
    label: "Facebook Reels",
    sweetSpotMs: [20_000, 45_000],
    hardCapMs: 90_000,
    hookWindowMs: 2_000,
    captionCap: 5_000,
    captionNote: "conversational",
    hashtagMin: 0,
    hashtagMax: 3,
    endCardCta: "comment-keyword primary",
  },
};

/* ─────────────────── teachable-moment taxonomy (§8.2) ─────────────────── */

export const CLIP_MOMENT_TYPES = [
  "misconception_buster",
  "counterintuitive_reveal",
  "concrete_win",
  "mistake_autopsy",
  "before_after",
  "demo_payoff",
  "story_beat",
  "definition_reframe",
] as const;
export type ClipMomentType = (typeof CLIP_MOMENT_TYPES)[number];

/** Prompt-facing one-liners — the selection targets for this vertical.
 *  "Speaker sounds excited" is deliberately NOT a type (§8.2 closing rule). */
export const CLIP_MOMENT_TYPE_LINES: Record<ClipMomentType, string> = {
  misconception_buster:
    "names a belief the audience holds, shows it's wrong, corrects it — boosted when quiz-miss data confirms the misconception",
  counterintuitive_reveal:
    "a true thing that sounds false; opens a curiosity gap the span itself closes",
  concrete_win: "a tip/technique with immediately visible payoff (do X, get Y today)",
  mistake_autopsy: "walks through a common error and its fix",
  before_after: "a transformation shown or described within the span",
  demo_payoff:
    "a visually interesting demonstration moment (flag for platforms where visuals carry: Reels/TikTok)",
  story_beat: "an anecdote with a lesson; MOFU-leaning",
  definition_reframe: "a familiar concept redefined memorably",
};

/* ────────────────────────── scoring rubric (§8.3) ─────────────────────── */

export const CLIP_RUBRIC_DIMENSIONS = [
  "hook_potential",
  "standalone",
  "specificity",
  "curiosity_gap",
  "pedagogical_value",
  "visual_interest",
  "brand_safety",
] as const;
export type ClipRubricDimension = (typeof CLIP_RUBRIC_DIMENSIONS)[number];

export const CLIP_RUBRIC_DIMENSION_LINES: Record<ClipRubricDimension, string> = {
  hook_potential: "would the first 3 seconds stop a scroll",
  standalone: "a complete thought, no context debt",
  specificity: "concrete nouns/numbers/steps vs. abstraction",
  curiosity_gap: "opens a question it answers",
  pedagogical_value: "the viewer learns something real",
  visual_interest: "what's on screen; talking-head-only caps at 3",
  brand_safety:
    "nothing embarrassing mid-span, no half-statements that misrepresent the creator",
};

/** Candidate viability bar (§8.3) — single source for the validation pass,
 *  the eval harness, and the prompt. 7 dimensions × 0–5 = 35 max. */
export const CLIP_RUBRIC_THRESHOLDS = {
  totalMin: 21,
  hookPotentialMin: 3,
  standaloneMin: 4,
  maxPerDimension: 5,
} as const;

/* ─────────────────────── span & batch discipline ──────────────────────── */

/** Contiguous span bounds (§7.2): 20–90s. Per-platform hard caps (§8.5) may
 *  tighten the top (YouTube Shorts: 60s). */
export const CLIP_SPAN_MIN_MS = 20_000;
export const CLIP_SPAN_MAX_MS = 90_000;
/** ≤5 candidates per selection call — mirrors Phase 1 batch discipline. */
export const CLIP_MAX_CANDIDATES = 5;
/** Two candidates may share at most 20% of the shorter span (§7.2). */
export const CLIP_OVERLAP_MAX_RATIO = 0.2;
/** A failed coherence check may trim/extend the span by at most ±8s (§7.4.2). */
export const CLIP_COHERENCE_ADJUST_MS = 8_000;
/** Hook = overlay text, ≤10 words (§7.2/§8.4). */
export const CLIP_HOOK_MAX_WORDS = 10;
/** Exactly 2 alternate hooks per candidate (§7.2). */
export const CLIP_ALT_HOOK_COUNT = 2;

/* ─────────────────────────── runtime config ───────────────────────────── */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Map-step chunk size (tokens) and the ± excerpt padding (ms) the reduce
 *  step keeps around each shortlisted span. */
export const CLIP_MAP_CHUNK_TOKENS = 6_000;
export const CLIP_REDUCE_EXCERPT_PAD_MS = 10_000;

export interface ClipConfig {
  /** Course-context token budget (mirrors SOCIAL_CONTEXT_MAX_TOKENS). */
  contextMaxTokens: number;
  /** Transcript token budget for the selection call (§7.5, ~4 chars/token).
   *  Longer lessons go through the sequential map→reduce path. */
  transcriptMaxTokens: number;
  /** Hard per-call generation ceiling — quality-first, NOT a latency target
   *  (the Phase 1 amended rule). Timeout ⇒ typed error, nothing persisted. */
  selectionTimeoutMs: number;
  /** Mid-tier moment selection (undefined → the provider's env default).
   *  NEVER downgraded for latency (§7.5). */
  selectModel: string | undefined;
  selectEffort: ReasoningEffort;
  /** Small tier: the ONE validation call (coherence + hook integrity). */
  validateModel: string | undefined;
  validateEffort: ReasoningEffort;
  /** Small tier: the per-chunk map step for very long transcripts. */
  mapModel: string | undefined;
  mapEffort: ReasoningEffort;
}

export function clipConfig(): ClipConfig {
  return {
    contextMaxTokens: envInt("CLIP_CONTEXT_MAX_TOKENS", 6_000),
    transcriptMaxTokens: envInt("CLIP_TRANSCRIPT_MAX_TOKENS", 24_000),
    selectionTimeoutMs: envInt("CLIP_SELECTION_TIMEOUT_MS", 180_000),
    selectModel: process.env.CLIP_SELECT_MODEL || undefined,
    selectEffort: (process.env.CLIP_SELECT_EFFORT as ReasoningEffort) || "medium",
    validateModel: process.env.CLIP_VALIDATE_MODEL || undefined,
    validateEffort: (process.env.CLIP_VALIDATE_EFFORT as ReasoningEffort) || "low",
    mapModel: process.env.CLIP_MAP_MODEL || undefined,
    mapEffort: (process.env.CLIP_MAP_EFFORT as ReasoningEffort) || "low",
  };
}

/* ───────────────────── render jobs + quotas (M-B) ─────────────────────── */

/** Provider submissions per creator per trailing minute (the PRD's bucket). */
export const CLIP_RENDER_TOKENS_PER_MIN_DEFAULT = 10;
/** Render jobs per creator per UTC day. */
export const CLIP_JOBS_PER_DAY_DEFAULT = 20;
/** Cost-minutes per creator per UTC month (provider billedDuration +
 *  in-house minutes × CLIP_INHOUSE_MINUTE_RATE — one ledger, one quota). */
export const CLIP_MINUTES_PER_MONTH_DEFAULT = 60;
/** Compute-minute rate for in-house renders (ffmpeg now, Remotion at M-F)
 *  so the ledger stays meaningful across providers. */
export const CLIP_INHOUSE_MINUTE_RATE_DEFAULT = 1;
/** A job step is retried this many times before failing terminally. */
export const CLIP_JOB_MAX_ATTEMPTS = 3;
/** A rendering_local row untouched this long is presumed crashed → retried. */
export const CLIP_LOCAL_RENDER_STALE_MS = 10 * 60_000;

export function clipRenderConfig() {
  return {
    tokensPerMinute: envInt("CLIP_RENDER_TOKENS_PER_MIN", CLIP_RENDER_TOKENS_PER_MIN_DEFAULT),
    jobsPerDay: envInt("CLIP_JOBS_PER_DAY", CLIP_JOBS_PER_DAY_DEFAULT),
    minutesPerMonth: envInt("CLIP_MINUTES_PER_MONTH", CLIP_MINUTES_PER_MONTH_DEFAULT),
    inhouseMinuteRate: envInt("CLIP_INHOUSE_MINUTE_RATE", CLIP_INHOUSE_MINUTE_RATE_DEFAULT),
  };
}

/* ───────────────────────── candidate lifecycle ────────────────────────── */

export const CLIP_CANDIDATE_STATUSES = ["candidate", "selected", "dismissed"] as const;
export type ClipCandidateStatus = (typeof CLIP_CANDIDATE_STATUSES)[number];
