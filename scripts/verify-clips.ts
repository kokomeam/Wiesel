/**
 * Lesson Clip Repurposing (Phase 1.5, M-A + the format-aware amendment) —
 * PURE suite (no key, no DB).
 *
 *   - constants: the §8.5 pacing table (4 clip platforms, caps, hook windows),
 *     the §8.2 taxonomy (8 types, no "energy" type), the §8.3 rubric bar
 *   - Zod gates: ModelMoment shape (hook ≤10 words, exactly 2 altHooks,
 *     multi-segment exception rules), batch 1-5, strict-schema conversion
 *   - transcripts: VTT-cue → word interpolation, prompt anchors, chunking,
 *     span slicing
 *   - validate: every deterministic rule (bounds, duration, platform-cap
 *     pruning, rubric bar, overlap, hook numbers, caption clamp, safety lint
 *     + whitelist), verdict application (±8s adjustment, multi-segment drop,
 *     hook promotion)
 *   - the FULL pipeline core against the mock model: happy · repair-on-
 *     invalid · repair-on-flagged · rubric drop (no repair wasted) ·
 *     coherence adjust · hook promotion · unreadable-verdict fail-closed ·
 *     map→reduce for over-budget transcripts · per-tier efforts
 *   - prompt: byte-stable prefix, version pin, exemplars (3 strong/3
 *     rejected), pacing rows, negative constraints
 *   - fixtures: 5 lessons, gold spans in-bounds and 20-90s, flat-affect ≥2
 *   - drift guards: TS event union ↔ migration check constraint
 *   - tool registry: 1 read + 2 reversible, ZERO irreversible
 *   - hardening greps: no publish/schedule endpoint references, banned UI
 *     language, no scheduler primitives, text platform enum still closed at 2
 *
 *   AMENDMENT sections (the directive's named specs — this repo has no
 *   jest/vitest, so each *.spec.ts name maps to a named section here; the
 *   int suite covers the DB halves):
 *   - recordingFormat.metadata.spec  — metadata short-circuits detection
 *     (spy: classifier NEVER invoked when metadata exists)
 *   - recordingFormat.classifier.spec — one fixture per format + boundaries
 *   - recordingFormat.override.spec   — bad values rejected pre-DB (the DB
 *     flip itself is verify-clips-int)
 *   - routing.matrix.spec — table-driven matrix + precedence cases
 *   - actionDensity.lexicon.spec / actionDensityDiff.spec /
 *     actionDensity.degraded.spec
 *   - rubric.formatAware.spec — demo_payoff boost matrix + prompt lines
 *   - hookIntegrity.slideRef.spec — slide-citing hooks vs. the sync window
 *
 * Run: `npx tsx scripts/verify-clips.ts`
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import {
  BANNED_UI_PHRASES,
  CLIP_ACTION_CUES,
  CLIP_LAYOUTS,
  CLIP_LAYOUT_LABELS,
  CLIP_MOMENT_TYPES,
  CLIP_PLATFORMS,
  CLIP_PLATFORM_SPECS,
  CLIP_RUBRIC_DIMENSIONS,
  CLIP_RUBRIC_THRESHOLDS,
  CLIP_VISUAL_INTEREST_FORMAT_LINES,
  RECORDING_FORMATS,
  clipConfig,
} from "@/lib/marketing/clips/constants";
import { matchActionCues, scoreActionDensity } from "@/lib/marketing/clips/actionDensity";
import {
  CLIP_CAPTION_STYLE_SPECS,
  CLIP_HOOK_ANIMATIONS,
  CLIP_TEXT_FONTS,
  CLIP_TEXT_MOTION,
  CLIP_TEXT_PRESET_DEFAULTS,
  CLIP_TEXT_STYLES,
  CLIP_TEXT_STYLE_VERSION,
  captionAnchor,
  clipTextScale,
  hookAnchor,
  safeTextFrame,
} from "@/lib/marketing/clips/textStyles";
import {
  applyCaseRule,
  assColor,
  buildClipTextTrack,
  ClipTextTrackError,
  groupCaptionWords,
  type ClipTextTrackSpec,
} from "@/lib/marketing/clips/textTrack";
import { buildBurnArgs, burnPlatformFor, escapeFilterPath } from "@/lib/marketing/clips/render/burn";
import {
  classifyRecordingFormat,
  resolveRecordingFormat,
  type FrameSignal,
} from "@/lib/marketing/clips/format";
import {
  activeSlideAt,
  hasSlideWithinSpan,
  resolveClipLayout,
  slideSyncCoversSpan,
  slidesForSpan,
} from "@/lib/marketing/clips/routing";
import {
  hookCitesSlideVisual,
  lintClipTextSurfaces,
  lintHookNumbers,
  lintHookSlideRef,
  numericClaims,
} from "@/lib/marketing/clips/lint";
import { overrideTranscriptFormat } from "@/lib/marketing/clips/transcripts";
import {
  CLIP_MAP_SYSTEM_PROMPT,
  CLIP_PROMPT_VERSION,
  CLIP_SELECTION_SYSTEM_PROMPT,
  CLIP_VALIDATION_SYSTEM_PROMPT,
  buildSelectionInput,
  buildValidationInput,
} from "@/lib/marketing/clips/prompt";
import { renderExemplars, REJECTED_EXEMPLARS, STRONG_EXEMPLARS } from "@/lib/marketing/clips/fixtures/exemplars";
import {
  FIXTURE_LESSONS,
  fixtureByKey,
  wordsFromSegments,
} from "@/lib/marketing/clips/fixtures/lessons";
import {
  ClipGenerationError,
} from "@/lib/marketing/clips/errors";
import {
  MapShortlistSchema,
  ModelMomentBatchSchema,
  ModelMomentSchema,
  ValidationVerdictBatchSchema,
  hookWordCount,
  meetsRubricThreshold,
  rubricTotal,
  type ModelMoment,
  type RubricScores,
} from "@/lib/marketing/clips/schemas";
import { runSelectionCore } from "@/lib/marketing/clips/selection";
import {
  chunkTranscript,
  pickCurrentVideoRow,
  renderTranscriptForPrompt,
  snapToSentenceBounds,
  transcriptSlice,
  wordsFromVttCues,
} from "@/lib/marketing/clips/transcripts";
import {
  applyValidationVerdicts,
  overlapRatio,
  runDeterministicChecks,
} from "@/lib/marketing/clips/validate";
import { clipTools } from "@/lib/marketing/tools/clips";
import { ALL_MARKETING_TOOLS, MARKETING_GENERATE_TOOLS } from "@/lib/marketing/tools";
import { PLATFORMS as TEXT_PLATFORMS } from "@/lib/marketing/social/constants";
import { lintGeneratedPost } from "@/lib/marketing/social/lint";
import { deriveVoiceProfileDeterministic } from "@/lib/marketing/social/voice";
import { parseVtt } from "@/lib/video/captions";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VOICE = deriveVoiceProfileDeterministic({ courses: [], emailVoiceRules: [], samples: [] });

const FLAT = fixtureByKey("flat_affect");
const WORDS = wordsFromSegments(FLAT.segments);
const DURATION_MS = FLAT.durationMs;

/** camera_only + no sync + degraded diff — the format ctx that leaves every
 *  pre-amendment expectation untouched (no boost, slide-ref lint silent). */
const CAMERA_FMT = {
  recordingFormat: "camera_only" as const,
  slideSync: null,
  frameDiffRatio: null,
};

const GOOD_SCORES: RubricScores = {
  hook_potential: 4,
  standalone: 5,
  specificity: 4,
  curiosity_gap: 4,
  pedagogical_value: 5,
  visual_interest: 3,
  brand_safety: 5,
};

function moment(overrides: Partial<ModelMoment> & { rank: number }): ModelMoment {
  return {
    startMs: 20_000,
    endMs: 55_000,
    momentType: "definition_reframe",
    hookText: "Your index is a sorted copy",
    altHooks: ["What a database index really is", "Indexes are copies, not magic"],
    funnelStage: "tofu",
    targetPlatformFit: ["instagram", "tiktok"],
    rationale: "Reframes the core concept so every later rule is derivable.",
    rubricScores: GOOD_SCORES,
    captionDraft: "An index is a second sorted copy of your column.",
    endCardCta: "Follow for the full indexing series",
    segments: null,
    stitchedScript: null,
    ...overrides,
  } as ModelMoment;
}

const HAPPY_BATCH = {
  candidates: [
    moment({ rank: 1 }),
    moment({
      rank: 2,
      startMs: 55_000,
      endMs: 95_000,
      momentType: "misconception_buster",
      hookText: "Why the planner ignores your index",
      altHooks: ["The index you made is invisible", "Index the expression, not the column"],
      funnelStage: "tofu",
      captionDraft: "You indexed email. Your query filters lower(email). Different orderings.",
    }),
    moment({
      rank: 3,
      startMs: 130_000,
      endMs: 175_000,
      momentType: "counterintuitive_reveal",
      hookText: "An index can slow your app down",
      altHooks: ["Indexes are not free", "Faster reads, slower writes"],
      funnelStage: "mofu",
      captionDraft: "Every insert rewrites every sorted copy you keep.",
    }),
  ],
};

function allPassVerdicts(batch: { candidates: ModelMoment[] }) {
  return {
    verdicts: batch.candidates.map((c) => ({
      rank: c.rank,
      coherence: { pass: true, offendingPhrase: null, adjustedStartMs: null, adjustedEndMs: null },
      hooks: [c.hookText, ...c.altHooks].map((h) => ({ hook: h, supported: true, unsupportedClaim: null })),
    })),
  };
}

/* ────────────────────────────── sections ───────────────────────────────── */

function constantsChecks() {
  console.log("# constants (§8.2/§8.3/§8.5)");
  check("4 clip platforms", CLIP_PLATFORMS.length === 4);
  check("YouTube Shorts hard cap 60s", CLIP_PLATFORM_SPECS.youtube_shorts.hardCapMs === 60_000);
  check(
    "hook windows ≤3s everywhere",
    CLIP_PLATFORMS.every((p) => CLIP_PLATFORM_SPECS[p].hookWindowMs <= 3_000)
  );
  check(
    "hashtag ranges sane",
    CLIP_PLATFORMS.every(
      (p) => CLIP_PLATFORM_SPECS[p].hashtagMin <= CLIP_PLATFORM_SPECS[p].hashtagMax
    )
  );
  check("taxonomy has 8 moment types", CLIP_MOMENT_TYPES.length === 8);
  check(
    "no energy/excitement moment type (§8.2 closing rule)",
    !CLIP_MOMENT_TYPES.some((t) => /energy|excite|charisma/.test(t))
  );
  check("rubric has 7 dimensions", CLIP_RUBRIC_DIMENSIONS.length === 7);
  check(
    "rubric bar is 21/35 + hook 3 + standalone 4",
    CLIP_RUBRIC_THRESHOLDS.totalMin === 21 &&
      CLIP_RUBRIC_THRESHOLDS.hookPotentialMin === 3 &&
      CLIP_RUBRIC_THRESHOLDS.standaloneMin === 4
  );
  check("transcript budget default 24k", clipConfig().transcriptMaxTokens === 24_000);
}

