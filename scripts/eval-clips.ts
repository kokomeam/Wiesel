/**
 * Moment-selection EVAL HARNESS (PRD 1.5 §16/§20) — gates prompt + preset
 * changes. Runs the REAL pipeline core (runSelectionCore — the same code the
 * product executes) over the 3 annotated fixture lessons and scores:
 *
 *   recall@5           — gold moments hit by returned candidates (overlap
 *                        ≥50% of the shorter span)
 *   rubricPassRate     — raw candidates clearing the §8.3 bar
 *   hookIntegrityRate  — candidates surviving the hook-integrity gates
 *   coherencePassRate  — candidates surviving standalone-coherence
 *   flatAffectViable   — the differentiator claim: the flat-affect fixture
 *                        MUST yield ≥2 viable candidates (PRD §2)
 *
 * Modes:
 *   npx tsx scripts/eval-clips.ts                    — REPLAY (CI): recorded
 *     model outputs from lib/marketing/clips/fixtures/recordings/*.json;
 *     scores must meet the committed baseline (eval-baseline.json).
 *   npx tsx scripts/eval-clips.ts --live             — real OpenAI (needs
 *     OPENAI_API_KEY in .env.local); scores vs. baseline.
 *   npx tsx scripts/eval-clips.ts --live --record    — real OpenAI; WRITES
 *     recordings + baseline (do this after any CLIP_PROMPT_VERSION bump; the
 *     new scores must beat the incumbent before merging — §8 binding rule).
 *   npx tsx scripts/eval-clips.ts --live --control   — FR-8's control run:
 *     the model sees the PRE-AMENDMENT (format-blind) prompt — the
 *     RECORDING FORMAT AWARENESS block and the request's format line are
 *     stripped in a client wrapper; the core runs verbatim. Scores land in
 *     recordings/control-scores.json; comparing visual_interest on the
 *     screen-only fixtures against the amended run IS the FR-8 delta test.
 *     Never writes recordings/baseline; always exits 0 (an experiment
 *     artifact, not a gate).
 *
 * No DB, no Supabase — the harness feeds fixture transcripts + context
 * straight into the core.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ModelClient, ModelTurnParams, ModelTurnResult } from "@/lib/ai/modelClient";
import { clipConfig } from "@/lib/marketing/clips/constants";
import { CLIP_PROMPT_VERSION } from "@/lib/marketing/clips/prompt";
import { runSelectionCore, type SelectionCoreResult } from "@/lib/marketing/clips/selection";
import {
  FIXTURE_LESSONS,
  wordsFromSegments,
  type FixtureLesson,
} from "@/lib/marketing/clips/fixtures/lessons";
import { deriveVoiceProfileDeterministic } from "@/lib/marketing/social/voice";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = join(HERE, "..", "lib", "marketing", "clips", "fixtures", "recordings");
const BASELINE_PATH = join(RECORDINGS_DIR, "eval-baseline.json");

const LIVE = process.argv.includes("--live");
const RECORD = process.argv.includes("--record");
const CONTROL = process.argv.includes("--control");

/* ─────────────────────────── env (tsx doesn't auto-load) ───────────────── */

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(HERE, "..", ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* absent env file is fine in replay mode */
  }
}

/* ───────────────────────── record / replay clients ─────────────────────── */

interface RecordedCall {
  format: string | null;
  text: string;
}

function recordingClient(inner: ModelClient, log: RecordedCall[]): ModelClient {
  return {
    model: inner.model,
    async runTurn(params: ModelTurnParams, onEvent: (e: never) => void): Promise<ModelTurnResult> {
      const result = await inner.runTurn(params, onEvent as never);
      log.push({ format: params.responseFormat?.name ?? null, text: result.text });
      return result;
    },
  };
}

/**
 * FR-8 control wrapper: reconstructs the PRE-AMENDMENT (clips-v2) prompt —
 * strips the RECORDING FORMAT AWARENESS block from the static prefix and the
 * `- recording format: …` line from the request block — then delegates. The
 * pipeline core (routing, boost, lints) runs verbatim; only what the MODEL
 * sees changes, which is exactly the controlled variable.
 */
