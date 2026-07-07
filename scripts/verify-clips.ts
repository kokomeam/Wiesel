/**
 * Lesson Clip Repurposing (Phase 1.5, M-A) — PURE suite (no key, no DB).
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
 *   - fixtures: 3 lessons, gold spans in-bounds and 20-90s, flat-affect ≥2
 *   - drift guards: TS event union ↔ migration check constraint
 *   - tool registry: 1 read + 2 reversible, ZERO irreversible
 *   - hardening greps: no publish/schedule endpoint references, banned UI
 *     language, no scheduler primitives, text platform enum still closed at 2
 *
 * Run: `npx tsx scripts/verify-clips.ts`
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import {
  BANNED_UI_PHRASES,
  CLIP_MOMENT_TYPES,
  CLIP_PLATFORMS,
  CLIP_PLATFORM_SPECS,
  CLIP_RUBRIC_DIMENSIONS,
  CLIP_RUBRIC_THRESHOLDS,
  clipConfig,
} from "@/lib/marketing/clips/constants";
import {
  lintClipTextSurfaces,
  lintHookNumbers,
  numericClaims,
} from "@/lib/marketing/clips/lint";
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
  const ctx = { durationMs: DURATION_MS, words: WORDS, sourceContext: "" };

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
    { durationMs: DURATION_MS, words: WORDS }
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
    { durationMs: DURATION_MS, words: WORDS }
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
    { durationMs: DURATION_MS, words: WORDS }
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
    { durationMs: DURATION_MS, words: WORDS }
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
    { durationMs: DURATION_MS, words: WORDS }
  );
  check("all hooks unsupported → candidate dropped (§7.4.3)", allHooksFail.dropped[0]?.rule === "hook_integrity");

  const noVerdict = applyValidationVerdicts(kept, [], { durationMs: DURATION_MS, words: WORDS });
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
    },
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
  check("version pinned", CLIP_PROMPT_VERSION === "clips-v2");
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
    request: { stages: "balanced", targetPlatforms: ["tiktok"], count: 3 },
  });
  check(
    "selection input: voice → context → transcript → request order",
    input1.indexOf("VOICE PROFILE") < input1.indexOf("COURSE CONTEXT") &&
      input1.indexOf("COURSE CONTEXT") < input1.indexOf("LESSON TRANSCRIPT") &&
      input1.indexOf("LESSON TRANSCRIPT") < input1.indexOf("REQUEST:")
  );
  check("validation system prompt carries the 8000ms bound", CLIP_VALIDATION_SYSTEM_PROMPT.includes("8000ms"));
  check("map prompt allows an empty shortlist", CLIP_MAP_SYSTEM_PROMPT.includes("empty list is a valid answer"));
  const vInput = buildValidationInput([
    { rank: 1, spanTranscript: "abc", stitchedScript: null, hooks: ["h1", "h2"] },
  ]);
  check("validation input carries span + hooks", vInput.includes('"abc"') && vInput.includes('"h1"'));
}

function fixtureChecks() {
  console.log("# eval fixtures (§16/§20)");
  check("3 fixtures", FIXTURE_LESSONS.length === 3);
  check(
    "fixture keys: charismatic, flat_affect, multi_speaker",
    ["charismatic", "flat_affect", "multi_speaker"].every((k) => FIXTURE_LESSONS.some((f) => f.key === k))
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
}

function registryChecks() {
  console.log("# tool registry (§13)");
  check("exactly 3 clip tools in M-A", clipTools.length === 3);
  check(
    "1 read + 2 reversible, ZERO irreversible",
    clipTools.filter((t) => t.reversibility === "read").length === 1 &&
      clipTools.filter((t) => t.reversibility === "reversible").length === 2 &&
      clipTools.filter((t) => t.reversibility === "irreversible").length === 0
  );
  check(
    "tools registered in ALL_MARKETING_TOOLS",
    clipTools.every((t) => ALL_MARKETING_TOOLS.some((x) => x.name === t.name))
  );
  check(
    "generate-phase set includes the clip tools",
    ["select_clip_moments", "list_clip_moment_candidates", "update_clip_moment_status"].every((n) =>
      MARKETING_GENERATE_TOOLS.has(n)
    )
  );
  const select = clipTools.find((t) => t.name === "select_clip_moments");
  check("select_clip_moments targets the clip_moment_set entity", select?.existingTarget?.({} as never, {} as never) === null);
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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