function schemaChecks() {
  console.log("# Zod gates (§7.2)");
  check("valid moment parses", ModelMomentSchema.safeParse(moment({ rank: 1 })).success);
  check(
    "hook >10 words rejected",
    !ModelMomentSchema.safeParse(
      moment({ rank: 1, hookText: "one two three four five six seven eight nine ten eleven" })
    ).success
  );
  check(
    "exactly 2 altHooks required",
    !ModelMomentSchema.safeParse(moment({ rank: 1, altHooks: ["only one"] })).success
  );
  check(
    "endMs after startMs",
    !ModelMomentSchema.safeParse(moment({ rank: 1, startMs: 50_000, endMs: 40_000 })).success
  );
  check(
    "multi-segment requires ≥2 segments",
    !ModelMomentSchema.safeParse(
      moment({ rank: 1, segments: [{ startMs: 0, endMs: 25_000 }], stitchedScript: "x" })
    ).success
  );
  check(
    "multi-segment requires stitchedScript",
    !ModelMomentSchema.safeParse(
      moment({
        rank: 1,
        segments: [
          { startMs: 0, endMs: 15_000 },
          { startMs: 30_000, endMs: 45_000 },
        ],
        stitchedScript: null,
      })
    ).success
  );
  check(
    "contiguous span must have null stitchedScript (§7.3)",
    !ModelMomentSchema.safeParse(moment({ rank: 1, stitchedScript: "leftover" })).success
  );
  check(
    "batch capped at 5",
    !ModelMomentBatchSchema.safeParse({
      candidates: [1, 2, 3, 4, 5, 6].map((r) => moment({ rank: Math.min(r, 5) })),
    }).success
  );
  check("hookWordCount counts words", hookWordCount("  a  b   c ") === 3);
  check("rubricTotal sums 7 dims", rubricTotal(GOOD_SCORES) === 30);
  check("threshold: 30/35 with hook 4 standalone 5 passes", meetsRubricThreshold(GOOD_SCORES));
  check(
    "threshold: hook 2 fails even at high total",
    !meetsRubricThreshold({ ...GOOD_SCORES, hook_potential: 2, visual_interest: 5 })
  );
  check(
    "threshold: standalone 3 fails",
    !meetsRubricThreshold({ ...GOOD_SCORES, standalone: 3, visual_interest: 5 })
  );
  for (const [name, schema] of [
    ["moment batch", ModelMomentBatchSchema],
    ["validation verdicts", ValidationVerdictBatchSchema],
    ["map shortlist", MapShortlistSchema],
  ] as const) {
    let ok = true;
    try {
      toStrictJsonSchema(schema);
    } catch {
      ok = false;
    }
    check(`${name} converts to strict JSON schema`, ok);
  }
}

function transcriptChecks() {
  console.log("# transcripts (words · anchors · chunks)");
  const vtt = [
    "WEBVTT",
    "",
    "00:00.000 --> 00:04.000",
    "An index is a sorted copy",
    "",
    "00:04.000 --> 00:08.000",
    "An index is a sorted copy", // rolling-caption artifact
    "",
    "00:08.000 --> 00:12.500",
    "maintained on every write",
  ].join("\n");
  const words = wordsFromVttCues(parseVtt(vtt));
  check("VTT words: rolling-caption cue deduped", words.length === 6 + 4);
  check(
    "VTT words: monotonic non-overlapping",
    words.every((w, i) => i === 0 || w.startMs >= words[i - 1].startMs)
  );
  check(
    "VTT words: stay within their cue",
    words.slice(0, 6).every((w) => w.startMs >= 0 && w.endMs <= 4_000) &&
      words.slice(6).every((w) => w.startMs >= 8_000 && w.endMs <= 12_500)
  );
  const rendered = renderTranscriptForPrompt(WORDS);
  check("anchors carry ms (`[mm:ss · Nms]`)", /\[\d{2}:\d{2} · \d+ms\]/.test(rendered));
  const multi = renderTranscriptForPrompt(wordsFromSegments(fixtureByKey("multi_speaker").segments));
  check("speaker tags rendered for diarized words", /S1:/.test(multi) && /S2:/.test(multi));
  const chunks = chunkTranscript(WORDS, 200);
  check("chunking: >1 chunk under a small budget", chunks.length > 1);
  check(
    "chunking: disjoint ascending spans",
    chunks.every((c, i) => i === 0 || c.startMs >= chunks[i - 1].endMs)
  );
  const slice = transcriptSlice(WORDS, 55_000, 95_000);
  check("span slice contains its content", slice.includes("expression") && slice.includes("planner"));
  check("span slice excludes outside content", !slice.includes("covering"));

  console.log("# currentTake.spec (2026-07-16: newest captioned take wins — the re-record fix)");
  const take = (
    id: string,
    over: Partial<{ created_at: string; transcript_vtt: string | null; metadata: unknown }> = {}
  ) => ({
    id,
    created_at: "2026-07-01T00:00:00Z",
    transcript_vtt: null as string | null,
    metadata: {} as unknown,
    ...over,
  });
  const oldTake = take("old", { created_at: "2026-07-08T00:00:00Z", transcript_vtt: "WEBVTT" });
  const newTake = take("new", { created_at: "2026-07-15T00:00:00Z", transcript_vtt: "WEBVTT" });
  const dualTake = take("dual", { created_at: "2026-07-16T00:00:00Z", transcript_vtt: "WEBVTT", metadata: { role: "camera_dual_track" } });
  const uncaptioned = take("uncap", { created_at: "2026-07-16T00:00:00Z" });
  check(
    "newest CAPTIONED take wins (a re-record replaces the old take)",
    pickCurrentVideoRow([oldTake, newTake])?.id === "new"
  );
  check(
    "captioned beats newer-but-uncaptioned",
    pickCurrentVideoRow([oldTake, uncaptioned])?.id === "old"
  );
  check(
    "dual-track camera aux is never the lesson video (D-4)",
    pickCurrentVideoRow([oldTake, dualTake])?.id === "old" &&
      pickCurrentVideoRow([dualTake]) === null
  );
  check(
    "no captions anywhere → newest raw take; empty → null",
    pickCurrentVideoRow([take("a"), uncaptioned])?.id === "uncap" &&
      pickCurrentVideoRow([]) === null
  );

  console.log("# sentence snapping (the clips-v2 live-eval fix)");
  // A start 1.5s early drags in the previous sentence's tail — snaps forward.
  const early = snapToSentenceBounds(WORDS, 53_500, 95_000);
  check("early start snaps to the sentence boundary", early.startMs === 55_000);
  const earlySlice = transcriptSlice(WORDS, early.startMs, early.endMs);
  check("snapped span no longer starts mid-sentence", earlySlice.startsWith("The most common"));
  // An end cut mid-sentence extends forward to complete the thought.
  const midEnd = snapToSentenceBounds(WORDS, 20_000, 49_000);
  check("mid-sentence end extends to the sentence end (≤8s)", midEnd.endMs > 49_000 && midEnd.endMs <= 57_000);
  // Far from any snap point → unchanged.
  const noWords = snapToSentenceBounds([], 10_000, 40_000);
  check("empty words → span unchanged", noWords.startMs === 10_000 && noWords.endMs === 40_000);
}

function lintChecks() {
  console.log("# clip lints (§7.4.3-4)");
  check("numericClaims: extracts % $ and listicle numbers", numericClaims("90% of $500 in 3 signs").length === 3);
  check('numericClaims: ignores "one thing"', numericClaims("one thing about it").length === 0);
  check(
    "hook numbers: unsupported 90% flagged",
    lintHookNumbers("The mistake 90% of students make", "a lot of people get this wrong").length === 1
  );
  check(
    'hook numbers: "90 percent" in span supports "90%"',
    lintHookNumbers("90% of students miss this", "about 90 percent of students miss this").length === 0
  );
  check(
    "engagement bait flagged",
    lintClipTextSurfaces(
      { hookText: "Comment YES if you want this", captionDraft: null, endCardCta: null },
      ""
    ).some((v) => v.rule === "engagement_bait")
  );
  check(
    "comment-keyword CTA style is NOT bait",
    lintClipTextSurfaces(
      { hookText: "Steer blooms on purpose", captionDraft: null, endCardCta: "Comment LEARN and I'll send the guide" },
      ""
    ).length === 0
  );
  check(
    "shared §17.2 rules fire on captions (earnings claim)",
    lintClipTextSurfaces(
      { hookText: "ok", captionDraft: "My students made $5,000 per month with this", endCardCta: null },
      ""
    ).some((v) => v.rule === "earnings_claim" || v.rule === "student_result_claim")
  );
  check(
    "creator context whitelists its own claims",
    lintClipTextSurfaces(
      { hookText: "ok", captionDraft: "students earned $500 per month", endCardCta: null },
      "case study: students earned $500 per month in the cohort"
    ).length === 0
  );
  check(
    "social lint unchanged after refactor (no double all-caps)",
    lintGeneratedPost(
      { platform: "linkedin", body: "THIS IS ALL CAPS SHOUTING ABOUT NOTHING IN PARTICULAR AT ALL", cta: null, hashtags: [] },
      ""
    ).filter((v) => v.rule === "all_caps_ratio").length === 1
  );
}