function controlClient(inner: ModelClient): ModelClient {
  const stripSystem = (s: string | undefined) =>
    s?.replace(/RECORDING FORMAT AWARENESS[\s\S]*?\n\n/, "");
  const stripInput = (input: ModelTurnParams["input"]) =>
    input.map((m) =>
      "content" in m && typeof m.content === "string"
        ? { ...m, content: m.content.replace(/^- recording format: .*\n/m, "") }
        : m
    );
  return {
    model: inner.model,
    async runTurn(params: ModelTurnParams, onEvent: (e: never) => void): Promise<ModelTurnResult> {
      const system = stripSystem(params.system);
      if (params.system?.includes("RECORDING FORMAT AWARENESS") && system === params.system) {
        throw new Error("control strip failed — the experiment would be invalid, aborting");
      }
      return inner.runTurn(
        { ...params, ...(system !== undefined ? { system } : {}), input: stripInput(params.input) },
        onEvent as never
      );
    },
  };
}

/** Replays recorded calls in order, format-name checked (a prompt change that
 *  alters call STRUCTURE invalidates recordings loudly, not silently). */
function replayClient(calls: RecordedCall[]): ModelClient {
  let i = 0;
  return {
    model: "replay",
    async runTurn(params: ModelTurnParams): Promise<ModelTurnResult> {
      const call = calls[i++];
      if (!call) throw new Error(`replay exhausted at call ${i} (${params.responseFormat?.name})`);
      const want = params.responseFormat?.name ?? null;
      if (call.format !== want) {
        throw new Error(
          `replay call ${i} format mismatch: recorded ${call.format}, pipeline asked ${want} — re-record with --live --record`
        );
      }
      return { text: call.text, toolCalls: [], finishReason: "stop" };
    },
  };
}

/* ────────────────────────────── scoring ────────────────────────────────── */

interface FixtureScore {
  fixture: string;
  returned: number;
  viable: number;
  goldTotal: number;
  goldHit: number;
  recallAt5: number;
  rubricPassRate: number;
  hookIntegrityRate: number;
  coherencePassRate: number;
}

