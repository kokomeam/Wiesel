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

  let makeModel: (fixtureKey: string, log: RecordedCall[]) => ModelClient;
  if (LIVE) {
    const { createOpenAIModelClient, isOpenAIConfigured } = await import("@/lib/ai/providers/openai");
    if (!isOpenAIConfigured()) {
      console.error("--live needs OPENAI_API_KEY in .env.local");
      process.exit(1);
    }
    makeModel = (_key, log) => recordingClient(createOpenAIModelClient(), log);
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
      request: { stages: "balanced", targetPlatforms: ["instagram", "tiktok", "youtube_shorts", "facebook"], count: 5 },
    });
    const score = scoreFixture(fixture, result);
    scores.push(score);
    results.push({ fixture: fixture.key, result });
    console.log(
      `# ${fixture.key}: ${score.viable} viable / ${score.returned} returned · recall@5 ${score.goldHit}/${score.goldTotal} · rubric ${pct(score.rubricPassRate)} · hooks ${pct(score.hookIntegrityRate)} · coherence ${pct(score.coherencePassRate)} · ${Date.now() - started}ms`
    );
    for (const c of result.kept) {
      console.log(`    ✓ [${Math.round(c.startMs / 1000)}s–${Math.round(c.endMs / 1000)}s ${c.momentType} · ${c.funnelStage}] "${c.hookText}"`);
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
      gate(
        `${s.fixture}: viable ≥ baseline (${b.viable})`,
        s.viable >= b.viable,
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