function validateChecks() {
  console.log("# deterministic validation (§7.4.1)");
  const ctx = { durationMs: DURATION_MS, words: WORDS, sourceContext: "", format: CAMERA_FMT };

  const oob = runDeterministicChecks([moment({ rank: 1, startMs: 500_000, endMs: 540_000 })], ctx);
  check("out-of-media span dropped + repairable", oob.dropped[0]?.rule === "span_out_of_bounds" && oob.repairIssues.length === 1);

  const short = runDeterministicChecks([moment({ rank: 1, startMs: 20_000, endMs: 30_000 })], ctx);
  check("<20s span dropped", short.dropped[0]?.rule === "span_duration");

  const long = runDeterministicChecks(
    [moment({ rank: 1, startMs: 20_000, endMs: 115_000, targetPlatformFit: ["instagram"] })],
    ctx
  );
  check(">90s span dropped", long.dropped[0]?.rule === "span_duration");

  const ytPrune = runDeterministicChecks(
    [moment({ rank: 1, startMs: 20_000, endMs: 85_000, targetPlatformFit: ["instagram", "youtube_shorts"] })],
    ctx
  );
  check(
    "65s span prunes youtube_shorts (60s cap), keeps instagram",
    ytPrune.kept[0]?.targetPlatformFit.join(",") === "instagram"
  );

  const belowBar = runDeterministicChecks(
    [moment({ rank: 1, rubricScores: { ...GOOD_SCORES, standalone: 3 } })],
    ctx
  );
  check("below-bar rubric dropped", belowBar.dropped[0]?.rule === "rubric_below_threshold");
  check("rubric drop is NOT repairable (never re-score)", belowBar.repairIssues.length === 0);

  const overlap = runDeterministicChecks(
    [moment({ rank: 1 }), moment({ rank: 2, startMs: 25_000, endMs: 60_000 })],
    ctx
  );
  check("overlapping lower-ranked candidate dropped", overlap.kept.length === 1 && overlap.dropped[0]?.rule === "overlapping_span");
  check(
    "≤20% overlap is allowed",
    runDeterministicChecks(
      [moment({ rank: 1 }), moment({ rank: 2, startMs: 50_000, endMs: 90_000 })],
      ctx
    ).kept.length === 2
  );
  check(
    "overlapRatio uses the shorter span",
    overlapRatio(moment({ rank: 1, startMs: 0, endMs: 80_000 }), moment({ rank: 2, startMs: 0, endMs: 20_000 })) === 1
  );

  const hookNum = runDeterministicChecks(
    [
      moment({
        rank: 1,
        hookText: "The trick 97% of developers miss",
        altHooks: ["Your index is a sorted copy", "Indexes are copies"],
      }),
    ],
    ctx
  );
  check(
    "unsupported numeric hook pruned, supported alt promoted",
    hookNum.kept[0]?.hookText === "Your index is a sorted copy" && hookNum.kept[0]?.altHooks.length === 1
  );

  const allBadHooks = runDeterministicChecks(
    [
      moment({
        rank: 1,
        hookText: "The trick 97% miss",
        altHooks: ["Save $900 today", "Get 44x faster instantly"],
      }),
    ],
    ctx
  );
  check("all-unsupported hooks → dropped + repairable", allBadHooks.dropped[0]?.rule === "hook_number_unsupported" && allBadHooks.repairIssues.length === 1);

  const clamp = runDeterministicChecks(
    [
      moment({
        rank: 1,
        targetPlatformFit: ["youtube_shorts"],
        startMs: 20_000,
        endMs: 55_000,
        captionDraft: "x".repeat(150),
      }),
    ],
    ctx
  );
  check(
    "caption clamped to the tightest platform cap (YT title 100)",
    clamp.kept[0]?.captionClamped === true && (clamp.kept[0]?.captionDraft?.length ?? 0) <= 100
  );

  const unsafe = runDeterministicChecks(
    [moment({ rank: 1, captionDraft: "Only 3 spots left, enrollment closes tonight!" })],
    ctx
  );
  check("fake-scarcity caption dropped + repairable", unsafe.dropped.length === 1 && unsafe.repairIssues.length === 1);

  console.log("# verdict application (§7.4.2-3)");
  const kept = runDeterministicChecks([moment({ rank: 1 })], ctx).kept;
  const adjusted = applyValidationVerdicts(
    kept,
    [
      {
        rank: 1,
        coherence: { pass: false, offendingPhrase: "that picture", adjustedStartMs: 24_000, adjustedEndMs: 55_000 },
        hooks: [{ hook: kept[0].hookText, supported: true, unsupportedClaim: null }],
      },
    ],
    { durationMs: DURATION_MS, words: WORDS, format: CAMERA_FMT }
  );
  check("in-bound ±8s adjustment applied", adjusted.kept[0]?.startMs === 24_000);
  check("adjusted span re-sliced", adjusted.kept[0]?.spanTranscript.length > 0);

  const tooFar = applyValidationVerdicts(
    kept,
    [
      {
        rank: 1,
        coherence: { pass: false, offendingPhrase: "x", adjustedStartMs: 5_000, adjustedEndMs: 55_000 },
        hooks: [],
      },
    ],
    { durationMs: DURATION_MS, words: WORDS, format: CAMERA_FMT }
  );
  check("adjustment beyond ±8s → dropped", tooFar.kept.length === 0 && tooFar.dropped[0]?.rule === "standalone_coherence");

  const multiSeg = runDeterministicChecks(
    [
      moment({
        rank: 1,
        startMs: 20_000,
        endMs: 95_000,
        segments: [
          { startMs: 20_000, endMs: 40_000 },
          { startMs: 75_000, endMs: 95_000 },
        ],
        stitchedScript: "An index is a sorted copy. The fix is one line: index the expression itself.",
      }),
    ],
    ctx
  );
  check("multi-segment candidate normalizes + survives deterministic checks", multiSeg.kept.length === 1);
  const multiDrop = applyValidationVerdicts(
    multiSeg.kept,
    [
      {
        rank: 1,
        coherence: { pass: false, offendingPhrase: "dangling ref", adjustedStartMs: 22_000, adjustedEndMs: 95_000 },
        hooks: [],
      },
    ],
    { durationMs: DURATION_MS, words: WORDS, format: CAMERA_FMT }
  );
  check(
    "incoherent multi-segment NEVER adjusted — dropped (§7.3/§17.3)",
    multiDrop.kept.length === 0 && multiDrop.dropped[0]?.rule === "standalone_coherence"
  );

  const hookSwap = applyValidationVerdicts(
    kept,
    [
      {
        rank: 1,
        coherence: { pass: true, offendingPhrase: null, adjustedStartMs: null, adjustedEndMs: null },
        hooks: [
          { hook: kept[0].hookText, supported: false, unsupportedClaim: "sorted copy claim" },
          { hook: kept[0].altHooks[0], supported: true, unsupportedClaim: null },
          { hook: kept[0].altHooks[1], supported: true, unsupportedClaim: null },
        ],
      },
    ],
    { durationMs: DURATION_MS, words: WORDS, format: CAMERA_FMT }
  );
  check("unsupported hook → first supported alt promoted", hookSwap.kept[0]?.hookText === kept[0].altHooks[0]);

  const allHooksFail = applyValidationVerdicts(
    kept,
    [
      {
        rank: 1,
        coherence: { pass: true, offendingPhrase: null, adjustedStartMs: null, adjustedEndMs: null },
        hooks: [kept[0].hookText, ...kept[0].altHooks].map((h) => ({
          hook: h,
          supported: false,
          unsupportedClaim: "overpromise",
        })),
      },
    ],
    { durationMs: DURATION_MS, words: WORDS, format: CAMERA_FMT }
  );
  check("all hooks unsupported → candidate dropped (§7.4.3)", allHooksFail.dropped[0]?.rule === "hook_integrity");

  const noVerdict = applyValidationVerdicts(kept, [], { durationMs: DURATION_MS, words: WORDS, format: CAMERA_FMT });
  check("candidate without a verdict is kept", noVerdict.kept.length === 1);
}

async function pipelineChecks() {
  console.log("# pipeline core vs. the mock model");
  const cfg = clipConfig();
  const baseArgs = {
    voice: VOICE,
    contextText: FLAT.courseContext,
    sourceContext: FLAT.courseContext,
    words: WORDS,
    durationMs: DURATION_MS,
    request: {
      stages: "balanced" as const,
      targetPlatforms: [...CLIP_PLATFORMS],
      count: 5,
      recordingFormat: FLAT.recordingFormat,
    },
    recordingFormat: FLAT.recordingFormat,
    slideSync: FLAT.slideSync,
    frameDiffRatio: null,
  };

  // happy path
  {
    const mock = createMockModelClient([], {
      structured: {
        clip_moment_batch: HAPPY_BATCH,
        clip_validation: allPassVerdicts(HAPPY_BATCH),
      },
    });
    const result = await runSelectionCore(mock, cfg, baseArgs);
    check("happy: 3 kept, 0 dropped, no repair", result.kept.length === 3 && result.dropped.length === 0 && !result.repairUsed);
    check("happy: no map/reduce for an in-budget transcript", !result.mapReduceUsed);
    check(
      "happy: every kept candidate carries a resolved layout (FR-2 core plumbing)",
      result.kept.every((c) => (CLIP_LAYOUTS as readonly string[]).includes(c.layout))
    );
    check(
      "happy: screen_only + no sync routes to screen_action_zoom/audiogram only",
      result.kept.every((c) => c.layout === "screen_action_zoom" || c.layout === "audiogram")
    );
    const calls = mock.getCalls();
    check("happy: exactly 2 model calls (1 select + 1 validate — §7.5)", calls.length === 2);
    check(
      "tiers: select medium, validate low",
      calls[0].effort === "medium" && calls[1].effort === "low"
    );
    check(
      "formats: clip_moment_batch then clip_validation",
      calls[0].responseFormat?.name === "clip_moment_batch" && calls[1].responseFormat?.name === "clip_validation"
    );
  }

  // repair on invalid JSON
  {
    const mock = createMockModelClient([], {
      structured: {
        clip_moment_batch: "this is not json",
        clip_moment_batch_repair: HAPPY_BATCH,
        clip_validation: allPassVerdicts(HAPPY_BATCH),
      },
    });
    const result = await runSelectionCore(mock, cfg, baseArgs);
    check("repair on invalid JSON: batch recovered", result.repairUsed && result.kept.length === 3);
  }

  // repair claimed by deterministic flags
  {
    const flagged = {
      candidates: [
        HAPPY_BATCH.candidates[0],
        moment({ rank: 2, startMs: 900_000, endMs: 950_000 }), // out of media
      ],
    };
    const mock = createMockModelClient([], {
      structured: {
        clip_moment_batch: flagged,
        clip_moment_batch_repair: HAPPY_BATCH,
        clip_validation: allPassVerdicts(HAPPY_BATCH),
      },
    });
    const result = await runSelectionCore(mock, cfg, baseArgs);
    check("repair on deterministic flags: repaired batch used", result.repairUsed && result.kept.length === 3);
  }

  // rubric-only failure never wastes the repair call
  {
    const withWeak = {
      candidates: [
        HAPPY_BATCH.candidates[0],
        moment({ rank: 2, startMs: 130_000, endMs: 175_000, rubricScores: { ...GOOD_SCORES, standalone: 2 } }),
      ],
    };
    const verdicts = allPassVerdicts({ candidates: [withWeak.candidates[0]] });
    const mock = createMockModelClient([], {
      structured: { clip_moment_batch: withWeak, clip_validation: verdicts },
    });
    const result = await runSelectionCore(mock, cfg, baseArgs);
    check(
      "rubric drop alone: no repair call, weak candidate dropped, strong kept",
      !result.repairUsed && result.kept.length === 1 && result.dropped[0]?.rule === "rubric_below_threshold"
    );
    check("rubric drop alone: still exactly 2 model calls", mock.getCalls().length === 2);
  }

  // unreadable validation verdict fails CLOSED
  {
    const mock = createMockModelClient([], {
      structured: { clip_moment_batch: HAPPY_BATCH, clip_validation: "garbage" },
    });
    let threw: unknown = null;
    try {
      await runSelectionCore(mock, cfg, baseArgs);
    } catch (err) {
      threw = err;
    }
    check(
      "unreadable verdict → ClipGenerationError(validation), fail-closed",
      threw instanceof ClipGenerationError && threw.stage === "validation"
    );
  }

  // map→reduce for an over-budget transcript
  {
    const tinyCfg = { ...cfg, transcriptMaxTokens: 300 };
    const mock = createMockModelClient([], {
      structured: {
        clip_moment_map: {
          moments: [
            { startMs: 20_000, endMs: 55_000, momentType: "definition_reframe", why: "sorted copy reframe" },
            { startMs: 130_000, endMs: 175_000, momentType: "counterintuitive_reveal", why: "indexes slow writes" },
          ],
        },
        clip_moment_batch: HAPPY_BATCH,
        clip_validation: allPassVerdicts(HAPPY_BATCH),
      },
    });
    const result = await runSelectionCore(mock, tinyCfg, baseArgs);
    check("map→reduce engaged for over-budget transcript", result.mapReduceUsed && result.kept.length === 3);
    const formats = mock.getCalls().map((c) => c.responseFormat?.name);
    check(
      "map calls run before the reduce (sequential, small tier)",
      formats.filter((f) => f === "clip_moment_map").length >= 2 &&
        formats.indexOf("clip_moment_batch") > formats.lastIndexOf("clip_moment_map")
    );
    const mapCall = mock.getCalls().find((c) => c.responseFormat?.name === "clip_moment_map");
    check("map tier effort low", mapCall?.effort === "low");
  }
}