function overlapMs(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

function scoreFixture(fixture: FixtureLesson, result: SelectionCoreResult): FixtureScore {
  const total = result.kept.length + result.dropped.length;
  const goldHit = fixture.goldMoments.filter((g) =>
    result.kept.some((c) => {
      const shorter = Math.min(g.endMs - g.startMs, c.endMs - c.startMs);
      return shorter > 0 && overlapMs(g, c) / shorter >= 0.5;
    })
  ).length;
  const droppedBy = (prefix: string) =>
    result.dropped.filter((d) => d.rule.startsWith(prefix)).length;
  return {
    fixture: fixture.key,
    returned: total,
    viable: result.kept.length,
    goldTotal: fixture.goldMoments.length,
    goldHit,
    recallAt5: fixture.goldMoments.length ? goldHit / fixture.goldMoments.length : 1,
    rubricPassRate: total ? (total - droppedBy("rubric_below_threshold")) / total : 1,
    hookIntegrityRate: total ? (total - droppedBy("hook_")) / total : 1,
    coherencePassRate: total ? (total - droppedBy("standalone_coherence")) / total : 1,
  };
}

interface Baseline {
  promptVersion: string;
  recordedAt: string;
  scores: FixtureScore[];
}

/* ─────────────────────────────── main ──────────────────────────────────── */

async function main() {
  loadEnvLocal();
  const cfg = clipConfig();
  const voice = deriveVoiceProfileDeterministic({ courses: [], emailVoiceRules: [], samples: [] });

  if (CONTROL && (!LIVE || RECORD)) {
    console.error("--control requires --live and forbids --record (it must never contaminate recordings)");
    process.exit(1);
  }

  let makeModel: (fixtureKey: string, log: RecordedCall[]) => ModelClient;
  if (LIVE) {
    const { createOpenAIModelClient, isOpenAIConfigured } = await import("@/lib/ai/providers/openai");
    if (!isOpenAIConfigured()) {
      console.error("--live needs OPENAI_API_KEY in .env.local");
      process.exit(1);
    }
    makeModel = (_key, log) => {
      const live = recordingClient(createOpenAIModelClient(), log);
      return CONTROL ? controlClient(live) : live;
    };
  } else {
    makeModel = (key) => {
      const path = join(RECORDINGS_DIR, `${key}.json`);
      if (!existsSync(path)) {
        console.error(
          `No recording for fixture "${key}" (${path}).\n` +
            "Run once with a key to create CI stubs:  npx tsx scripts/eval-clips.ts --live --record"
        );
        process.exit(LIVE ? 1 : 0); // replay without recordings = not yet recorded, not a failure
      }
      const calls = JSON.parse(readFileSync(path, "utf8")) as RecordedCall[];
      return replayClient(calls);
    };
  }

  const scores: FixtureScore[] = [];
  const results: { fixture: string; result: SelectionCoreResult }[] = [];
  for (const fixture of FIXTURE_LESSONS) {
    const log: RecordedCall[] = [];
    const model = makeModel(fixture.key, log);
    const words = wordsFromSegments(fixture.segments);
    const started = Date.now();
    const result = await runSelectionCore(model, cfg, {
      voice,
      contextText: fixture.courseContext,
      sourceContext: fixture.courseContext,
      words,
      durationMs: fixture.durationMs,
      request: {
        stages: "balanced",
        targetPlatforms: ["instagram", "tiktok", "youtube_shorts", "facebook"],
        count: 5,
        recordingFormat: fixture.recordingFormat,
      },
      recordingFormat: fixture.recordingFormat,
      slideSync: fixture.slideSync,
      // FR-3 degraded mode is the eval reality: no locally accessible media,
      // so transcript cues alone decide action density.
      frameDiffRatio: null,
    });
    const score = scoreFixture(fixture, result);
    scores.push(score);
    results.push({ fixture: fixture.key, result });
    const meanVI =
      result.kept.length > 0
        ? result.kept.reduce((s, c) => s + c.rubricScores.visual_interest, 0) / result.kept.length
        : null;
    console.log(
      `# ${fixture.key} (${fixture.recordingFormat}): ${score.viable} viable / ${score.returned} returned · recall@5 ${score.goldHit}/${score.goldTotal} · rubric ${pct(score.rubricPassRate)} · hooks ${pct(score.hookIntegrityRate)} · coherence ${pct(score.coherencePassRate)} · mean visual_interest ${meanVI?.toFixed(2) ?? "—"} · ${Date.now() - started}ms`
    );
    for (const c of result.kept) {
      console.log(`    ✓ [${Math.round(c.startMs / 1000)}s–${Math.round(c.endMs / 1000)}s ${c.momentType} · ${c.funnelStage} · ${c.layout}] "${c.hookText}"`);
    }
    for (const d of result.dropped) console.log(`    ✗ dropped (${d.rule}): ${d.reason}`);

    if (LIVE && RECORD) {
      mkdirSync(RECORDINGS_DIR, { recursive: true });
      writeFileSync(join(RECORDINGS_DIR, `${fixture.key}.json`), JSON.stringify(log, null, 2));
    }
  }

  /* gates */
  let failed = 0;
  const flat = scores.find((s) => s.fixture === "flat_affect");
  const gate = (name: string, cond: boolean, detail: string) => {
    console.log(`${cond ? "  ✓" : "  ✗"} ${name} ${cond ? "" : `— ${detail}`}`);
    if (!cond) failed++;
  };
  console.log("# gates");
  gate(
    "flat-affect fixture yields ≥2 viable candidates (the differentiator claim, PRD §2)",
    (flat?.viable ?? 0) >= 2,
    `got ${flat?.viable ?? 0}`
  );
  const meanRecall = scores.reduce((s, x) => s + x.recallAt5, 0) / scores.length;
  gate("mean gold recall@5 ≥ 0.6", meanRecall >= 0.6, `got ${meanRecall.toFixed(2)}`);

  // Amendment FR-8: per-fixture viability floors + LAYOUT routing gates —
  // every viable candidate's resolved layout must sit in the fixture's
  // expected set; screen_slides is the binding "≥2 viable, all slide_short".
  for (const fixture of FIXTURE_LESSONS) {
    const s = scores.find((x) => x.fixture === fixture.key);
    const r = results.find((x) => x.fixture === fixture.key)?.result;
    if (!s || !r) continue;
    if (fixture.minViable > 0) {
      gate(
        `${fixture.key}: ≥${fixture.minViable} viable candidates (FR-8)`,
        s.viable >= fixture.minViable,
        `got ${s.viable}`
      );
    }
    const scope = fixture.expectedLayoutsScope ?? "all";
    const inScope =
      scope === "all"
        ? r.kept
        : r.kept.filter((c) =>
            fixture.goldMoments.some((g) => {
              const shorter = Math.min(g.endMs - g.startMs, c.endMs - c.startMs);
              return shorter > 0 && overlapMs(g, c) / shorter >= 0.5;
            })
          );
    const offLayout = inScope.filter((c) => !fixture.expectedLayouts.includes(c.layout));
    gate(
      `${fixture.key}: every ${scope === "all" ? "viable" : "gold-hitting"} candidate routes to {${fixture.expectedLayouts.join(", ")}} (FR-2/FR-8)`,
      offLayout.length === 0,
      offLayout.map((c) => `rank ${c.rank} → ${c.layout}`).join("; ")
    );
    if (fixture.layoutFloor) {
      const demonstrated = r.kept.filter((c) => fixture.expectedLayouts.includes(c.layout)).length;
      gate(
        `${fixture.key}: ≥${fixture.layoutFloor} viable candidates demonstrate {${fixture.expectedLayouts.join(", ")}} (FR-8)`,
        demonstrated >= fixture.layoutFloor,
        `got ${demonstrated}`
      );
    }
  }
  // §2: 100% of SURFACED hooks pass the deterministic hook-integrity lint —
  // re-checked here independently of the pipeline's own gating.
  const { lintHookNumbers } = await import("@/lib/marketing/clips/lint");
  const hookViolations = results.flatMap(({ fixture, result }) =>
    result.kept
      .filter((c) => lintHookNumbers(c.hookText, c.spanTranscript).length > 0)
      .map((c) => `${fixture}: "${c.hookText}"`)
  );
  gate(
    "100% of surfaced hooks pass the hook-integrity lint (PRD §2)",
    hookViolations.length === 0,
    hookViolations.join("; ")
  );

  if (CONTROL) {
    // FR-8 delta artifact: per-fixture scores + visual_interest under the
    // pre-amendment prompt. Compare against the amended run's output — the
    // screen-only fixtures' visual_interest shift is the demonstration.
    const controlPath = join(RECORDINGS_DIR, "control-scores.json");
    writeFileSync(
      controlPath,
      JSON.stringify(
        {
          promptShape: "pre-amendment (format-awareness stripped)",
          against: CLIP_PROMPT_VERSION,
          recordedAt: new Date().toISOString(),
          fixtures: results.map(({ fixture, result }) => ({
            fixture,
            viable: result.kept.length,
            meanVisualInterest:
              result.kept.length > 0
                ? result.kept.reduce((s, c) => s + c.rubricScores.visual_interest, 0) / result.kept.length
                : null,
            visualInterest: result.kept.map((c) => c.rubricScores.visual_interest),
            layouts: result.kept.map((c) => c.layout),
          })),
        },
        null,
        2
      )
    );
    console.log(`# control run recorded → ${controlPath} (informational — always exits 0)`);
    process.exit(0);
  }

  if (LIVE && RECORD) {
    const baseline: Baseline = {
      promptVersion: CLIP_PROMPT_VERSION,
      recordedAt: new Date().toISOString(),
      scores,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
    console.log(`# recorded baseline for ${CLIP_PROMPT_VERSION} → ${BASELINE_PATH}`);
  } else if (existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    console.log(`# baseline: ${baseline.promptVersion} (${baseline.recordedAt})`);
    for (const s of scores) {
      const b = baseline.scores.find((x) => x.fixture === s.fixture);
      if (!b) continue;
      gate(
        `${s.fixture}: recall@5 ≥ baseline (${b.recallAt5.toFixed(2)})`,
        s.recallAt5 >= b.recallAt5 - 1e-9,
        `got ${s.recallAt5.toFixed(2)}`
      );
      // Floor = min(baseline viable, gold count): the prompt must keep every
      // ANNOTATED moment viable and never fall below the incumbent up to
      // that ceiling — but a raw `viable ≥ baseline` would demand PADDING
      // whenever the incumbent had surfaced un-annotated filler (observed:
      // clips-v2's 5th flat_affect candidate was the bullet-reading span
      // clips-v3 correctly declines; recall stayed 1.00). Quality holds via
      // the recall gate + rubric/hook/coherence rates; count beyond gold is
      // bonus, not contract.
      const viableFloor = Math.min(b.viable, s.goldTotal);
      gate(
        `${s.fixture}: viable ≥ min(baseline ${b.viable}, gold ${s.goldTotal}) = ${viableFloor}`,
        s.viable >= viableFloor,
        `got ${s.viable}`
      );
    }
  }

  console.log(failed === 0 ? "EVAL PASS" : `EVAL FAIL (${failed} gate(s))`);
  process.exit(failed === 0 ? 0 : 1);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