function promptChecks() {
  console.log("# prompt (§8 — versioned artifact)");
  check("version pinned", CLIP_PROMPT_VERSION === "clips-v3");
  check(
    "static prefix carries the taxonomy",
    CLIP_MOMENT_TYPES.every((t) => CLIP_SELECTION_SYSTEM_PROMPT.includes(t))
  );
  check(
    "static prefix carries every pacing row",
    CLIP_PLATFORMS.every((p) => CLIP_SELECTION_SYSTEM_PROMPT.includes(CLIP_PLATFORM_SPECS[p].label))
  );
  check(
    "static prefix carries the negative constraints",
    CLIP_SELECTION_SYSTEM_PROMPT.includes("Never write a hook the span doesn't cash") &&
      CLIP_SELECTION_SYSTEM_PROMPT.includes("loud/animated")
  );
  check(
    "static prefix bans implying auto-posting",
    CLIP_SELECTION_SYSTEM_PROMPT.includes("MANUALLY")
  );
  check("6 exemplars: 3 strong + 3 rejected", STRONG_EXEMPLARS.length === 3 && REJECTED_EXEMPLARS.length === 3);
  check(
    "rejected exemplars cover the 3 canonical failure modes",
    ["incoherent span", "charisma-over-content", "hook overclaim"].every((r) =>
      REJECTED_EXEMPLARS.some((e) => e.reason.includes(r))
    )
  );
  check("exemplars render into the prefix", CLIP_SELECTION_SYSTEM_PROMPT.includes(renderExemplars().slice(0, 60)));
  check("exemplar rendering is byte-stable", renderExemplars() === renderExemplars());
  const input1 = buildSelectionInput({
    voice: VOICE,
    courseContext: "CTX",
    transcript: "T",
    request: { stages: "balanced", targetPlatforms: ["tiktok"], count: 3, recordingFormat: "screen_only" },
  });
  check(
    "selection input: voice → context → transcript → request order",
    input1.indexOf("VOICE PROFILE") < input1.indexOf("COURSE CONTEXT") &&
      input1.indexOf("COURSE CONTEXT") < input1.indexOf("LESSON TRANSCRIPT") &&
      input1.indexOf("LESSON TRANSCRIPT") < input1.indexOf("REQUEST:")
  );
  check(
    "request block names the lesson's recording format (FR-4 variable half)",
    input1.includes("recording format: screen_only")
  );
  check("validation system prompt carries the 8000ms bound", CLIP_VALIDATION_SYSTEM_PROMPT.includes("8000ms"));
  check("map prompt allows an empty shortlist", CLIP_MAP_SYSTEM_PROMPT.includes("empty list is a valid answer"));
  const vInput = buildValidationInput([
    { rank: 1, spanTranscript: "abc", stitchedScript: null, hooks: ["h1", "h2"] },
  ]);
  check("validation input carries span + hooks", vInput.includes('"abc"') && vInput.includes('"h1"'));
}

function fixtureChecks() {
  console.log("# eval fixtures (§16/§20 + FR-8)");
  check("5 fixtures (3 original + FR-8's screen_slides + screen_action)", FIXTURE_LESSONS.length === 5);
  check(
    "fixture keys: charismatic, flat_affect, multi_speaker, screen_slides, screen_action",
    ["charismatic", "flat_affect", "multi_speaker", "screen_slides", "screen_action"].every((k) =>
      FIXTURE_LESSONS.some((f) => f.key === k)
    )
  );
  check(
    "every fixture declares a recording format + expected layouts",
    FIXTURE_LESSONS.every(
      (f) =>
        (RECORDING_FORMATS as readonly string[]).includes(f.recordingFormat) &&
        f.expectedLayouts.length > 0 &&
        f.expectedLayouts.every((l) => (CLIP_LAYOUTS as readonly string[]).includes(l))
    )
  );
  for (const f of FIXTURE_LESSONS) {
    check(
      `${f.key}: gold spans in-bounds and 20-90s`,
      f.goldMoments.every(
        (g) => g.startMs >= 0 && g.endMs <= f.durationMs && g.endMs - g.startMs >= 20_000 && g.endMs - g.startMs <= 90_000
      )
    );
    const words = wordsFromSegments(f.segments);
    check(
      `${f.key}: word timings monotonic and in-bounds`,
      words.every((w, i) => (i === 0 || w.startMs >= words[i - 1].startMs) && w.endMs <= f.durationMs)
    );
  }
  check("flat-affect fixture annotates ≥2 gold (the differentiator)", fixtureByKey("flat_affect").goldMoments.length >= 2);
  check(
    "multi-speaker fixture is diarized",
    new Set(wordsFromSegments(fixtureByKey("multi_speaker").segments).map((w) => w.speaker)).size === 2
  );
  check(
    "charismatic fixture carries an energy trap outside gold spans",
    fixtureByKey("charismatic").segments.some(
      (s) =>
        /okay okay/i.test(s.text) &&
        !fixtureByKey("charismatic").goldMoments.some((g) => g.startMs === s.atMs)
    )
  );

  // FR-8: the two screen-only fixtures' routing preconditions hold by data.
  const slides = fixtureByKey("screen_slides");
  check(
    "screen_slides: slide-sync covers every gold span (⇒ slide_short routes)",
    slides.goldMoments.every((g) => slideSyncCoversSpan(slides.slideSync, g))
  );
  check(
    "screen_slides: flat-affect register (no exclamations in the voiceover)",
    slides.segments.every((s) => !s.text.includes("!"))
  );
  check("screen_slides: ≥2 gold moments (the binding FR-8 floor)", slides.goldMoments.length >= 2);
  const action = fixtureByKey("screen_action");
  const actionWords = wordsFromSegments(action.segments);
  check(
    "screen_action: every gold span is action-dense by the LEXICON alone (degraded mode)",
    action.goldMoments.every(
      (g) => scoreActionDensity(actionWords, g, { frameDiffRatio: null }).dense
    )
  );
  check("screen_action: no slide-sync (zoom, not slide_short)", action.slideSync === null);
}

function registryChecks() {
  console.log("# tool registry (§13; M-B adds the render trio; H-3 the hook re-burn)");
  check("exactly 8 clip tools (M-A's 3 + M-B's render trio + M-D's kit + H-3's re-burn)", clipTools.length === 8);
  check(
    "2 read + 6 reversible, ZERO irreversible (the reversible-only carryover)",
    clipTools.filter((t) => t.reversibility === "read").length === 2 &&
      clipTools.filter((t) => t.reversibility === "reversible").length === 6 &&
      clipTools.filter((t) => t.reversibility === "irreversible").length === 0
  );
  check(
    "tools registered in ALL_MARKETING_TOOLS",
    clipTools.every((t) => ALL_MARKETING_TOOLS.some((x) => x.name === t.name))
  );
  check(
    "generate-phase set includes the clip tools",
    [
      "select_clip_moments",
      "list_clip_moment_candidates",
      "update_clip_moment_status",
      "generate_lesson_clips",
      "cancel_clip_job",
      "list_clip_jobs",
      "generate_posting_kit",
      "update_clip_hook",
    ].every((n) => MARKETING_GENERATE_TOOLS.has(n))
  );
  check(
    "render tool summaries are honest about queued ≠ rendered + manual posting",
    /QUEUED IS NOT RENDERED/.test(
      clipTools.find((t) => t.name === "generate_lesson_clips")?.description ?? ""
    ) && /manually/.test(clipTools.find((t) => t.name === "generate_lesson_clips")?.description ?? "")
  );
  const select = clipTools.find((t) => t.name === "select_clip_moments");
  check("select_clip_moments targets the clip_moment_set entity", select?.existingTarget?.({} as never, {} as never) === null);

  // H-3: update_clip_hook — reversible, versioned, honest about being free.
  const hookTool = clipTools.find((t) => t.name === "update_clip_hook");
  const hookTarget = hookTool?.existingTarget?.({ postId: "p1" } as never, {} as never) as {
    entity?: string;
  } | null;
  check(
    "update_clip_hook is reversible and targets the social_post entity",
    hookTool?.reversibility === "reversible" && hookTarget?.entity === "social_post"
  );
  check(
    "update_clip_hook description teaches: local re-burn, no minutes, version conflict → re-read",
    /no provider job/i.test(hookTool?.description ?? "") &&
      /no render minutes/i.test(hookTool?.description ?? "") &&
      /re-read/i.test(hookTool?.description ?? "")
  );
  check(
    "update_clip_hook Zod hard-fails an 11-word hook (the H-1 bound)",
    hookTool?.params.safeParse({
      postId: "0e2e6f9e-7a72-4be1-9f10-6a70b58c2f01",
      expectedVersion: 1,
      hookText: "one two three four five six seven eight nine ten eleven",
      animation: null,
      holdSeconds: null,
      captionsEnabled: null,
      captionStyle: null,
    }).success === false
  );
}

function driftAndGrepChecks() {
  console.log("# drift guards + hardening greps (§17.12)");
  const migration = readFileSync(
    join(ROOT, "supabase", "migrations", "20260707100000_lesson_clips.sql"),
    "utf8"
  );
  const CLIP_EVENTS = [
    "lesson_transcribed",
    "clip_moments_generated",
    "clip_moments_generation_failed",
    "clip_moment_selected",
    "clip_moment_dismissed",
  ];
  check(
    "every TS clip event type is in the migration check constraint",
    CLIP_EVENTS.every((e) => migration.includes(`'${e}'`))
  );
  const typesSrc = readFileSync(join(ROOT, "lib", "marketing", "types.ts"), "utf8");
  check(
    "every clip event type is in the AnalyticsEventType union",
    CLIP_EVENTS.every((e) => typesSrc.includes(`"${e}"`))
  );
  const burnMigration = readFileSync(
    join(ROOT, "supabase", "migrations", "20260716120000_clip_text_burn.sql"),
    "utf8"
  );
  check(
    "clip_hook_reburned in the burn migration's check constraint AND the TS union (drift guard)",
    burnMigration.includes("'clip_hook_reburned'") && typesSrc.includes('"clip_hook_reburned"')
  );
  check(
    "the burn migration adds social_post.clean_video_path (H-2's second artifact)",
    burnMigration.includes("add column clean_video_path text")
  );

  const clipDir = join(ROOT, "lib", "marketing", "clips");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".ts")) files.push(join(dir, entry.name));
    }
  };
  walk(clipDir);
  files.push(join(ROOT, "lib", "marketing", "tools", "clips.ts"));
  files.push(join(ROOT, "app", "api", "marketing", "lessons", "[lessonId]", "clip-moments", "route.ts"));
  const allSrc = files.map((f) => ({ f, src: readFileSync(f, "utf8") }));

  check(
    "no publish/schedule endpoint references anywhere in clips code (§3/§9.2)",
    allSrc.every(({ src }) => !/publish-clip|schedule-clips|publish_clip|schedule_clips/i.test(src))
  );
  check(
    "no scheduler primitives in clips code (no-cron stance, §11.3)",
    allSrc.every(({ src }) => !/setInterval\(|node-cron|new CronJob/.test(src))
  );
  check(
    "no banned publish-language in clips source strings",
    allSrc.every(({ src }) => BANNED_UI_PHRASES.every((p) => !src.toLowerCase().includes(p)))
  );
  check(
    "no social platform hosts in clips code",
    allSrc.every(({ src }) => !/instagram\.com|tiktok\.com|youtube\.com|facebook\.com/.test(src))
  );
  check("text-post platform enum still closed at 2 (Phase 1 fence)", TEXT_PLATFORMS.length === 2);
}

/* ═══════════════════ amendment sections (named specs) ══════════════════ */

function frames(n: number, face: number, screen: number): FrameSignal[] {
  // First `face` frames carry a face, first `screen` frames carry screen
  // content — counts are what the classifier reads, order is irrelevant.
  return Array.from({ length: n }, (_, i) => ({
    facePresent: i < face,
    screenContentPresent: i < screen,
  }));
}

async function recordingFormatSpecs() {
  console.log("# recordingFormat.metadata.spec (FR-1: metadata short-circuits detection)");
  let inspectorCalls = 0;
  const spyInspector = {
    async sampleFrames(count: number): Promise<FrameSignal[]> {
      inspectorCalls++;
      return frames(count, count, 0);
    },
  };
  for (const f of RECORDING_FORMATS) {
    const r = await resolveRecordingFormat({ metadataMode: f, frameInspector: spyInspector });
    check(`metadata "${f}" → ${f} from 'platform'`, r.format === f && r.source === "platform");
  }
  check("classifier NEVER invoked when metadata exists (spy assertion)", inspectorCalls === 0);
  const junk = await resolveRecordingFormat({ metadataMode: "webcam", frameInspector: spyInspector });
  check(
    "unknown metadata value falls through to the classifier",
    junk.source === "classifier" && inspectorCalls === 1
  );

  console.log("# recordingFormat.classifier.spec (FR-1: one fixture per format + boundaries)");
  check(
    "camera fixture: face in 8/8, no screen → camera_only",
    classifyRecordingFormat(frames(8, 8, 0)) === "camera_only"
  );
  check(
    "screen+camera fixture: face in 8/8, screen in 8/8 → screen_camera",
    classifyRecordingFormat(frames(8, 8, 8)) === "screen_camera"
  );
  check(
    "screen fixture: no face, screen in 8/8 → screen_only",
    classifyRecordingFormat(frames(8, 0, 8)) === "screen_only"
  );
  check(
    "face at exactly 60% (5/10 below → screen_only; 6/10 = 60% → camera_only)",
    classifyRecordingFormat(frames(10, 5, 0)) === "screen_only" &&
      classifyRecordingFormat(frames(10, 6, 0)) === "camera_only"
  );
  check(
    "face 6/8 + screen 4/8 (50% frame-dominant bar) → screen_camera",
    classifyRecordingFormat(frames(8, 6, 4)) === "screen_camera"
  );
  check(
    "face 6/8 + screen 3/8 (<50%) → camera_only",
    classifyRecordingFormat(frames(8, 6, 3)) === "camera_only"
  );
  check("zero frames → null (no fabricated verdict)", classifyRecordingFormat([]) === null);
  const degraded = await resolveRecordingFormat({ metadataMode: null, frameInspector: null });
  check(
    "no metadata + no inspector → degraded default camera_only/'classifier'",
    degraded.format === "camera_only" && degraded.source === "classifier"
  );
  const broken = await resolveRecordingFormat({
    metadataMode: null,
    frameInspector: {
      async sampleFrames() {
        throw new Error("frame source down");
      },
    },
  });
  check(
    "inspector failure degrades, never throws (transcript acquisition survives)",
    broken.format === "camera_only" && broken.source === "classifier"
  );
  const classified = await resolveRecordingFormat({
    metadataMode: null,
    frameInspector: { async sampleFrames(count) { return frames(count, 0, count); } },
  });
  check(
    "classifier evidence recorded (frames + facePct + screenPct)",
    classified.classifierEvidence?.frames === 8 &&
      classified.classifierEvidence.facePct === 0 &&
      classified.classifierEvidence.screenPct === 1
  );

  console.log("# recordingFormat.override.spec (FR-1: creator override — DB flip in the int suite)");
  let overrideThrew = false;
  try {
    // An invalid format must throw BEFORE any DB access — the stub explodes
    // if reached, so a pass proves the Zod gate sits in front.
    const explodingDb = new Proxy({}, { get() { throw new Error("DB touched before validation"); } });
    await overrideTranscriptFormat(explodingDb as never, "lesson-id", "portrait" as never);
  } catch (err) {
    overrideThrew = err instanceof Error && !err.message.includes("DB touched");
  }
  check("override rejects an invalid format before touching the DB", overrideThrew);
}

function routingMatrixSpecs() {
  console.log("# routing.matrix.spec (FR-2: the binding matrix, table-driven)");
  const CASES: {
    name: string;
    format: (typeof RECORDING_FORMATS)[number];
    ctx: { slideSyncCoversSpan: boolean; actionDense: boolean };
    expect: (typeof CLIP_LAYOUTS)[number];
  }[] = [
    { name: "camera_only always → face_track", format: "camera_only", ctx: { slideSyncCoversSpan: false, actionDense: false }, expect: "face_track" },
    { name: "camera_only ignores sync/action facts", format: "camera_only", ctx: { slideSyncCoversSpan: true, actionDense: true }, expect: "face_track" },
    { name: "screen_camera always → stacked_split", format: "screen_camera", ctx: { slideSyncCoversSpan: false, actionDense: false }, expect: "stacked_split" },
    { name: "screen_camera ignores sync/action facts", format: "screen_camera", ctx: { slideSyncCoversSpan: true, actionDense: true }, expect: "stacked_split" },
    { name: "screen_only + sync coverage → slide_short", format: "screen_only", ctx: { slideSyncCoversSpan: true, actionDense: false }, expect: "slide_short" },
    { name: "screen_only + action-dense (no sync) → screen_action_zoom", format: "screen_only", ctx: { slideSyncCoversSpan: false, actionDense: true }, expect: "screen_action_zoom" },
    { name: "screen_only + neither → audiogram", format: "screen_only", ctx: { slideSyncCoversSpan: false, actionDense: false }, expect: "audiogram" },
  ];
  for (const c of CASES) check(c.name, resolveClipLayout(c.format, c.ctx) === c.expect);

  // The directive's named precedence cases:
  check(
    "test_slide_short_beats_action_zoom_when_both_eligible",
    resolveClipLayout("screen_only", { slideSyncCoversSpan: true, actionDense: true }) === "slide_short"
  );
  check(
    "test_audiogram_only_when_nothing_else_applies",
    (["camera_only", "screen_camera"] as const).every(
      (f) => resolveClipLayout(f, { slideSyncCoversSpan: false, actionDense: false }) !== "audiogram"
    ) &&
      resolveClipLayout("screen_only", { slideSyncCoversSpan: true, actionDense: false }) !== "audiogram" &&
      resolveClipLayout("screen_only", { slideSyncCoversSpan: false, actionDense: true }) !== "audiogram"
  );
  // test_layout_persisted_on_candidate_and_job: the candidate half is the
  // int suite's DB round-trip; clip_render_jobs does not exist until M-B
  // (its layout column folds into that CREATE — surfaced at the checkpoint).

  console.log("# routing.matrix.spec — slide-sync fact helpers");
  const sync = [
    { slideId: "s1", atMs: 0 },
    { slideId: "s2", atMs: 30_000 },
    { slideId: "s3", atMs: 60_000 },
  ];
  check("activeSlideAt: last entry ≤ t", activeSlideAt(sync, 45_000)?.slideId === "s2");
  check("activeSlideAt: before first entry → null", activeSlideAt(sync.slice(1), 10_000) === null);
  check(
    "coverage: slide active at span start",
    slideSyncCoversSpan(sync, { startMs: 40_000, endMs: 70_000 }) === true
  );
  check(
    "coverage: span starting before the first slide is NOT covered",
    slideSyncCoversSpan(sync.slice(1), { startMs: 10_000, endMs: 50_000 }) === false
  );
  check("coverage: null/empty sync never covers", !slideSyncCoversSpan(null, { startMs: 0, endMs: 10 }) && !slideSyncCoversSpan([], { startMs: 0, endMs: 10 }));
  const clipped = slidesForSpan(sync, { startMs: 45_000, endMs: 75_000 });
  check(
    "slidesForSpan: ordered refs clipped to the span (FR-6's input shape)",
    clipped.length === 2 &&
      clipped[0].slideId === "s2" &&
      clipped[0].atMs === 45_000 &&
      clipped[0].endMs === 60_000 &&
      clipped[1].slideId === "s3" &&
      clipped[1].endMs === 75_000
  );
  check("hasSlideWithinSpan matches the clip window", hasSlideWithinSpan(sync, { startMs: 45_000, endMs: 75_000 }));
  check(
    "layout label copy defined for every layout (FR-9 imports, never copies)",
    CLIP_LAYOUTS.every((l) => CLIP_LAYOUT_LABELS[l]?.length > 0)
  );
}

function actionDensitySpecs() {
  console.log("# actionDensity.lexicon.spec (FR-3: table-driven cue matrix)");
  const CUE_TABLE: { text: string; hits: boolean; why: string }[] = [
    { text: "Watch what happens when I hit enter", hits: true, why: "two cues" },
    { text: "Let me show you the formula", hits: true, why: "let me show you" },
    { text: "as I type the lookup", hits: true, why: "as i type" },
    { text: "you can see the whole column fill", hits: true, why: "you can see" },
    { text: "Now I click the filter", hits: true, why: "now i click" },
    { text: "notice how the plan changes", hits: true, why: "notice how" },
    { text: "An index is a sorted copy of the column", hits: false, why: "pure lecture prose" },
    { text: "The exam covers chapters one through five", hits: false, why: "admin talk" },
    { text: "I was typing an email yesterday", hits: false, why: "'i was typing' is not a demo cue" },
  ];
  for (const row of CUE_TABLE) {
    check(
      `lexicon: "${row.text.slice(0, 44)}…" ${row.hits ? "matches" : "does not match"} (${row.why})`,
      (matchActionCues(row.text).length > 0) === row.hits
    );
  }
  check("every lexicon entry compiles as a word-bounded regex", CLIP_ACTION_CUES.every((c) => new RegExp(`\\b(?:${c})\\b`, "iu") instanceof RegExp));
  const demoWords = wordsFromSegments([
    { atMs: 0, endMs: 45_000, text: "Let me show you. Watch what happens when I hit enter. You can see the column fill." },
  ]);
  const dense = scoreActionDensity(demoWords, { startMs: 0, endMs: 45_000 }, { frameDiffRatio: null });
  check("dense demo narration clears the 2 cues/min bar", dense.dense && dense.cuesPerMinute >= 2);
  const lectureWords = wordsFromSegments([
    { atMs: 0, endMs: 45_000, text: "An index is a second sorted copy of the column, maintained on every write, forever." },
  ]);
  const sparse = scoreActionDensity(lectureWords, { startMs: 0, endMs: 45_000 }, { frameDiffRatio: null });
  check("lecture prose scores 0 cues/min (not dense)", !sparse.dense && sparse.cueHits.length === 0);

  console.log("# actionDensityDiff.spec (FR-3: synthetic frame-diff fixtures)");
  const staticSlide = scoreActionDensity(lectureWords, { startMs: 0, endMs: 45_000 }, { frameDiffRatio: 0.02 });
  check("static-slide clip scores low (diff 0.02 < 0.15) → not dense", !staticSlide.dense);
  const activeTyping = scoreActionDensity(lectureWords, { startMs: 0, endMs: 45_000 }, { frameDiffRatio: 0.4 });
  check("active-typing screencast scores high (diff 0.4) → dense despite cue-free narration", activeTyping.dense);
  check("frame-diff signal recorded on the verdict", activeTyping.frameDiffRatio === 0.4);

  console.log("# actionDensity.degraded.spec (FR-3: cues alone decide without frame sampling)");
  const degradedDense = scoreActionDensity(demoWords, { startMs: 0, endMs: 45_000 }, {});
  check("degraded (no frameDiffRatio): cue-dense span still dense", degradedDense.dense && degradedDense.frameDiffRatio === null);
  const degradedSparse = scoreActionDensity(lectureWords, { startMs: 0, endMs: 45_000 }, { frameDiffRatio: null });
  check("degraded: cue-sparse span not dense (no phantom frame signal)", !degradedSparse.dense);
  check("empty span text → 0 cues, not NaN/throw", scoreActionDensity([], { startMs: 0, endMs: 30_000 }).cuesPerMinute === 0);
}

function rubricFormatAwareSpecs() {
  console.log("# rubric.formatAware.spec (FR-4: per-format scoring + the demo_payoff boost)");
  check(
    "static prefix carries every format's visual_interest rule (byte-stable half)",
    RECORDING_FORMATS.every((f) => CLIP_SELECTION_SYSTEM_PROMPT.includes(CLIP_VISUAL_INTEREST_FORMAT_LINES[f]))
  );
  check(
    "screen_only rule scores the SCREEN, not speaker presence",
    CLIP_VISUAL_INTEREST_FORMAT_LINES.screen_only.includes("NOT speaker presence")
  );
  check(
    'slide-explanatory-power hook basis stated ("this one diagram explains X")',
    CLIP_SELECTION_SYSTEM_PROMPT.includes("this one diagram explains X")
  );

  // Boost matrix: the SAME candidate (demo_payoff, visual_interest 2 → total
  // 20, below the 21 bar) on an action-dense span survives ONLY under
  // screen_only — the boost lifts it to 21.
  const demoWords = wordsFromSegments([
    {
      atMs: 20_000,
      endMs: 55_000,
      text: "Let me show you the formula. Watch what happens when I hit enter — you can see the whole column fill in one second. That column used to be an hour of copy-paste every Monday, and now it updates itself whenever the master data changes.",
    },
  ]);
  const boostBase = {
    durationMs: 60_000,
    words: demoWords,
    sourceContext: "",
  };
  const demoMoment = moment({
    rank: 1,
    startMs: 20_000,
    endMs: 55_000,
    momentType: "demo_payoff",
    hookText: "One formula replaces an hour",
    altHooks: ["Watch the column fill itself", "Stop copy-pasting lookups"],
    captionDraft: null,
    // 3+4+3+2+3+2+3 = 20 — one point under the 21 bar, hook/standalone mins met.
    rubricScores: {
      hook_potential: 3,
      standalone: 4,
      specificity: 3,
      curiosity_gap: 2,
      pedagogical_value: 3,
      visual_interest: 2,
      brand_safety: 3,
    },
  });
  const boosted = runDeterministicChecks([demoMoment], {
    ...boostBase,
    format: { recordingFormat: "screen_only", slideSync: null, frameDiffRatio: null },
  });
  check(
    "screen_only + action-dense + demo_payoff: +1 visual_interest lifts 20→21 (kept)",
    boosted.kept.length === 1 &&
      boosted.kept[0].rubricScores.visual_interest === 3 &&
      boosted.kept[0].visualInterestBoosted === true
  );
  const cameraSame = runDeterministicChecks([demoMoment], {
    ...boostBase,
    format: { recordingFormat: "camera_only", slideSync: null, frameDiffRatio: null },
  });
  check(
    "same candidate under camera_only: NO boost (dropped below bar)",
    cameraSame.kept.length === 0 && cameraSame.dropped[0]?.rule === "rubric_below_threshold"
  );
  const nonDemo = runDeterministicChecks(
    [moment({ ...demoMoment, momentType: "concrete_win" } as never)],
    { ...boostBase, format: { recordingFormat: "screen_only", slideSync: null, frameDiffRatio: null } }
  );
  check("non-demo_payoff type on the same dense span: NO boost", nonDemo.kept.length === 0);
  const capped = runDeterministicChecks(
    [moment({ ...demoMoment, rubricScores: { ...GOOD_SCORES, visual_interest: 5 } } as never)],
    { ...boostBase, format: { recordingFormat: "screen_only", slideSync: null, frameDiffRatio: null } }
  );
  check(
    "boost caps at 5 and is not reported when it changes nothing",
    capped.kept[0]?.rubricScores.visual_interest === 5 && capped.kept[0]?.visualInterestBoosted === false
  );
}

function hookSlideRefSpecs() {
  console.log("# hookIntegrity.slideRef.spec (FR-4: slide-citing hooks vs. the sync window)");
  check("detects 'this diagram'", hookCitesSlideVisual("This diagram explains recursion"));
  check("detects 'this one diagram'", hookCitesSlideVisual("This one diagram explains X"));
  check("detects 'the chart'", hookCitesSlideVisual("The chart nobody reads correctly"));
  check("plain hooks are not slide refs", !hookCitesSlideVisual("You've been indexing wrong"));
  check(
    "no sync data ⇒ lint silent (unverifiable, model verdict still applies)",
    lintHookSlideRef("This diagram explains X", { syncAvailable: false, slideWithinSpan: false }).length === 0
  );
  check(
    "sync + slide in window ⇒ pass",
    lintHookSlideRef("This diagram explains X", { syncAvailable: true, slideWithinSpan: true }).length === 0
  );
  check(
    "sync + NO slide in window ⇒ violation",
    lintHookSlideRef("This diagram explains X", { syncAvailable: true, slideWithinSpan: false })[0]?.rule ===
      "hook_slide_ref_unsupported"
  );

  // Full deterministic path: sync exists, span sits BEFORE the first slide →
  // slide-citing hooks pruned; all-slide-ref hooks drop the candidate.
  const slides = fixtureByKey("screen_slides");
  const slideWords = wordsFromSegments(slides.segments);
  const lateSync = [{ slideId: "s1", atMs: 200_000 }]; // nothing on screen until 200s
  const slideRefMoment = moment({
    rank: 1,
    startMs: 25_000,
    endMs: 60_000,
    hookText: "This diagram explains the cash gap",
    altHooks: ["The chart your accountant hides", "This one diagram explains profit"],
    captionDraft: null,
    rubricScores: GOOD_SCORES,
  });
  const dropped = runDeterministicChecks([slideRefMoment], {
    durationMs: slides.durationMs,
    words: slideWords,
    sourceContext: "",
    format: { recordingFormat: "screen_only", slideSync: lateSync, frameDiffRatio: null },
  });
  check(
    "all hooks cite an off-screen slide → dropped as hook_slide_ref_unsupported + repairable",
    dropped.dropped[0]?.rule === "hook_slide_ref_unsupported" && dropped.repairIssues.length === 1
  );
  const promoted = runDeterministicChecks(
    [moment({ ...slideRefMoment, altHooks: ["Profit is an opinion", "Cash is the fact"] } as never)],
    {
      durationMs: slides.durationMs,
      words: slideWords,
      sourceContext: "",
      format: { recordingFormat: "screen_only", slideSync: lateSync, frameDiffRatio: null },
    }
  );
  check(
    "slide-ref hook pruned, clean alt promoted",
    promoted.kept[0]?.hookText === "Profit is an opinion"
  );
  const covered = runDeterministicChecks([slideRefMoment], {
    durationMs: slides.durationMs,
    words: slideWords,
    sourceContext: "",
    format: { recordingFormat: "screen_only", slideSync: slides.slideSync, frameDiffRatio: null },
  });
  check(
    "same hooks with the slide actually on screen → kept (and routed slide_short)",
    covered.kept[0]?.hookText.includes("diagram") && covered.kept[0]?.layout === "slide_short"
  );
}

/* ══════════════ Hook Overlay + Karaoke Caption Burn (H-1..H-6, T-1..T-7) ══
 * The directive's named specs, pure halves. The REAL-render halves (frame
 * samples, goldens, font fallback) live in verify-clips-render; the DB
 * halves (re-burn flow, rotation, quota, revert) in verify-clips-int.     */

const TEXT_FIXTURE_WORDS = [
  { w: "the", startMs: 500, endMs: 700 },
  { w: "reason", startMs: 700, endMs: 1_100 },
  { w: "your", startMs: 1_100, endMs: 1_350 },
  { w: "code", startMs: 1_350, endMs: 1_700 },
  { w: "is", startMs: 1_900, endMs: 2_050 },
  { w: "slow", startMs: 2_050, endMs: 2_500 },
  { w: "is", startMs: 2_500, endMs: 2_650 },
  { w: "hiding", startMs: 2_650, endMs: 3_100 },
  { w: "in", startMs: 3_100, endMs: 3_250 },
  { w: "this", startMs: 3_250, endMs: 3_500 },
  { w: "loop", startMs: 3_500, endMs: 3_900 },
  // ≥800ms silence → a new group starts here
  { w: "watch", startMs: 4_900, endMs: 5_200 },
  { w: "what", startMs: 5_200, endMs: 5_400 },
  { w: "happens", startMs: 5_400, endMs: 5_900 },
  { w: "when", startMs: 5_900, endMs: 6_100 },
  { w: "N", startMs: 6_100, endMs: 6_400 },
  { w: "doubles", startMs: 6_400, endMs: 6_900 },
];

function textSpecFixture(over: Partial<ClipTextTrackSpec> = {}): ClipTextTrackSpec {
  return {
    platform: "tiktok",
    preset: "tofu_hook",
    videoWidth: 1080,
    videoHeight: 1920,
    clipDurationMs: 12_000,
    hook: { text: "This is why Theta(N) actually matters" },
    captionsEnabled: true,
    captionStyle: null,
    captionWords: TEXT_FIXTURE_WORDS,
    ...over,
  };
}

interface ParsedDialogue {
  layer: number;
  startMs: number;
  endMs: number;
  style: string;
  text: string;
}
function parseDialogues(ass: string): ParsedDialogue[] {
  const toMs = (t: string) => {
    const m = /^(\d+):(\d+):(\d+)\.(\d+)$/.exec(t)!;
    return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10);
  };
  return ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue: "))
    .map((l) => {
      const m = /^Dialogue: (\d+),([^,]+),([^,]+),([^,]+),,0,0,0,,(.*)$/.exec(l)!;
      return { layer: Number(m[1]), startMs: toMs(m[2]), endMs: toMs(m[3]), style: m[4], text: m[5] };
    });
}

function textStylesSpec() {
  console.log("# textStyles.spec (H-4/T-2/T-4: safe areas, sizing, motion — single source)");
  // T-2 pins (the addendum's numbers WIN — a change here is a deliberate
  // restyle and must regenerate the T-6 goldens in the same PR).
  check(
    "T-2 sizing table pinned (hook 92/72, shrink 60, low-key 64, captions 64)",
    CLIP_TEXT_STYLES.hookSingleLine.sizePx === 92 &&
      CLIP_TEXT_STYLES.hookTwoLine.sizePx === 72 &&
      CLIP_TEXT_STYLES.hookShrunk.sizePx === 60 &&
      CLIP_TEXT_STYLES.hookLowKey.sizePx === 64 &&
      CLIP_TEXT_STYLES.caption.sizePx === 64
  );
  check(
    "stroke is NON-OPTIONAL on both layers (hook 5px, captions 4px, >0 everywhere)",
    CLIP_TEXT_STYLES.hookSingleLine.strokePx === 5 &&
      CLIP_TEXT_STYLES.caption.strokePx === 4 &&
      [
        CLIP_TEXT_STYLES.hookSingleLine,
        CLIP_TEXT_STYLES.hookTwoLine,
        CLIP_TEXT_STYLES.hookShrunk,
        CLIP_TEXT_STYLES.hookLowKey,
        CLIP_TEXT_STYLES.caption,
        CLIP_TEXT_STYLES.endCard,
      ].every((s) => s.strokePx > 0)
  );
  check(
    "captions carry NO shadow; hooks carry the soft 3px drop (T-2)",
    CLIP_TEXT_STYLES.caption.shadowPx === 0 && CLIP_TEXT_STYLES.hookSingleLine.shadowPx === 3
  );
  check(
    "T-4 motion values pinned (280/18%/2.5s/240 · 200/200 · 3.2s · 200)",
    CLIP_TEXT_MOTION.slideInFade.slideMs === 280 &&
      CLIP_TEXT_MOTION.slideInFade.travelFrac === 0.18 &&
      CLIP_TEXT_MOTION.slideInFade.holdMsDefault === 2_500 &&
      CLIP_TEXT_MOTION.slideInFade.fadeOutMs === 240 &&
      CLIP_TEXT_MOTION.fadeInOut.fadeInMs === 200 &&
      CLIP_TEXT_MOTION.slideAcross.traverseMs === 3_200 &&
      CLIP_TEXT_MOTION.persistent.fadeInMs === 200
  );
  check(
    "H-5 preset defaults (tofu slide_in_fade+beam+CAPS · mofu fade+beam · bofu persistent+minimal+low-key)",
    CLIP_TEXT_PRESET_DEFAULTS.tofu_hook.animation === "slide_in_fade" &&
      CLIP_TEXT_PRESET_DEFAULTS.tofu_hook.captionStyle === "beam" &&
      CLIP_TEXT_PRESET_DEFAULTS.tofu_hook.hookCase === "upper" &&
      CLIP_TEXT_PRESET_DEFAULTS.mofu_story.animation === "fade_in_out" &&
      CLIP_TEXT_PRESET_DEFAULTS.bofu_preview.animation === "persistent" &&
      CLIP_TEXT_PRESET_DEFAULTS.bofu_preview.captionStyle === "minimal" &&
      CLIP_TEXT_PRESET_DEFAULTS.bofu_preview.lowKeyHook === true
  );
  check(
    "T-3 style presets are pure data (beam brand-fill @106% · block box · minimal none)",
    CLIP_CAPTION_STYLE_SPECS.beam.activeFill !== null &&
      CLIP_CAPTION_STYLE_SPECS.beam.activeScalePct === 106 &&
      CLIP_CAPTION_STYLE_SPECS.block.activeBox === true &&
      CLIP_CAPTION_STYLE_SPECS.minimal.activeFill === null &&
      CLIP_CAPTION_STYLE_SPECS.minimal.activeBox === false
  );

  // H-4 position math: every platform × {9:16 reference, 1:1, the in-house
  // 720×1280 output} keeps anchors inside the safe frame.
  const canvases = [
    { w: 1080, h: 1920 },
    { w: 1080, h: 1080 },
    { w: 720, h: 1280 },
  ];
  let contained = true;
  for (const platform of CLIP_PLATFORMS) {
    for (const { w, h } of canvases) {
      const frame = safeTextFrame(platform, w, h);
      if (!(frame.x0 > 0 && frame.y0 > 0 && frame.x1 < w && frame.y1 < h && frame.x0 < frame.x1 && frame.y0 < frame.y1)) contained = false;
      const cap = captionAnchor(platform, w, h);
      if (!(cap.x >= frame.x0 && cap.x <= frame.x1 && cap.bottomY <= frame.y1 && cap.bottomY >= frame.y0)) contained = false;
      // captions land in the LOWER THIRD by construction
      if (h >= w && cap.bottomY < (2 / 3) * h) contained = false;
      for (const preset of ["tofu_hook", "mofu_story", "bofu_preview"]) {
        const blockH = Math.round(CLIP_TEXT_STYLES.hookTwoLine.sizePx * 2 * CLIP_TEXT_STYLES.lineHeightFrac * clipTextScale(h));
        const hook = hookAnchor(platform, preset, w, h, blockH);
        if (!(hook.y - blockH / 2 >= frame.y0 - 1 && hook.y + blockH / 2 <= frame.y1 + 1)) contained = false;
      }
    }
  }
  check("H-4: hook + caption anchors stay inside every platform safe area at 9:16, 1:1, and 720×1280", contained);
  check(
    "1:1 scales proportionally BY HEIGHT (T-2: 1080×1080 → 1080/1920 of reference)",
    clipTextScale(1080) === 1080 / 1920 && clipTextScale(1920) === 1
  );
}

function textTrackAssSpec() {
  console.log("# textTrack.ass.spec (H-1: snapshots per animation × preset × platform)");
  const doc = buildClipTextTrack(textSpecFixture());
  const ass = doc.ass;
  check("header: PlayRes = the ACTUAL video dims (libass never rescales anamorphically)", ass.includes("PlayResX: 1080") && ass.includes("PlayResY: 1920"));
  check("header: WrapStyle 2 (WE control line breaks) + ScaledBorderAndShadow", ass.includes("WrapStyle: 2") && ass.includes("ScaledBorderAndShadow: yes"));
  check(
    "styles reference the BUNDLED families (Archivo Black hook, Inter Bold captions)",
    ass.includes(`Style: WiseHook,${CLIP_TEXT_FONTS.hook.family},`) &&
      ass.includes(`Style: WiseCaption,${CLIP_TEXT_FONTS.caption.family},`)
  );
  check("style version stamped in the document header", ass.includes(CLIP_TEXT_STYLE_VERSION));
  check("tofu hook renders ALL CAPS with \\move slide + \\fad out (slide_in_fade)", /THIS IS WHY THETA\(N\)/.test(ass) && /\\move\(/.test(ass) && /\\fad\(0,240\)/.test(ass));

  // animation variants — the data-driven enum, one dialogue each (H-1)
  const hookEventFor = (animation: (typeof CLIP_HOOK_ANIMATIONS)[number]) => {
    const d = buildClipTextTrack(textSpecFixture({ hook: { text: "Short hook", animation } }));
    return parseDialogues(d.ass).filter((e) => e.style === "WiseHook");
  };
  const fade = hookEventFor("fade_in_out");
  check("fade_in_out: \\fad both ends over in+hold+out", fade.length === 1 && /\\fad\(200,200\)/.test(fade[0].text) && fade[0].endMs === 200 + 2_500 + 200);
  const across = hookEventFor("slide_across");
  check("slide_across: off-frame left → off-frame right over 3.2s", across.length === 1 && /\\move\(-\d+/.test(across[0].text) && across[0].endMs === 3_200);
  const persistent = hookEventFor("persistent");
  check("persistent: \\pos, no exit — covers the whole clip", persistent.length === 1 && /\\pos\(/.test(persistent[0].text) && persistent[0].endMs === 12_000);
  const slideIn = hookEventFor("slide_in_fade");
  check("slide_in_fade window = slide + hold + fade-out", slideIn[0].endMs === 280 + 2_500 + 240);
  const held = buildClipTextTrack(textSpecFixture({ hook: { text: "Short hook", animation: "slide_in_fade", holdSeconds: 3 } }));
  check("creator holdSeconds overrides the default hold", parseDialogues(held.ass).find((e) => e.style === "WiseHook")!.endMs === 280 + 3_000 + 240);

  // The committed snapshot table: sha256 per (animation × preset × platform).
  // Regenerate deliberately: CLIP_TEXT_GOLDENS_RECORD=1 npm run verify:clips
  // (drift without a bump = a silent restyle — exactly what this catches).
  const goldenPath = join(ROOT, "lib", "marketing", "clips", "fixtures", "textTrackGoldens.json");
  const table: Record<string, string> = {};
  for (const animation of CLIP_HOOK_ANIMATIONS) {
    for (const preset of ["tofu_hook", "mofu_story", "bofu_preview"]) {
      for (const platform of CLIP_PLATFORMS) {
        const out = buildClipTextTrack(
          textSpecFixture({ platform, preset, hook: { text: "This is why Theta(N) actually matters", animation } })
        );
        table[`${animation}|${preset}|${platform}`] = createHash("sha256").update(out.ass).digest("hex");
      }
    }
  }
  if (process.env.CLIP_TEXT_GOLDENS_RECORD === "1") {
    writeFileSync(goldenPath, JSON.stringify({ styleVersion: CLIP_TEXT_STYLE_VERSION, table }, null, 2) + "\n");
    console.log(`  … recorded ${Object.keys(table).length} ASS snapshots → ${goldenPath}`);
  }
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { styleVersion: string; table: Record<string, string> };
  check("ASS snapshot table covers the full 4×3×4 matrix", Object.keys(golden.table).length === 48);
  const drifted = Object.entries(table).filter(([k, v]) => golden.table[k] !== v);
  check(
    `ASS output matches the committed snapshots for all 48 combos (${golden.styleVersion})`,
    golden.styleVersion === CLIP_TEXT_STYLE_VERSION && drifted.length === 0,
    drifted.slice(0, 3).map(([k]) => k).join(", ")
  );
}

function textTrackKaraokeSpec() {
  console.log("# textTrack.karaoke.spec (word-level timing math over fixture words)");
  const groups = groupCaptionWords(TEXT_FIXTURE_WORDS, 12_000);
  check(
    "grouping: 3-4 words per line, ≥800ms silence starts a new group",
    groups.every((g) => g.words.length <= 4) &&
      groups.some((g) => g.words[0].w === "watch") // the gap split
  );
  check(
    "group windows: start at the first word, linger ≤1200ms, never overlap the next",
    groups.every((g, i) => {
      const next = groups[i + 1];
      const lastEnd = g.words[g.words.length - 1].endMs;
      return g.startMs === g.words[0].startMs && g.endMs <= Math.min(next?.startMs ?? Infinity, lastEnd + 1_200);
    })
  );
  // Stranded single-word tail rebalances (…4+1 → …3+2).
  const tail = groupCaptionWords(
    [
      { w: "a", startMs: 0, endMs: 200 },
      { w: "b", startMs: 200, endMs: 400 },
      { w: "c", startMs: 400, endMs: 600 },
      { w: "d", startMs: 600, endMs: 800 },
      { w: "e", startMs: 800, endMs: 1_000 },
    ],
    5_000
  );
  check("a stranded 1-word tail rebalances from the previous group (3+2, never 4+1)", tail.length === 2 && tail[0].words.length === 3 && tail[1].words.length === 2);

  // beam: per-word interval events tile each group window exactly.
  const beam = buildClipTextTrack(textSpecFixture({ hook: null, captionStyle: "beam" }));
  const beamEvents = parseDialogues(beam.ass).filter((e) => e.style === "WiseCaption");
  const tiled = groups.every((g) => {
    const evs = beamEvents.filter((e) => e.startMs >= g.startMs - 10 && e.endMs <= g.endMs + 10).sort((a, b) => a.startMs - b.startMs);
    if (evs.length === 0) return false;
    if (Math.abs(evs[0].startMs - g.startMs) > 10 || Math.abs(evs[evs.length - 1].endMs - g.endMs) > 10) return false;
    return evs.every((e, i) => i === 0 || Math.abs(e.startMs - evs[i - 1].endMs) <= 10);
  });
  check("beam: interval events tile every group window (no gaps, no overlaps, cs precision)", tiled);
  const brandTag = assColor(CLIP_TEXT_STYLES.accent);
  check(
    "beam: exactly one active word per spoken interval (brand fill + 106% scale)",
    beamEvents.some((e) => e.text.includes(`\\1c${brandTag}`) && e.text.includes("\\fscx106")) &&
      beamEvents.every((e) => (e.text.match(/\\fscx106/g) ?? []).length <= 1)
  );

  // minimal: ONE event per group, no active-word styling at all.
  const minimal = buildClipTextTrack(textSpecFixture({ hook: null, captionStyle: "minimal" }));
  const minEvents = parseDialogues(minimal.ass).filter((e) => e.style === "WiseCaption");
  check(
    "minimal: one event per group, zero active-word tags",
    minEvents.length === groups.length && minEvents.every((e) => !e.text.includes("\\fscx") && !e.text.includes(`\\1c${brandTag}`))
  );

  // block: brand box rides the LOWER layer only while a word is spoken; the
  // stroked base line renders once per group ABOVE it.
  const block = buildClipTextTrack(textSpecFixture({ hook: null, captionStyle: "block" }));
  const blockEvents = parseDialogues(block.ass);
  const boxEvents = blockEvents.filter((e) => e.style === "WiseCaptionBox");
  const baseEvents = blockEvents.filter((e) => e.style === "WiseCaption");
  check(
    "block: box events only during spoken words (layer 0), one base line per group (layer 1)",
    boxEvents.length === TEXT_FIXTURE_WORDS.length &&
      boxEvents.every((e) => e.layer === 0 && e.text.includes("\\3a&H00&")) &&
      baseEvents.length === groups.length &&
      baseEvents.every((e) => e.layer === 1)
  );
  check(
    "block: the box layer's TEXT is invisible everywhere (only the run-box shows)",
    boxEvents.every((e) => !e.text.includes("\\1a&H00&"))
  );

  // captions disabled / no words ⇒ zero caption events
  const off = buildClipTextTrack(textSpecFixture({ captionsEnabled: false }));
  check("captionsEnabled=false ⇒ zero caption events (hook only)", parseDialogues(off.ass).every((e) => e.style === "WiseHook"));
}

function textTrackWrapSpec() {
  console.log("# textTrack.wrap.spec (T-2 ladder: 1-line → 2-line → ONE shrink → hard fail)");
  const short = buildClipTextTrack(textSpecFixture({ hook: { text: "Big O is a lie" } }));
  check("≤6 words that fit → ONE line at 92px", short.hookPlan?.lines.length === 1 && short.hookPlan?.sizePx === 92);
  const eight = buildClipTextTrack(textSpecFixture({ hook: { text: "Why your sorting code slows down at scale" } }));
  check(
    "7-10 words → two BALANCED lines at 72px",
    eight.hookPlan?.lines.length === 2 &&
      eight.hookPlan?.sizePx === 72 &&
      Math.abs(eight.hookPlan!.lines[0].length - eight.hookPlan!.lines[1].length) <= 8
  );
  const longWords = buildClipTextTrack(
    textSpecFixture({ hook: { text: "extraordinary complexity mathematics of sorting" } })
  );
  check(
    "an overflowing hook takes the ONE shrink step (60px) with a hook_shrunk finding",
    longWords.hookPlan?.sizePx === 60 && longWords.findings.some((f) => f.kind === "hook_shrunk")
  );
  let unfit = false;
  try {
    buildClipTextTrack(
      textSpecFixture({ hook: { text: "incomprehensibilities counterrevolutionaries institutionalization intercontinentalism telecommunications" } })
    );
  } catch (err) {
    unfit = err instanceof ClipTextTrackError && err.code === "hook_unfit";
  }
  check("past the shrink step → HARD FAIL (hook_unfit — T-7)", unfit);
  let tooMany = false;
  try {
    buildClipTextTrack(textSpecFixture({ hook: { text: "one two three four five six seven eight nine ten eleven" } }));
  } catch (err) {
    tooMany = err instanceof ClipTextTrackError && err.code === "hook_too_many_words";
  }
  check("an 11-word hook hard-fails at the builder too (defense under the Zod bound)", tooMany);
  const lowKey = buildClipTextTrack(textSpecFixture({ preset: "bofu_preview", hook: { text: "Inside the real course lesson" } }));
  check(
    "bofu low-key hook renders at 64px (H-5) in Title Case",
    lowKey.hookPlan?.sizePx === 64 && lowKey.hookPlan?.lines.join(" ") === "Inside The Real Course Lesson"
  );
  const square = buildClipTextTrack(textSpecFixture({ videoWidth: 1080, videoHeight: 1080, hook: { text: "Big O is a lie" } }));
  check("1:1 canvas scales hook size by height (92 → 52)", square.hookPlan?.sizePx === Math.round(92 * (1080 / 1920)));
  check("case rule preserves existing capitals (Theta(N) survives Title Case)", applyCaseRule("why Theta(N) matters for USACO", "title") === "Why Theta(N) Matters For USACO");
}

function textTrackLintSpec() {
  console.log("# textTrack.lint.spec (T-7: deterministic pre-burn legibility)");
  // Hook-duplicate caption suppression: the first caption line reads the
  // hook back within its hold window → suppressed while the hook shows.
  const echoWords = [
    { w: "this", startMs: 300, endMs: 500 },
    { w: "is", startMs: 500, endMs: 650 },
    { w: "why", startMs: 650, endMs: 900 },
    { w: "it", startMs: 2_000, endMs: 2_200 },
    { w: "matters", startMs: 2_200, endMs: 2_700 },
  ];
  const echo = buildClipTextTrack(
    textSpecFixture({ hook: { text: "This is why" }, captionWords: echoWords, captionStyle: "minimal" })
  );
  const echoCaptions = parseDialogues(echo.ass).filter((e) => e.style === "WiseCaption");
  const hookEnd = echo.hookPlan!.windowMs[1];
  check(
    "hook-duplicate first caption line suppressed while the hook is visible",
    echo.findings.some((f) => f.kind === "caption_suppressed_under_hook") &&
      echoCaptions.every((e) => e.startMs >= hookEnd || !/this is why/i.test(e.text.replace(/\{[^}]*\}/g, "")))
  );

  // Width regroup: narrow 1:1 canvas + long words → regrouped finding.
  const wide = buildClipTextTrack(
    textSpecFixture({
      videoWidth: 720,
      videoHeight: 1280,
      hook: null,
      captionWords: [
        { w: "extraordinarily", startMs: 0, endMs: 500 },
        { w: "sophisticated", startMs: 500, endMs: 1_000 },
        { w: "implementations", startMs: 1_000, endMs: 1_500 },
        { w: "everywhere", startMs: 1_500, endMs: 2_000 },
      ],
    })
  );
  check("over-wide caption lines regroup at fewer words (finding recorded)", wide.findings.some((f) => f.kind === "caption_regrouped_for_width"));

  // Accent clamp: >2 accent words clamps with a finding; ≤2 paint.
  const accent = buildClipTextTrack(
    textSpecFixture({ hook: { text: "Theta matters more than speed", accentWordIndices: [0, 1, 2] } })
  );
  const accentTag = assColor(CLIP_TEXT_STYLES.accent);
  const hookEvent = parseDialogues(accent.ass).find((e) => e.style === "WiseHook")!;
  const accentCount = hookEvent.text.split(`\\1c${accentTag}`).length - 1;
  check(
    "hook accent clamps at 2 words (T-2) with a finding",
    accent.findings.some((f) => f.kind === "hook_accent_clamped") && accentCount === 2
  );

  // Safe-area clamp: bofu's 0.14 anchor sits above tiktok's top zone → clamped.
  const clamped = buildClipTextTrack(textSpecFixture({ preset: "bofu_preview", platform: "tiktok", hook: { text: "Inside the course" } }));
  check("hook anchor clamps INTO the safe area with a finding (bofu on tiktok)", clamped.findings.some((f) => f.kind === "safe_area_clamped"));

  // Burn degrade: an unfit hook burns captions-only with hook_omitted_unfit
  // (the pipeline half is proven in verify-clips-render with real ffmpeg).
}

function textBurnArgsSpec() {
  console.log("# textBurn.args.spec (H-2: golden ffmpeg args, escaping, platform pick)");
  const args = buildBurnArgs({
    inputPath: "/tmp/in.mp4",
    assPath: "/tmp/track.ass",
    fontsDir: "/repo/assets/clip-fonts",
    outputPath: "/tmp/out.mp4",
  });
  check(
    "golden burn args: single subtitles pass, crf 20 parity, audio COPIED, faststart",
    JSON.stringify(args) ===
      JSON.stringify([
        "-y",
        "-i", "/tmp/in.mp4",
        "-vf", "subtitles=filename='/tmp/track.ass':fontsdir='/repo/assets/clip-fonts'",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "/tmp/out.mp4",
      ])
  );
  check("filter path escaping: a quote splices out as '\\''", escapeFilterPath("a'b") === "a'\\''b");
  check(
    "burn platform mirrors ingest (primary targetPlatformFit; instagram fallback)",
    burnPlatformFor({ targetPlatformFit: ["tiktok", "instagram"] }) === "tiktok" &&
      burnPlatformFor({ targetPlatformFit: [] }) === "instagram"
  );
}

/* ─────────────────────────────── run ───────────────────────────────────── */

async function main() {
  constantsChecks();
  schemaChecks();
  transcriptChecks();
  lintChecks();
  validateChecks();
  await pipelineChecks();
  promptChecks();
  fixtureChecks();
  registryChecks();
  driftAndGrepChecks();
  await recordingFormatSpecs();
  routingMatrixSpecs();
  actionDensitySpecs();
  rubricFormatAwareSpecs();
  hookSlideRefSpecs();
  textStylesSpec();
  textTrackAssSpec();
  textTrackKaraokeSpec();
  textTrackWrapSpec();
  textTrackLintSpec();
  textBurnArgsSpec();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
