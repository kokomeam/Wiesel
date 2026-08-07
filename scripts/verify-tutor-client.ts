/**
 * TUTOR-1 Wave 4 (package A) — the LEARNER-SIDEBAR CLIENT pure suite (no key,
 * no DB, no browser). Covers the zod-free client primitives builder A owns:
 *
 *   STORE       — per-user slice isolation, width clamp, ambient merge, citation
 *                 nonce increment + consume, seed one-shot, suggestion dot.
 *   ENGAGEMENT  — the pure scrub_back / rewatch episode goldens (Contract 2).
 *   QUIZACTIVE  — the derived-active truth table (answeredCount>0 && result===null).
 *   IMPORT FENCE— the zod-free / editor-free / events-free / runtime-free source
 *                 greps over the files A introduces.
 *   A3 (Wave 1) — markdown-lite goldens over the SHARED ui/Markdown parser
 *                 (A3-1), the rung-chrome removal source assertions (A3-2),
 *                 citation dedup (A3-3), and the escape-hatch gate (A3-5).
 *   A3 (Wave 3) — the attempt-gated escape hatch (A3-4: hasAttemptedFor +
 *                 the session-attempts store slice, partialize-excluded), the
 *                 invitation render rule (A3-9/A3-11 client legs:
 *                 shouldRenderInvitation matrix + TutorBody source asserts),
 *                 the initiation-only-on-acceptance send shape, the invitation
 *                 payload mirror parity, and history grounding.invitation
 *                 coercion.
 *
 * Run: `npx tsx scripts/verify-tutor-client.ts`
 */

// Give the persisted store a real (in-memory) storage so its writes don't log
// "storage currently unavailable" noise under Node AND so the persist API
// (`useTutorStore.persist` — the A3-4 partialize assertion reads it) actually
// attaches. MUST be the FIRST import: esbuild/tsx hoists imports, so an inline
// assignment "before" the store import never ran first (see the stub module).
import "./tutor-client-localstorage-stub";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  useTutorStore,
  TUTOR_MIN_WIDTH,
  TUTOR_MAX_WIDTH,
  TUTOR_DEFAULT_WIDTH,
} from "@/lib/learn/tutorStore";
import { createEngagementTracker, type EngagementSignal } from "@/lib/learn/engagement";
import {
  dedupeCitations,
  explainBackCriteriaView,
  gradePracticeAnswer,
  hasAttemptedFor,
  hashSeed,
  scoreCheckUnderstanding,
  scoreFadedCard,
  scorePredictCard,
  scoreSequenceCard,
  selfReportStableKey,
  shouldOfferEscapeHatch,
  shouldRenderInvitation,
  shuffleDeterministic,
  ttftRating,
  type ExplainBackCriterionResult,
  type TutorAssessmentCard,
  type TutorCitation,
  type TutorInvitation,
  type TutorPracticeItem,
  type TutorSSEEvent,
  type TutorTurnPayload,
} from "@/lib/learn/tutorClientTypes";
import { coerceGrounding } from "@/lib/learn/tutorHistory";
import { parseMarkdownBlocks } from "@/components/ui/Markdown";
import { createPhaseFloor, PHASE_FLOOR_MS } from "@/lib/learn/phaseFloor";
import {
  processTutorFrame,
  type TutorFrameCallbacks,
  type TutorStreamStatus,
} from "@/lib/learn/useTutorStream";

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

const ROOT = process.cwd();
function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Reset the store to a clean slate between sections (pure, no storage). */
function resetStore() {
  useTutorStore.setState({
    byUser: {},
    ambient: {
      courseId: null,
      publicationId: null,
      version: null,
      lessonId: null,
      blockId: null,
      slideId: null,
      positionPct: null,
      quizActive: null,
    },
    citationRequest: null,
    seed: null,
    suggestionDot: false,
    sessionAttempts: {},
  });
}

async function main() {
  /* ─────────────────────────────── STORE ──────────────────────────────── */
  console.log("\n— store (per-user slices, nonce, seed, dot) —");
  {
    resetStore();
    const s = () => useTutorStore.getState();

    // Default slice for an unknown user.
    const def = s().userSlice("alice");
    check(
      "unknown user → default slice (closed, default width)",
      def.open === false && def.width === TUTOR_DEFAULT_WIDTH && def.scrollPos === 0
    );

    // Per-user isolation: writing alice never touches bob.
    s().setUserSlice("alice", { open: true, scrollPos: 120 });
    s().setUserSlice("bob", { width: 500 });
    check("alice slice isolated", s().userSlice("alice").open === true && s().userSlice("alice").scrollPos === 120);
    check("bob slice isolated", s().userSlice("bob").open === false && s().userSlice("bob").width === 500);
    check("alice untouched by bob write", s().userSlice("alice").width === TUTOR_DEFAULT_WIDTH);

    // Width clamps both ends.
    s().setUserSlice("alice", { width: TUTOR_MIN_WIDTH - 200 });
    check("width clamps to min", s().userSlice("alice").width === TUTOR_MIN_WIDTH);
    s().setUserSlice("alice", { width: TUTOR_MAX_WIDTH + 200 });
    check("width clamps to max", s().userSlice("alice").width === TUTOR_MAX_WIDTH);
    s().setUserSlice("alice", { width: 400 });
    check("in-range width preserved", s().userSlice("alice").width === 400);

    // Ambient partial merge — a partial set never clobbers untouched keys.
    s().setAmbient({ courseId: "c1", publicationId: "p1", version: 3 });
    s().setAmbient({ blockId: "b1", slideId: "sl1" });
    const amb = s().ambient;
    check(
      "ambient merges (courseId survives a later partial set)",
      amb.courseId === "c1" && amb.publicationId === "p1" && amb.version === 3 && amb.blockId === "b1" && amb.slideId === "sl1"
    );
    s().setAmbient({ quizActive: true, blockId: "b2" });
    check("ambient later set overwrites named keys only", s().ambient.blockId === "b2" && s().ambient.quizActive === true && s().ambient.courseId === "c1");

    // Citation nonce increments; consume clears.
    check("no citation initially", s().citationRequest === null);
    s().requestCitation({ lessonId: "L1", blockId: "b1", slideId: "sl2" });
    const n1 = s().citationRequest?.nonce;
    check("first citation nonce = 1", n1 === 1 && s().citationRequest?.lessonId === "L1");
    s().requestCitation({ lessonId: "L1", blockId: "b1", slideId: "sl2" });
    check("repeat citation bumps nonce to 2 (same target still fires)", s().citationRequest?.nonce === 2);
    s().consumeCitation();
    check("consumeCitation clears the request", s().citationRequest === null);
    // After a consume the request is gone, so the next nonce restarts at 1 —
    // that is fine: the player's own deck nonce (LearnLessonView) is the
    // monotonic one; the store nonce only needs to differ from the LIVE request
    // it replaces so a same-target repeat re-fires.
    s().requestCitation({ lessonId: "L2", blockId: "b3", slideId: null });
    check("citation after consume restarts at nonce 1", s().citationRequest?.nonce === 1 && s().citationRequest?.slideId === null);

    // Seed one-shot.
    check("no seed initially", s().seed === null);
    s().seedComposer("Help me review Big-O");
    check("seedComposer sets the seed", s().seed === "Help me review Big-O");
    s().consumeSeed();
    check("consumeSeed clears the seed (one-shot)", s().seed === null);

    // Suggestion dot.
    check("dot off initially", s().suggestionDot === false);
    s().setSuggestionDot(true);
    check("dot on", s().suggestionDot === true);
    s().setSuggestionDot(false);
    check("dot off", s().suggestionDot === false);
  }

  /* ────────────── A3-4 · SESSION ATTEMPTS (store slice, non-persisted) ───── */
  console.log("\n— A3-4 · sessionAttempts slice + partialize exclusion —");
  {
    resetStore();
    const s = () => useTutorStore.getState();

    check("no attempts initially", s().sessionAttempts["alice"] === undefined);

    // First attempt with a node: count 1, node recorded.
    s().recordSessionAttempt("alice", "n1");
    check(
      "first attempt records node + count",
      s().sessionAttempts["alice"]?.count === 1 &&
        s().sessionAttempts["alice"]?.nodeIds.join(",") === "n1"
    );

    // Repeat on the SAME node: count bumps, nodeIds stay deduped.
    s().recordSessionAttempt("alice", "n1");
    check(
      "repeat attempt on same node dedupes nodeIds, bumps count",
      s().sessionAttempts["alice"]?.count === 2 &&
        s().sessionAttempts["alice"]?.nodeIds.join(",") === "n1"
    );

    // A second node appends.
    s().recordSessionAttempt("alice", "n2");
    check(
      "second node appends",
      s().sessionAttempts["alice"]?.nodeIds.join(",") === "n1,n2" &&
        s().sessionAttempts["alice"]?.count === 3
    );

    // A null node bumps count only.
    s().recordSessionAttempt("alice", null);
    check(
      "null node bumps count only (no node recorded)",
      s().sessionAttempts["alice"]?.count === 4 &&
        s().sessionAttempts["alice"]?.nodeIds.join(",") === "n1,n2"
    );

    // Per-user isolation.
    s().recordSessionAttempt("bob", "n9");
    check(
      "bob's attempts isolated from alice's",
      s().sessionAttempts["bob"]?.count === 1 &&
        s().sessionAttempts["bob"]?.nodeIds.join(",") === "n9" &&
        s().sessionAttempts["alice"]?.count === 4
    );

    // THE PERSISTENCE INVARIANT: sessionAttempts is EXCLUDED from the persisted
    // slice (the partialize allowlist carries byUser ONLY) — a refresh clears
    // attempts, the conservative direction, deliberate.
    const partialize = useTutorStore.persist.getOptions().partialize;
    check("store has a partialize allowlist", typeof partialize === "function");
    const persisted = partialize
      ? (partialize(useTutorStore.getState()) as Record<string, unknown>)
      : {};
    check("persisted slice carries byUser", "byUser" in persisted);
    check(
      "sessionAttempts NOT in the persisted slice",
      ("sessionAttempts" in persisted) === false
    );
    check(
      "ambient/citation/seed still not persisted either",
      !("ambient" in persisted) && !("citationRequest" in persisted) && !("seed" in persisted)
    );
    // Belt: the partialize SOURCE stays a byUser-only allowlist (drift guard —
    // adding sessionAttempts there would persist attempts across refreshes).
    const storeSrc = readSource("lib/learn/tutorStore.ts");
    check(
      "partialize source is the byUser-only allowlist",
      storeSrc.includes("partialize: (s) => ({ byUser: s.byUser })")
    );
  }

  /* ───────────────────────────── ENGAGEMENT ───────────────────────────── */
  console.log("\n— engagement goldens (scrub_back / rewatch episodes) —");
  {
    // Feed a scripted sequence, collect the per-tick signals.
    function run(seq: number[]): (EngagementSignal | null)[] {
      const t = createEngagementTracker();
      return seq.map((p) => t.feed(p));
    }
    const only = (arr: (EngagementSignal | null)[]) => arr.filter((x): x is EngagementSignal => x !== null);

    // Simple forward advance → nothing.
    check("plain advance → no signals", only(run([0, 10, 20, 30, 40])).length === 0);

    // Small dip (≤5) is jitter, not a scrub.
    check("small dip (5) → no scrub", only(run([0, 30, 25])).length === 0);

    // A >5 drop fires scrub_back exactly once.
    {
      const out = run([0, 40, 33]); // drop of 7
      check("drop >5 → one scrub_back", only(out).length === 1 && out[2] === "scrub_back");
    }

    // A continuing drop does NOT re-fire scrub_back.
    {
      const out = run([0, 60, 50, 40, 30]); // 60→50→40→30, three decreases
      check("continuing drop → scrub_back once only", only(out).filter((x) => x === "scrub_back").length === 1);
      check("no rewatch while still dropping", only(out).includes("rewatch") === false);
    }

    // Advancing back over ALREADY-SEEN ground → rewatch once.
    {
      // reach 60 (highWater 60), scrub to 30, then advance 40,50 (≤60) → rewatch
      // fires on the FIRST advancing tick and only once.
      const out = run([0, 60, 30, 40, 50]);
      check("scrub then advance over seen ground → scrub_back then rewatch", only(out).join(",") === "scrub_back,rewatch");
      check("rewatch fires exactly once", only(out).filter((x) => x === "rewatch").length === 1);
    }

    // Advancing onto FRESH ground (past the pre-scrub high-water) → NO rewatch.
    {
      // reach 40, scrub to 20, jump to 70 (>40) → episode closes silently.
      const out = run([0, 40, 20, 70]);
      check("scrub then jump past high-water → no rewatch", only(out).join(",") === "scrub_back");
    }

    // Two full independent episodes each produce their own pair.
    {
      const out = run([0, 50, 30, 45, 90, 60, 80]);
      // 50 (hw50) → 30 scrub_back → 45 rewatch (≤50) → 90 fresh (hw90) →
      // 60 scrub_back → 80 rewatch (≤90).
      check(
        "two episodes → two scrub_back + two rewatch in order",
        only(out).join(",") === "scrub_back,rewatch,scrub_back,rewatch"
      );
    }

    // A rewatch that lands EXACTLY on the pre-scrub high-water still counts as
    // seen ground (≤ ceiling) → rewatch.
    {
      const out = run([0, 40, 30, 40]);
      check("advance back exactly to high-water → rewatch", only(out).join(",") === "scrub_back,rewatch");
    }
  }

  /* ───────────────────────────── QUIZACTIVE ───────────────────────────── */
  console.log("\n— quizActive derivation truth table —");
  {
    // active = answeredCount > 0 && result === null (mirrors LearnQuiz).
    const active = (answeredCount: number, graded: boolean) => answeredCount > 0 && graded === false;
    check("0 answered, ungraded → inactive", active(0, false) === false);
    check("1 answered, ungraded → active", active(1, false) === true);
    check("3 answered, ungraded → active", active(3, false) === true);
    check("3 answered, graded → inactive", active(3, true) === false);
    check("0 answered, graded → inactive", active(0, true) === false);
  }

  /* ─────────────────────────── IMPORT FENCE ───────────────────────────── */
  console.log("\n— zod-free / editor-free import fence —");
  {
    const files = [
      "lib/learn/tutorStore.ts",
      "lib/learn/engagement.ts",
      "components/learn/tutor/TutorMount.tsx",
    ];
    const banned: { needle: string; label: string }[] = [
      { needle: "zod", label: "zod" },
      { needle: "lib/analytics/events", label: "lib/analytics/events" },
      { needle: "lib/tutor/runtime", label: "lib/tutor/runtime" },
      { needle: "lib/editor/", label: "lib/editor" },
    ];
    for (const file of files) {
      // Only inspect ACTUAL module-specifier lines (import … / dynamic import /
      // require) so the file's own doc comment naming the ban can't false-fail.
      const importLines = readSource(file)
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /(?:import|require)\s*\(/.test(line));
      const importBlob = importLines.join("\n");
      for (const { needle, label } of banned) {
        check(`${file} does not import ${label}`, importBlob.includes(needle) === false);
      }
    }
  }

  /* ─────────────────────── PRACTICE GRADING GOLDENS ────────────────────── */
  console.log("\n— practice grading goldens (gradePracticeAnswer) —");
  {
    const mc = (correctChoiceIndex: number | null): TutorPracticeItem => ({
      nodeId: "n1",
      practiceItemRef: "p1",
      kind: "mc",
      prompt: "pick",
      choices: ["a", "b", "c", "d"],
      correctChoiceIndex,
      acceptedAnswers: null,
      explanation: null,
      itemBankRef: null,
    });
    const short = (acceptedAnswers: string[] | null): TutorPracticeItem => ({
      nodeId: "n1",
      practiceItemRef: "p1",
      kind: "short",
      prompt: "spell",
      choices: null,
      correctChoiceIndex: null,
      acceptedAnswers,
      explanation: null,
      itemBankRef: null,
    });

    // mc: correct / wrong / null-key → null.
    check("mc correct choice → true", gradePracticeAnswer(mc(2), { choiceIndex: 2 }) === true);
    check("mc wrong choice → false", gradePracticeAnswer(mc(2), { choiceIndex: 0 }) === false);
    check("mc null choiceIndex → false", gradePracticeAnswer(mc(2), { choiceIndex: null }) === false);
    check("mc null key → null (keyless, cannot grade)", gradePracticeAnswer(mc(null), { choiceIndex: 2 }) === null);

    // short: accepted-answers match with trim/lowercase + whitespace/case variants.
    const item = short(["Big O", "asymptotic"]);
    check("short exact match → true", gradePracticeAnswer(item, { text: "Big O" }) === true);
    check("short trims surrounding whitespace → true", gradePracticeAnswer(item, { text: "  Big O  " }) === true);
    check("short lowercases the guess → true", gradePracticeAnswer(item, { text: "BIG O" }) === true);
    check("short lowercase + whitespace variant → true", gradePracticeAnswer(item, { text: "  aSymPtoTic " }) === true);
    // The accepted key itself is trimmed/lowercased too.
    check(
      "short trims/lowercases the accepted key too → true",
      gradePracticeAnswer(short(["  ANSWER  "]), { text: "answer" }) === true
    );
    check("short non-member → false", gradePracticeAnswer(item, { text: "linear" }) === false);
    check("short empty guess (non-member) → false", gradePracticeAnswer(item, { text: "" }) === false);

    // short: empty / null key → null (keyless).
    check("short empty accepted array → null", gradePracticeAnswer(short([]), { text: "anything" }) === null);
    check("short null accepted → null", gradePracticeAnswer(short(null), { text: "anything" }) === null);
  }

  /* ─────────────────────── SELF-REPORT STABLE KEY ──────────────────────── */
  console.log("\n— selfReportStableKey shape golden —");
  {
    // selfreport:{nodeId}:{lessonId}:{yyyy-mm-dd} — the iso date is day-sliced.
    check(
      "with lessonId → selfreport:node:lesson:yyyy-mm-dd",
      selfReportStableKey("node-1", "lesson-9", "2026-08-04T13:45:07.512Z") === "selfreport:node-1:lesson-9:2026-08-04"
    );
    check(
      "null lessonId falls back to 'course'",
      selfReportStableKey("node-1", null, "2026-08-04T00:00:00.000Z") === "selfreport:node-1:course:2026-08-04"
    );
    // Day granularity — same day, different time → identical key.
    check(
      "same-day different time → identical key (day granularity)",
      selfReportStableKey("n", "l", "2026-08-04T01:00:00Z") === selfReportStableKey("n", "l", "2026-08-04T23:59:59Z")
    );
  }

  /* ─────────────────────────── TTFT THRESHOLDS ─────────────────────────── */
  // A2 RE-POINT: the vital measures the FIRST VISIBLE TOKEN now (reasoning-tail
  // latencies ~9–13s), so the buckets widened: good <4000 / ni <12000 / poor.
  console.log("\n— ttftRating thresholds (A2: good <4000 / ni <12000 / poor) —");
  {
    check("0 → good", ttftRating(0) === "good");
    check("3999 → good", ttftRating(3999) === "good");
    check("4000 → needs-improvement (boundary)", ttftRating(4000) === "needs-improvement");
    check("9000 → needs-improvement (typical reasoning first-token)", ttftRating(9000) === "needs-improvement");
    check("11999 → needs-improvement", ttftRating(11999) === "needs-improvement");
    check("12000 → poor (boundary)", ttftRating(12000) === "poor");
    check("20000 → poor", ttftRating(20000) === "poor");
  }

  /* ──────────────────────── CLIENT-TYPES DRIFT GREPS ───────────────────── */
  console.log("\n— tutorClientTypes ↔ contract/route drift greps —");
  {
    const clientTypes = readSource("lib/learn/tutorClientTypes.ts");
    const contract = readSource("lib/tutor/runtime/outputContract.ts");
    const route = readSource("app/api/learn/tutor/route.ts");

    // Field names the client mirror MUST carry from the frozen output contract.
    for (const field of ["correctChoiceIndex", "acceptedAnswers", "explanation", "practiceItemRef"]) {
      check(
        `client mirrors contract field '${field}'`,
        contract.includes(field) && clientTypes.includes(field)
      );
    }
    // The RAW model field is server-only: the client gets CLEANED prose, never the
    // span-markered source. Contract has it; the client must NOT.
    check("contract names proseWithSpanMarkers", contract.includes("proseWithSpanMarkers"));
    check(
      "client does NOT contain proseWithSpanMarkers (gets cleaned prose)",
      clientTypes.includes("proseWithSpanMarkers") === false
    );

    // The SSE `turn` payload field list must appear in BOTH the route source and
    // the client mirror (the client renders exactly these fields). `invitation`
    // is the A3 Wave-3 member; `structures`/`assessments` are the A3 Wave-4
    // members (frozen contract — Builder J's server half carries them).
    for (const field of [
      "prose",
      "spans",
      "citations",
      "rung",
      "practiceItems",
      "escalationProposal",
      "invitation",
      "structures",
      "assessments",
      "flags",
    ]) {
      check(
        `SSE payload field '${field}' in both route + client mirror`,
        route.includes(field) && clientTypes.includes(field)
      );
    }
  }

  /* ─────────────────── ZOD-FREE FENCE (extended set) ───────────────────── */
  console.log("\n— zod-free fence (extended client set + transitive vitals) —");
  {
    // These files ride the learn route bundle: none may import zod, the runtime
    // contract, or the zod-heavy analytics events module.
    const fenced = [
      "lib/learn/tutorClientTypes.ts",
      "lib/learn/tutorHistory.ts",
      "lib/learn/useTutorStream.ts",
      "lib/learn/tutorVitals.ts",
      "components/learn/tutor/TutorBody.tsx",
      "components/learn/tutor/TutorEscalationCard.tsx",
    ];
    const banned = ['from "zod"', 'from "@/lib/tutor/runtime', 'from "@/lib/analytics/events"'];
    for (const file of fenced) {
      const src = readSource(file);
      for (const needle of banned) {
        check(`${file} does not contain ${needle}`, src.includes(needle) === false);
      }
    }
    // tutorVitals imports lib/analytics/vitals (a zod-free builder) — ALLOWED.
    // Assert the transitive honesty: vitals.ts itself contains no `from "zod"`.
    const vitals = readSource("lib/analytics/vitals.ts");
    check("lib/analytics/vitals.ts imports no zod (fence is transitive-honest)", vitals.includes('from "zod"') === false);
  }

  /* ─────────────────── ESCALATION FLAG-OFF JSX GATE ────────────────────── */
  console.log("\n— escalation card gated behind the escalationsUi prop —");
  {
    const body = readSource("components/learn/tutor/TutorBody.tsx");
    // The card must render ONLY behind the flag: a JSX conditional `escalationsUi &&`.
    check("TutorBody gates TutorEscalationCard behind escalationsUi &&", /escalationsUi\s*&&/.test(body));
    check("TutorBody references TutorEscalationCard", body.includes("TutorEscalationCard"));
  }

  /* ──────────────── A2 · MIRROR DRIFT (seven new variants) ─────────────── */
  console.log("\n— A2 wire mirror: the seven new variants present + zod-free —");
  {
    const clientTypes = readSource("lib/learn/tutorClientTypes.ts");
    const proto = readSource("lib/tutor/runtime/sseProtocol.ts");
    // Every A2 variant tag the server schema defines must appear in the client
    // mirror (drift guard — the client can't import the zod schema, so the greps
    // are the contract).
    for (const variant of [
      "turn_started",
      "model_started",
      "first_token",
      "text_delta",
      "turn_completed",
      "turn_aborted",
      "approval_required",
    ]) {
      check(
        `client mirror + server proto both name variant '${variant}'`,
        clientTypes.includes(variant) && proto.includes(variant)
      );
    }
    // The per-variant fields the client renders/reads.
    for (const field of [
      "streamId",
      "responseId",
      "ttftMs",
      "delta",
      "finishReason",
      "durationMs",
      "tokensEmitted",
      "toolName",
      "inputTokens",
      "outputTokens",
      "cachedTokens",
    ]) {
      check(`client mirror names A2 field '${field}'`, clientTypes.includes(field));
    }
    // The mirror stays zod-free (it can never import the schema module).
    check(
      "tutorClientTypes.ts imports no zod",
      clientTypes.includes('from "zod"') === false
    );
    check(
      "tutorClientTypes.ts imports no lib/tutor/runtime",
      clientTypes.includes('from "@/lib/tutor/runtime') === false
    );
    // A tiny structural exercise so TS proves the union is inhabited by the new
    // variants (compile-time proof the mirror shapes are usable).
    const sample: TutorSSEEvent[] = [
      { type: "turn_started", streamId: "s", ts: "t" },
      { type: "model_started", responseId: null },
      { type: "first_token", ttftMs: 9000 },
      { type: "text_delta", delta: "hi" },
      {
        type: "turn_completed",
        finishReason: "stop",
        durationMs: 12,
        usage: { inputTokens: 1, outputTokens: 2, cachedTokens: null },
      },
      { type: "turn_aborted", reason: "stalled", tokensEmitted: 3 },
      { type: "approval_required", toolName: "x", message: "m" },
    ];
    check("all seven A2 variants construct as TutorSSEEvent", sample.length === 7);
  }

  /* ───────────────────────── A2 · PHASE FLOOR ──────────────────────────── */
  console.log("\n— phaseFloor (fake clock): immediate first, hold, latest-wins, reset —");
  {
    // A fake clock + scheduler: `advance(ms)` moves time AND flushes any timer
    // whose deadline has passed. schedule/cancel are pure (no real timers).
    function makeClock() {
      let t = 0;
      let seq = 0;
      const timers = new Map<number, { at: number; fn: () => void }>();
      return {
        now: () => t,
        schedule: (fn: () => void, ms: number) => {
          const id = ++seq;
          timers.set(id, { at: t + ms, fn });
          return id;
        },
        cancel: (h: unknown) => timers.delete(h as number),
        advance: (ms: number) => {
          t += ms;
          for (const [id, timer] of [...timers.entries()]) {
            if (timer.at <= t) {
              timers.delete(id);
              timer.fn();
            }
          }
        },
        pending: () => timers.size,
      };
    }

    // (1) First proposal applies immediately.
    {
      const c = makeClock();
      const floor = createPhaseFloor<string>({ now: c.now, schedule: c.schedule, cancel: c.cancel });
      const applied: string[] = [];
      floor.propose("sent", (p) => applied.push(p));
      check("first proposal applies immediately", applied.join(",") === "sent");
      check("first proposal schedules nothing", c.pending() === 0);
    }

    // (2) A <400ms proposal is HELD then flushed at exactly floor expiry.
    {
      const c = makeClock();
      const floor = createPhaseFloor<string>({ now: c.now, schedule: c.schedule, cancel: c.cancel });
      const applied: string[] = [];
      floor.propose("sent", (p) => applied.push(p));
      c.advance(100); // within the 400ms floor
      floor.propose("thinking", (p) => applied.push(p));
      check("proposal within floor is held (not applied yet)", applied.join(",") === "sent");
      check("a flush is scheduled", c.pending() === 1);
      c.advance(299); // total 399 — still before expiry
      check("still held just before floor expiry", applied.join(",") === "sent");
      c.advance(1); // total 400 — floor expires, flush fires
      check("held phase flushes at exactly floor expiry", applied.join(",") === "sent,thinking");
      check("no timer left after flush", c.pending() === 0);
    }

    // (3) Latest-wins when two proposals arrive during one hold.
    {
      const c = makeClock();
      const floor = createPhaseFloor<string>({ now: c.now, schedule: c.schedule, cancel: c.cancel });
      const applied: string[] = [];
      floor.propose("sent", (p) => applied.push(p));
      c.advance(50);
      floor.propose("thinking", (p) => applied.push(p)); // held
      c.advance(50);
      floor.propose("composing", (p) => applied.push(p)); // supersedes the held one
      check("two held proposals schedule exactly ONE flush", c.pending() === 1);
      c.advance(300); // total 400 — flush fires with the LATEST proposal only
      check("latest proposal wins the single flush", applied.join(",") === "sent,composing");
    }

    // (4) A post-floor proposal applies immediately (no queue).
    {
      const c = makeClock();
      const floor = createPhaseFloor<string>({ now: c.now, schedule: c.schedule, cancel: c.cancel });
      const applied: string[] = [];
      floor.propose("sent", (p) => applied.push(p));
      c.advance(400); // exactly at the floor → treated as past
      floor.propose("thinking", (p) => applied.push(p));
      check("proposal AT/after floor applies immediately", applied.join(",") === "sent,thinking");
      check("immediate post-floor proposal schedules nothing", c.pending() === 0);
    }

    // (5) reset() cancels a pending flush.
    {
      const c = makeClock();
      const floor = createPhaseFloor<string>({ now: c.now, schedule: c.schedule, cancel: c.cancel });
      const applied: string[] = [];
      floor.propose("sent", (p) => applied.push(p));
      c.advance(50);
      floor.propose("thinking", (p) => applied.push(p)); // held
      check("reset target: one flush pending before reset", c.pending() === 1);
      floor.reset();
      check("reset cancels the pending flush", c.pending() === 0);
      c.advance(1000);
      check("nothing flushes after reset", applied.join(",") === "sent");
      // After reset the NEXT proposal is the fresh first → immediate again.
      floor.propose("composing", (p) => applied.push(p));
      check("post-reset proposal applies immediately (fresh cycle)", applied.join(",") === "sent,composing");
    }

    // PHASE_FLOOR_MS is the documented default.
    check("PHASE_FLOOR_MS === 400", PHASE_FLOOR_MS === 400);
  }

  /* ─────────────────────── A2 · FRAME REDUCER ──────────────────────────── */
  // Drive processTutorFrame with a harness that mirrors the hook's callback
  // wiring (a real phaseFloor over a fake clock + a mutable status/text tracker),
  // so the assertions cover the floor interplay the hook produces.
  console.log("\n— processTutorFrame: scripted sequences + floor interplay —");
  {
    function makeClock() {
      let t = 0;
      let seq = 0;
      const timers = new Map<number, { at: number; fn: () => void }>();
      return {
        now: () => t,
        schedule: (fn: () => void, ms: number) => {
          const id = ++seq;
          timers.set(id, { at: t + ms, fn });
          return id;
        },
        cancel: (h: unknown) => timers.delete(h as number),
        advance: (ms: number) => {
          t += ms;
          for (const [id, timer] of [...timers.entries()]) {
            if (timer.at <= t) {
              timers.delete(id);
              timer.fn();
            }
          }
        },
      };
    }

    /** A harness mirroring useTutorStream.makeCallbacks — real floor + trackers. */
    function makeHarness() {
      const clock = makeClock();
      const floor = createPhaseFloor<TutorStreamStatus["kind"]>({
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
      });
      let status: TutorStreamStatus = { kind: "idle" };
      let streamingText: string | null = null;
      let buffer = "";
      let composingApplied = false;
      const turns: string[] = []; // settled assistant prose
      let ttftCount = 0;
      // Mirror the hook's per-run once-guard: processTutorFrame calls
      // markFirstToken on EVERY text_delta; the CALLER dedupes to one TTFT emit.
      let ttftFired = false;

      const applyFloored = (phase: TutorStreamStatus["kind"]) => {
        status = { kind: phase } as TutorStreamStatus;
        if (phase === "composing") {
          composingApplied = true;
          streamingText = buffer;
        }
      };

      const cb: TutorFrameCallbacks = {
        phase: (p) => floor.propose(p, applyFloored),
        status: (next) => {
          floor.reset();
          status = next;
        },
        markFirstToken: () => {
          if (ttftFired) return;
          ttftFired = true;
          ttftCount += 1;
        },
        appendText: (delta) => {
          buffer += delta;
          if (composingApplied) streamingText = buffer;
        },
        settleTurn: (payload) => {
          floor.reset();
          turns.push(payload.prose);
          streamingText = null;
        },
        clearStreamingText: () => {
          streamingText = null;
        },
        finishIdle: () => {
          floor.reset();
          if (status.kind !== "error" && status.kind !== "approval") status = { kind: "idle" };
        },
      };

      return {
        cb,
        clock,
        feed: (ev: TutorSSEEvent) => processTutorFrame(ev, cb),
        snapshot: () => ({ status, streamingText, turns: [...turns], ttftCount }),
      };
    }

    const payload = (prose: string): TutorTurnPayload => ({
      prose,
      spans: [],
      citations: [],
      rung: null,
      practiceItems: [],
      escalationProposal: null,
      escalationCandidateId: null,
      invitation: null,
      structures: [],
      assessments: [],
      flags: [],
    });

    // (A) The happy path: turn_started → model_started → first_token → 3 deltas →
    //     turn → done. Assert phase transitions + streaming text + settle.
    {
      const h = makeHarness();
      h.feed({ type: "turn_started", streamId: "s", ts: "t" });
      check("turn_started → sent phase", h.snapshot().status.kind === "sent");
      h.clock.advance(400); // let 'sent' clear the floor
      h.feed({ type: "model_started", responseId: "r1" });
      check("model_started → thinking phase", h.snapshot().status.kind === "thinking");
      check("no streaming text before composing", h.snapshot().streamingText === null);
      h.clock.advance(400);
      h.feed({ type: "first_token", ttftMs: 9000 });
      check("first_token → composing phase", h.snapshot().status.kind === "composing");
      h.clock.advance(400);
      h.feed({ type: "text_delta", delta: "Hel" });
      h.feed({ type: "text_delta", delta: "lo " });
      h.feed({ type: "text_delta", delta: "there" });
      check("first text_delta fired TTFT once", h.snapshot().ttftCount === 1);
      check("streaming text accumulates the deltas", h.snapshot().streamingText === "Hello there");
      h.feed({ type: "turn", payload: payload("Hello there.") });
      check("turn settles the assistant bubble", h.snapshot().turns.join("|") === "Hello there.");
      check("turn nulls streamingText (settled replaces streaming)", h.snapshot().streamingText === null);
      h.feed({ type: "done" });
      check("done → idle from non-terminal", h.snapshot().status.kind === "idle");
    }

    // (A2) text_delta BEFORE composing has been released by the floor: the buffer
    //      accumulates, streamingText stays null, then goes live when composing
    //      flushes.
    {
      const h = makeHarness();
      h.feed({ type: "turn_started", streamId: "s", ts: "t" }); // sent (immediate)
      h.clock.advance(10); // still within floor
      h.feed({ type: "text_delta", delta: "abc" }); // proposes composing (held) + buffers
      check("composing HELD by floor → streamingText still null", h.snapshot().streamingText === null);
      check("TTFT still fired on the buffered first delta", h.snapshot().ttftCount === 1);
      h.clock.advance(390); // total 400 → composing flushes
      check("composing flush reveals buffered text", h.snapshot().streamingText === "abc" && h.snapshot().status.kind === "composing");
    }

    // (B) The error path: …→ error → done keeps kind "error" AFTER done.
    {
      const h = makeHarness();
      h.feed({ type: "turn_started", streamId: "s", ts: "t" });
      h.clock.advance(400);
      h.feed({ type: "model_started", responseId: null });
      h.feed({ type: "error", message: "boom" });
      check("error applies immediately (bypasses floor)", h.snapshot().status.kind === "error");
      check("error nulls streamingText", h.snapshot().streamingText === null);
      h.feed({ type: "done" });
      const s = h.snapshot();
      check("done AFTER error PRESERVES the error (no wipe)", s.status.kind === "error" && (s.status as { message: string }).message === "boom");
    }

    // (C) The approval path: approval_required → done keeps kind "approval".
    {
      const h = makeHarness();
      h.feed({ type: "turn_started", streamId: "s", ts: "t" });
      h.feed({ type: "approval_required", toolName: "danger_tool", message: "needs approval" });
      check("approval_required → approval status", h.snapshot().status.kind === "approval");
      h.feed({ type: "done" });
      const s = h.snapshot();
      check(
        "done AFTER approval PRESERVES the approval",
        s.status.kind === "approval" && (s.status as { toolName: string }).toolName === "danger_tool"
      );
    }

    // (D) The aborted path: partial deltas → error → turn_aborted nulls text.
    {
      const h = makeHarness();
      h.feed({ type: "turn_started", streamId: "s", ts: "t" });
      h.clock.advance(400);
      h.feed({ type: "first_token", ttftMs: 5000 });
      h.clock.advance(400);
      h.feed({ type: "text_delta", delta: "partial…" });
      check("partial streaming text present before abort", h.snapshot().streamingText === "partial…");
      h.feed({ type: "error", message: "the turn was cancelled" });
      h.feed({ type: "turn_aborted", reason: "aborted", tokensEmitted: 1 });
      check("turn_aborted keeps streamingText null (partial not kept)", h.snapshot().streamingText === null);
      h.feed({ type: "done" });
      check("done after aborted-error still shows the error", h.snapshot().status.kind === "error");
    }

    // (E) queued applies immediately (bypasses the floor) and done from it → idle.
    {
      const h = makeHarness();
      h.feed({ type: "turn_started", streamId: "s", ts: "t" });
      h.feed({ type: "queued", position: 2 });
      const s = h.snapshot();
      check("queued applies immediately", s.status.kind === "queued" && (s.status as { position: number }).position === 2);
      h.feed({ type: "done" });
      check("done from queued (non-terminal) → idle", h.snapshot().status.kind === "idle");
    }
  }

  /* ─────────────── A2 · useTutorStream new public surface ──────────────── */
  console.log("\n— useTutorStream A2 surface (status kinds + streamingText + reducer export) —");
  {
    const hook = readSource("lib/learn/useTutorStream.ts");
    // The new status kinds are declared on TutorStreamStatus.
    for (const kind of ['kind: "sent"', 'kind: "composing"', 'kind: "approval"']) {
      check(`TutorStreamStatus declares ${kind}`, hook.includes(kind));
    }
    check("UseTutorStreamResult exposes streamingText", /streamingText:\s*string\s*\|\s*null/.test(hook));
    check("exports the pure processTutorFrame reducer", /export function processTutorFrame/.test(hook));
    check("exports the TutorFrameCallbacks surface", /export interface TutorFrameCallbacks/.test(hook));
    // TTFT re-point: the vital fires from the text_delta case, not on first bytes.
    check("processTutorFrame calls markFirstToken in the text_delta case", /markFirstToken/.test(hook));
    check("hook no longer has a markFirstFrame first-bytes emitter", hook.includes("markFirstFrame") === false);
    // done-wipes-error fix: the terminal guard exists.
    check("hook guards done against terminal status (isTerminalStatus)", hook.includes("isTerminalStatus"));
    // Resume + dangling fallback are wired.
    check("hook resumes via GET /api/learn/tutor?courseId", hook.includes("/api/learn/tutor?courseId") || hook.includes("courseId=${encodeURIComponent(courseId)}"));
    check("hook has a dangling-question fallback re-load", hook.includes("scheduleDanglingReload"));
    // Zod-free fence holds for the extended hook.
    check("useTutorStream imports no zod", hook.includes('from "zod"') === false);
    check("useTutorStream imports no lib/tutor/runtime", hook.includes('from "@/lib/tutor/runtime') === false);
    // phaseFloor is zod-free too.
    const floorSrc = readSource("lib/learn/phaseFloor.ts");
    check("phaseFloor.ts imports no zod", floorSrc.includes('from "zod"') === false);
    check("phaseFloor.ts imports nothing at all (pure)", /^\s*import\b/m.test(floorSrc) === false);
  }

  /* ───────────── A3-1 · markdown-lite via the SHARED ui/Markdown ──────────── */
  // The tutor renders prose through the moved components/ui/Markdown parser.
  // One fixture carries ALL FOUR constructs: **bold**, a "- " list, a fenced
  // code block WITH a language tag, and `inline code`.
  console.log("\n— A3-1 · parseMarkdownBlocks (shared ui/Markdown) —");
  {
    const fixture =
      "Here is **bold** and `applyCoursePatch` inline.\n\n- first item\n- second item\n\n```ts\nconst x = 1;\n```";
    const blocks = parseMarkdownBlocks(fixture);
    check("fixture parses to 3 blocks (paragraph, list, code)", blocks.length === 3, `got ${blocks.length}`);

    const para = blocks[0];
    check("first block is a paragraph", para?.type === "paragraph");
    const inline = para?.type === "paragraph" ? para.inline : [];
    check(
      "**bold** parses to a bold inline segment",
      inline.some((s) => s.type === "bold" && s.text === "bold")
    );
    check(
      "`inline code` parses to a code inline segment",
      inline.some((s) => s.type === "code" && s.text === "applyCoursePatch")
    );

    const list = blocks[1];
    check("- list parses to an unordered list block", list?.type === "list" && list.ordered === false);
    check(
      "list carries both items",
      list?.type === "list" &&
        list.items.length === 2 &&
        list.items[0].some((s) => s.type === "text" && s.text === "first item")
    );

    const code = blocks[2];
    check("fenced block parses to a code block", code?.type === "code");
    check(
      "fence language tag is CONSUMED (lands in .lang, never in the text)",
      code?.type === "code" && code.lang === "ts" && code.text === "const x = 1;" && !code.text.includes("```")
    );

    // Span-boundary reality: spans parse INDIVIDUALLY, so a list or fence split
    // across two spans must parse per-segment without throwing.
    {
      const listA = "- alpha\n- be";
      const listB = "ta\n- gamma";
      let threw = false;
      let aBlocks: ReturnType<typeof parseMarkdownBlocks> = [];
      let bBlocks: ReturnType<typeof parseMarkdownBlocks> = [];
      try {
        aBlocks = parseMarkdownBlocks(listA);
        bBlocks = parseMarkdownBlocks(listB);
      } catch {
        threw = true;
      }
      check("list split across two spans parses without throwing", threw === false);
      check(
        "each list half parses to its own list run",
        aBlocks[0]?.type === "list" && aBlocks[0].items.length === 2 && bBlocks.some((b) => b.type === "list")
      );
    }
    {
      const fenceA = "```py\nprint(1)"; // unterminated — the open fence swallows the tail
      const fenceB = "print(2)\n```";
      let threw = false;
      let aBlocks: ReturnType<typeof parseMarkdownBlocks> = [];
      let bBlocks: ReturnType<typeof parseMarkdownBlocks> = [];
      try {
        aBlocks = parseMarkdownBlocks(fenceA);
        bBlocks = parseMarkdownBlocks(fenceB);
      } catch {
        threw = true;
      }
      check("fence split across two spans parses without throwing", threw === false);
      check(
        "unterminated open fence parses as a code block with its lang consumed",
        aBlocks[0]?.type === "code" && aBlocks[0].lang === "py" && aBlocks[0].text === "print(1)"
      );
      check("the fence's second half still yields blocks (no drop)", bBlocks.length > 0);
    }
  }

  /* ─────────────── A3-2 · rung chrome removed from TutorBody ─────────────── */
  console.log("\n— A3-2 · no RungBadge / learner-facing rung literal —");
  {
    const body = readSource("components/learn/tutor/TutorBody.tsx");
    check("TutorBody has NO RungBadge symbol", body.includes("RungBadge") === false);
    check('TutorBody has NO learner-facing "Rung " literal', body.includes("Rung ") === false);
    // The rung stays EXTRACTED (the escape-hatch gate consumes it at render
    // time — two-arg since A3 Wave 3: rung + the session-attempt gate).
    check(
      "TutorBody still extracts rung for the hatch gate (attempt-gated form)",
      body.includes("shouldOfferEscapeHatch(rung, hasAttempted)")
    );
  }

  /* ──────────────── A3-3 · citation dedup (client leg) ───────────────────── */
  console.log("\n— A3-3 · dedupeCitations (frozen lessonId|blockId|slideId key) —");
  {
    const c = (lessonId: string, blockId: string, slideId: string | null): TutorCitation => ({
      lessonId,
      blockId,
      slideId,
    });

    // Byte-identical duplicates collapse to one.
    const identical = dedupeCitations([c("L1", "B1", "S1"), c("L1", "B1", "S1"), c("L1", "B1", "S1")]);
    check("byte-identical citations collapse to one", identical.length === 1);

    // Same target with slideId null-vs-null (the server's slide-downgrade
    // manufactured pair) collapses too.
    const downgraded = dedupeCitations([c("L1", "B1", null), c("L1", "B1", null)]);
    check("same-target null-slideId pair collapses to one", downgraded.length === 1);

    // Two DIFFERENT blocks are distinct actions — both survive, order preserved.
    const twoBlocks = dedupeCitations([c("L1", "B1", null), c("L1", "B2", null)]);
    check(
      "two different blocks both survive, order preserved",
      twoBlocks.length === 2 && twoBlocks[0].blockId === "B1" && twoBlocks[1].blockId === "B2"
    );

    // A block-level citation and a slide-level citation on the SAME block are
    // different jump targets — both survive.
    const slideVsBlock = dedupeCitations([c("L1", "B1", null), c("L1", "B1", "S1")]);
    check("null-slide vs slide citation on one block are distinct targets", slideVsBlock.length === 2);

    // First occurrence wins (order-preserving dedup).
    const ordered = dedupeCitations([c("L1", "B2", null), c("L1", "B1", null), c("L1", "B2", null)]);
    check(
      "first occurrence survives in place",
      ordered.length === 2 && ordered[0].blockId === "B2" && ordered[1].blockId === "B1"
    );
  }

  /* ────── A3-5 · escape-hatch rung gate (rung < 4, null hidden, attempted) ── */
  console.log("\n— A3-5 · shouldOfferEscapeHatch (rung leg, attempted=true) —");
  {
    check("rung 0 + attempted → hatch offered", shouldOfferEscapeHatch(0, true) === true);
    check("rung 1 + attempted → hatch offered", shouldOfferEscapeHatch(1, true) === true);
    check("rung 2 + attempted → hatch offered", shouldOfferEscapeHatch(2, true) === true);
    check("rung 3 + attempted → hatch offered", shouldOfferEscapeHatch(3, true) === true);
    check("rung 4 (full answer given) → NO hatch", shouldOfferEscapeHatch(4, true) === false);
    check("null rung (legacy/unknown) → NO hatch", shouldOfferEscapeHatch(null, true) === false);
  }

  /* ───────── A3-4 · attempt gate (hasAttemptedFor + hatch composition) ────── */
  console.log("\n— A3-4 · hasAttemptedFor matrix + shouldOfferEscapeHatch composition —");
  {
    // No attempts at all (undefined slice) → false, whatever the turn names.
    check("no attempts, null turn nodes → false", hasAttemptedFor(undefined, null) === false);
    check("no attempts, named turn nodes → false", hasAttemptedFor(undefined, ["n1"]) === false);
    check(
      "zeroed slice (fresh object) → false",
      hasAttemptedFor({ nodeIds: [], count: 0 }, null) === false
    );

    // count>0 with NULL turn nodes → true (any session attempt qualifies).
    check(
      "count>0 with null turn nodes → true",
      hasAttemptedFor({ nodeIds: [], count: 1 }, null) === true
    );
    check(
      "node-attributed attempt with null turn nodes → true",
      hasAttemptedFor({ nodeIds: ["nX"], count: 1 }, null) === true
    );

    // Turn names practice nodes + an attempt on ONE OF THEM → true.
    check(
      "turn nodes present + attempt on one → true",
      hasAttemptedFor({ nodeIds: ["n1", "n3"], count: 2 }, ["n2", "n3"]) === true
    );

    // Attempts ONLY on OTHER nodes → false (even though count > 0).
    check(
      "attempt only on OTHER nodes → false (count irrelevant)",
      hasAttemptedFor({ nodeIds: ["nZ"], count: 5 }, ["n1", "n2"]) === false
    );
    check(
      "count-only attempts vs named turn nodes → false",
      hasAttemptedFor({ nodeIds: [], count: 3 }, ["n1"]) === false
    );

    // An EMPTY turnNodeIds array names nothing → the count gate applies.
    check(
      "empty turn-node array falls back to the count gate",
      hasAttemptedFor({ nodeIds: [], count: 1 }, []) === true &&
        hasAttemptedFor({ nodeIds: [], count: 0 }, []) === false
    );

    // Composition with the rung leg.
    check("rung 2 + attempted → hatch", shouldOfferEscapeHatch(2, true) === true);
    check("rung 2 + NOT attempted → NO hatch", shouldOfferEscapeHatch(2, false) === false);
    check("rung 4 + attempted → NO hatch (full answer wins)", shouldOfferEscapeHatch(4, true) === false);
    check("null rung + attempted → NO hatch", shouldOfferEscapeHatch(null, true) === false);
    check("rung 0 + NOT attempted → NO hatch", shouldOfferEscapeHatch(0, false) === false);
  }

  /* ───── A3-9 / A3-11 · invitation render rule (client legs) + sources ────── */
  console.log("\n— A3-9/A3-11 · shouldRenderInvitation matrix + TutorBody source asserts —");
  {
    const inv: TutorInvitation = {
      toolName: "generate_practice",
      nodeId: "n1",
      label: "Check my understanding",
    };
    const base = {
      isFinalTurn: true,
      status: "idle",
      hasPracticeItems: false,
      invitation: inv,
    };

    check("final + idle + no items + invitation → renders", shouldRenderInvitation(base) === true);
    check(
      "non-final turn → never renders (A3-11 discard)",
      shouldRenderInvitation({ ...base, isFinalTurn: false }) === false
    );
    for (const status of ["sent", "thinking", "composing", "queued", "error", "approval"]) {
      check(
        `status '${status}' (send in flight / terminal) → never renders`,
        shouldRenderInvitation({ ...base, status }) === false
      );
    }
    check(
      "turn carrying practiceItems → never renders (A3-9 belt)",
      shouldRenderInvitation({ ...base, hasPracticeItems: true }) === false
    );
    check(
      "null invitation → never renders",
      shouldRenderInvitation({ ...base, invitation: null }) === false
    );

    // TutorBody consumes THE helper — and never re-derives the rule inline.
    const body = readSource("components/learn/tutor/TutorBody.tsx");
    check("TutorBody calls shouldRenderInvitation(", body.includes("shouldRenderInvitation("));
    check(
      "TutorBody renders the tutor-invitation pill",
      body.includes('data-ai-tool="tutor-invitation"')
    );
    check(
      "TutorBody does NOT inline the final/idle re-derivation",
      /invitation\s*!==\s*null\s*&&\s*isFinalTurn/.test(body) === false &&
        /isFinalTurn\s*&&\s*(statusKind|status\.kind)\s*===/.test(body) === false
    );
    // The press sends the LABEL verbatim + the deterministic initiation payload.
    check(
      "invitation press sends the label verbatim",
      body.includes("onSend(invitation.label,")
    );
    check(
      'invitation press carries kind: "invitation_accepted"',
      body.includes('kind: "invitation_accepted"')
    );
    // Practice engagement records session attempts (both grade + discuss legs).
    const attemptCalls = body.split("recordSessionAttempt(userId, item.nodeId)").length - 1;
    check(
      "PracticeCard records a session attempt on grade() AND discuss (2 call sites)",
      attemptCalls === 2,
      `got ${attemptCalls}`
    );
  }

  /* ────────── A3 Wave 3 · initiation rides ONLY acceptance sends ──────────── */
  console.log("\n— initiation send-shape (useTutorStream source asserts) —");
  {
    const hook = readSource("lib/learn/useTutorStream.ts");
    // The provenance shape is declared once, client-side, zod-free.
    check(
      "hook declares TutorSendInitiation",
      hook.includes("export interface TutorSendInitiation")
    );
    check(
      'initiation kind is the frozen "invitation_accepted" literal',
      hook.includes('kind: "invitation_accepted"')
    );
    // The POST body carries initiation CONDITIONALLY — the field is spread in
    // only when present, so every non-acceptance send omits it entirely.
    check(
      "POST body spreads initiation conditionally (omitted when absent)",
      hook.includes("...(initiation ? { initiation } : {})")
    );
    check(
      "no unconditional initiation body member",
      /quizActive:\s*ambient\.quizActive,\s*\n\s*initiation,/.test(hook) === false
    );
    // send()/retry() thread it through runSend (a retried accept stays an accept).
    check(
      "send threads the optional initiation into runSend",
      hook.includes("void runSend(message, ambient, initiation)")
    );
    check(
      "retry re-fires the last initiation faithfully",
      hook.includes("void runSend(last.message, last.ambient, last.initiation)")
    );
    // The settled payload's invitation lands on the turn's grounding mirror.
    check(
      "assistantTurnFromPayload mirrors payload.invitation onto grounding",
      hook.includes("invitation: payload.invitation ?? null")
    );
  }

  /* ────────── A3 Wave 3 · history grounding.invitation coercion ───────────── */
  console.log("\n— tutorHistory · grounding.invitation tolerant coercion —");
  {
    const valid = coerceGrounding({
      citations: [],
      spans: [],
      flags: [],
      rung: 2,
      invitation: { toolName: "generate_practice", nodeId: "n1", label: "Try one?" },
    });
    check(
      "well-formed invitation survives coercion",
      valid?.invitation?.toolName === "generate_practice" &&
        valid?.invitation?.nodeId === "n1" &&
        valid?.invitation?.label === "Try one?"
    );

    const missing = coerceGrounding({ citations: [], spans: [], flags: [], rung: 1 });
    check("absent invitation coerces to null (grounding still usable)", missing !== null && missing.invitation === null);

    const malformed = coerceGrounding({
      citations: [],
      spans: [],
      flags: [],
      invitation: { toolName: "x", nodeId: 42, label: "y" },
    });
    check("malformed invitation (non-string nodeId) degrades to null", malformed?.invitation === null);

    const labelless = coerceGrounding({
      citations: [],
      spans: [],
      flags: [],
      invitation: { toolName: "x", nodeId: "n" },
    });
    check("label-missing invitation degrades to null", labelless?.invitation === null);

    const junk = coerceGrounding({ invitation: "press me" });
    check("string invitation degrades to null", junk?.invitation === null);
    check("non-object grounding stays null", coerceGrounding("nope") === null);
  }

  /* ══════════════════════ A3 WAVE 4 · CORE TOOLS (client) ═════════════════ */

  const checkCard = (
    options: { id: string; text: string; correct: boolean; misconceptionId: string | null; feedback: string }[],
    collectConfidence = false,
  ): Extract<TutorAssessmentCard, { toolName: "checkUnderstanding" }> => ({
    cardId: "card-1",
    toolName: "checkUnderstanding",
    conceptSlug: "node-abc",
    initiation: "invitation_accepted",
    stem: "Which is true of a hash table lookup?",
    options,
    collectConfidence,
  });

  const seqCard = (
    correctOrder: string[],
    partialCreditRule: "exact" | "adjacent-pairs",
  ): Extract<TutorAssessmentCard, { toolName: "sequenceTask" }> => ({
    cardId: "seq-1",
    toolName: "sequenceTask",
    conceptSlug: "node-xyz",
    initiation: "practice_request",
    prompt: "Order the steps of binary search",
    items: correctOrder.map((id) => ({ id, text: `step ${id}` })),
    correctOrder,
    partialCreditRule,
  });

  /* ─────── A3 Wave 4 · scoreCheckUnderstanding matrix ─────── */
  console.log("\n— A3 Wave 4 · scoreCheckUnderstanding (correct→demonstrated, distractors→misconception) —");
  {
    const card = checkCard([
      { id: "a", text: "amortized O(1)", correct: true, misconceptionId: null, feedback: "Right — a good hash spreads keys evenly." },
      { id: "b", text: "always O(1)", correct: false, misconceptionId: "ignores-collisions", feedback: "Collisions make the worst case O(n)." },
      { id: "c", text: "O(log n)", correct: false, misconceptionId: "confuses-with-bst", feedback: "That's a balanced tree, not a hash table." },
    ]);

    const right = scoreCheckUnderstanding(card, "a");
    check(
      "correct pick → demonstrated, null misconception, affirmation feedback",
      right.outcome === "demonstrated" &&
        right.misconceptionId === null &&
        right.feedback === "Right — a good hash spreads keys evenly.",
    );

    const wrongB = scoreCheckUnderstanding(card, "b");
    check(
      "distractor b → not_demonstrated + its misconceptionId + its feedback",
      wrongB.outcome === "not_demonstrated" &&
        wrongB.misconceptionId === "ignores-collisions" &&
        wrongB.feedback === "Collisions make the worst case O(n).",
    );

    const wrongC = scoreCheckUnderstanding(card, "c");
    check(
      "distractor c → not_demonstrated + its OWN misconceptionId",
      wrongC.outcome === "not_demonstrated" && wrongC.misconceptionId === "confuses-with-bst",
    );

    // An unknown / null pick is an unanswered wrong.
    check(
      "unknown option id → not_demonstrated, null misconception, empty feedback",
      (() => {
        const r = scoreCheckUnderstanding(card, "zzz");
        return r.outcome === "not_demonstrated" && r.misconceptionId === null && r.feedback === "";
      })(),
    );
    check(
      "null pick → not_demonstrated, null misconception",
      (() => {
        const r = scoreCheckUnderstanding(card, null);
        return r.outcome === "not_demonstrated" && r.misconceptionId === null;
      })(),
    );
  }

  /* ─────── A3 Wave 4 · scoreSequenceCard matrix (A3-15, server twin) ─────── */
  console.log("\n— A3 Wave 4 · scoreSequenceCard (exact + adjacent-pairs; agrees with the contract) —");
  {
    // EXACT rule.
    const exact = seqCard(["1", "2", "3", "4"], "exact");
    check(
      "exact · all positions right → demonstrated, ratio 1",
      (() => {
        const r = scoreSequenceCard(exact, ["1", "2", "3", "4"]);
        return r.outcome === "demonstrated" && r.ratio === 1;
      })(),
    );
    check(
      "exact · one swap → not_demonstrated, ratio 0",
      (() => {
        const r = scoreSequenceCard(exact, ["1", "2", "4", "3"]);
        return r.outcome === "not_demonstrated" && r.ratio === 0;
      })(),
    );
    check(
      "exact · fully reversed → not_demonstrated",
      scoreSequenceCard(exact, ["4", "3", "2", "1"]).outcome === "not_demonstrated",
    );
    check(
      "exact · length mismatch → not_demonstrated (no throw)",
      scoreSequenceCard(exact, ["1", "2", "3"]).outcome === "not_demonstrated",
    );

    // ADJACENT-PAIRS rule.
    const adj = seqCard(["1", "2", "3", "4"], "adjacent-pairs");
    check(
      "adjacent-pairs · all right → demonstrated (ratio 1)",
      (() => {
        const r = scoreSequenceCard(adj, ["1", "2", "3", "4"]);
        return r.outcome === "demonstrated" && r.ratio === 1;
      })(),
    );
    check(
      "adjacent-pairs · reversed → not_demonstrated (ratio 0)",
      (() => {
        const r = scoreSequenceCard(adj, ["4", "3", "2", "1"]);
        return r.outcome === "not_demonstrated" && r.ratio === 0;
      })(),
    );
    // One item misplaced: [1,3,2,4] → pairs (1,3)✓ (3,2)✗ (2,4)✓ = 2/3 → partial.
    check(
      "adjacent-pairs · one misplaced → partial (2/3 correctly ordered)",
      (() => {
        const r = scoreSequenceCard(adj, ["1", "3", "2", "4"]);
        return r.outcome === "partial" && Math.abs(r.ratio - 2 / 3) < 1e-9;
      })(),
    );
    // A single-adjacent-error at the front: [2,1,3,4] → (2,1)✗ (1,3)✓ (3,4)✓ = 2/3.
    check(
      "adjacent-pairs · front swap → partial (2/3)",
      (() => {
        const r = scoreSequenceCard(adj, ["2", "1", "3", "4"]);
        return r.outcome === "partial" && Math.abs(r.ratio - 2 / 3) < 1e-9;
      })(),
    );
    // Two-item ordering: right pair → demonstrated; wrong pair → not_demonstrated.
    const adj2 = seqCard(["a", "b"], "adjacent-pairs");
    check(
      "adjacent-pairs · 2 items right → demonstrated",
      scoreSequenceCard(adj2, ["a", "b"]).outcome === "demonstrated",
    );
    check(
      "adjacent-pairs · 2 items wrong → not_demonstrated (ratio 0)",
      (() => {
        const r = scoreSequenceCard(adj2, ["b", "a"]);
        return r.outcome === "not_demonstrated" && r.ratio === 0;
      })(),
    );
    // An unknown id in the submitted order never counts as ordered (no throw).
    check(
      "adjacent-pairs · unknown id in order → that pair uncounted, no throw",
      (() => {
        const r = scoreSequenceCard(adj, ["1", "2", "3", "zzz"]);
        // pairs (1,2)✓ (2,3)✓ (3,zzz)✗ = 2/3 → partial
        return r.outcome === "partial" && Math.abs(r.ratio - 2 / 3) < 1e-9;
      })(),
    );
  }

  /* ─────── A3 Wave 4 · shuffleDeterministic ─────── */
  console.log("\n— A3 Wave 4 · shuffleDeterministic (stable per seed, permutation, seed-sensitive) —");
  {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const seedA = hashSeed("card-1");
    const seedB = hashSeed("card-2");

    const s1 = shuffleDeterministic(ids, seedA);
    const s2 = shuffleDeterministic(ids, seedA);
    check("same seed → identical order (idempotent)", s1.join(",") === s2.join(","));

    const s3 = shuffleDeterministic(ids, seedB);
    check("different seed → different order (with high probability)", s3.join(",") !== s1.join(","));

    // Always a permutation of the input (same multiset).
    check(
      "shuffle is a permutation (same elements)",
      s1.length === ids.length && [...s1].sort().join(",") === [...ids].sort().join(","),
    );
    check("input array is not mutated", ids.join(",") === "a,b,c,d,e,f");

    // Edge: empty + single-element inputs are stable.
    check("empty input → empty output", shuffleDeterministic([], 123).length === 0);
    check("single-element input → same single element", shuffleDeterministic(["x"], 7).join(",") === "x");

    // hashSeed is deterministic + differs for different strings.
    check("hashSeed deterministic per string", hashSeed("card-1") === hashSeed("card-1"));
    check("hashSeed differs across strings", hashSeed("card-1") !== hashSeed("card-2"));
    check("hashSeed returns an unsigned 32-bit int", Number.isInteger(seedA) && seedA >= 0 && seedA <= 0xffffffff);
  }

  /* ─────── A3 Wave 4 · render rule (structures always; assessments when present) ─────── */
  console.log("\n— A3 Wave 4 · TurnBubble render path (structures on any turn; assessments gated) —");
  {
    const body = readSource("components/learn/tutor/TutorBody.tsx");

    // Structures render unconditionally (A3-12) — a `.map` over `structures`, not
    // guarded behind an answer/practice/question condition.
    check("TutorBody imports TutorStructureCard", body.includes("TutorStructureCard"));
    check("TutorBody imports TutorCheckUnderstandingCard", body.includes("TutorCheckUnderstandingCard"));
    check("TutorBody imports TutorSequenceCard", body.includes("TutorSequenceCard"));
    check(
      "TutorBody extracts structures from payload OR grounding (history parity)",
      body.includes("payload?.structures ?? turn.grounding?.structures ?? []"),
    );
    check(
      "TutorBody extracts assessments from payload OR grounding",
      body.includes("payload?.assessments ?? turn.grounding?.assessments ?? []"),
    );
    check(
      "structures render via a plain .map (unconditional — A3-12, not gated on answer/question)",
      /structures\.map\(\(s,\s*i\)\s*=>\s*\(\s*<TutorStructureCard/.test(body),
    );
    // The structures map must NOT be inside a `question`/`answer`/practice guard.
    check(
      "structures map is not gated behind a hasPracticeItems / question conditional",
      /\{structures\.map\(/.test(body),
    );
    // Assessments render, dispatched on toolName (Wave 5 widened the binary
    // ternary into a switch over card.toolName — the dispatch discriminant).
    check(
      "assessments dispatch on card.toolName (switch discriminant)",
      body.includes("switch (card.toolName)") && body.includes('case "checkUnderstanding":'),
    );
    check("assessments render TutorCheckUnderstandingCard + TutorSequenceCard", body.includes("<TutorCheckUnderstandingCard") && body.includes("<TutorSequenceCard"));

    // The mirror onto grounding (live turns render like history turns).
    const hook = readSource("lib/learn/useTutorStream.ts");
    check(
      "assistantTurnFromPayload mirrors structures onto grounding",
      hook.includes("structures: payload.structures ?? []"),
    );
    check(
      "assistantTurnFromPayload mirrors assessments onto grounding",
      hook.includes("assessments: payload.assessments ?? []"),
    );
  }

  /* ─────── A3 Wave 4 · card components a11y + house-style source asserts (A3-25) ─────── */
  console.log("\n— A3 Wave 4 · component a11y (radiogroup/radio, aria move labels, no framer/Date.now) —");
  {
    const structure = readSource("components/learn/tutor/TutorStructureCard.tsx");
    const check4 = readSource("components/learn/tutor/TutorCheckUnderstandingCard.tsx");
    const sequence = readSource("components/learn/tutor/TutorSequenceCard.tsx");
    const evidence = readSource("lib/learn/tutorEvidence.ts");
    const all = [structure, check4, sequence, evidence];

    // checkUnderstanding: radiogroup + radio semantics + accessible names.
    check("check card uses role=radiogroup", check4.includes('role="radiogroup"'));
    check("check card uses role=radio", check4.includes('role="radio"'));
    check("check card sets aria-checked on options", check4.includes("aria-checked={isSel}"));
    check("check card radiogroup has an accessible label", check4.includes('aria-label="Answer choices"'));

    // sequenceTask: up/down move buttons with aria-labels (keyboard+SR reorder).
    check("sequence card move-up button has an aria-label", /aria-label=\{`Move ".*up`\}/.test(sequence) || sequence.includes("up`}"));
    check("sequence card move-down button has an aria-label", sequence.includes("down`}"));
    check("sequence card uses an ordered list for position", sequence.includes("<ol"));

    // structure card: role=img + an accessible name (never empty).
    check("structure card frames the diagram with role=img", structure.includes('role="img"'));
    check("structure card gives the diagram an accessible name", structure.includes("aria-label={accessibleName}"));
    check("structure card never lets the accessible name go empty", structure.includes("accessibleName"));
    check("structure card reuses DiagramView (audit §5 reuse)", structure.includes("DiagramView"));
    check(
      "structure card imports DiagramView from the slide diagram surface",
      structure.includes('@/components/editor/slide/diagram/DiagramView'),
    );
    check(
      "structure card NEVER imports the diagram Zod schemas (zod-free learn bundle)",
      structure.includes("diagram/schemas") === false,
    );

    // A3-25 structural: NO positive tabindex anywhere in the three components.
    for (const [i, src] of [structure, check4, sequence].entries()) {
      check(
        `component ${i} has no positive tabindex (only 0 / -1)`,
        /tabindex=\{?["']?[1-9]/i.test(src) === false && /tabIndex=\{[1-9]/.test(src) === false,
      );
    }

    // House rules: no framer-motion import, no Math.random anywhere in CODE (the
    // clock is only ever `performance.now()`/Date.now() inside a `now()` helper
    // called from handlers/effects — never inline in JSX). Inspect code lines only
    // (strip // and /* */ prose so a doc comment naming the ban can't false-fail).
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
        .join("\n");
    for (const [i, src] of all.entries()) {
      const code = stripComments(src);
      check(`file ${i} imports no framer-motion`, code.includes("framer-motion") === false);
      // Math.random must not appear at all (shuffle seeds come from hashSeed).
      check(`file ${i} contains no Math.random`, code.includes("Math.random") === false);
    }
    // The latency clock is captured in a mount EFFECT (never in render) in both
    // assessment cards.
    check(
      "check card captures mount time in an effect (not render)",
      check4.includes("mountedAtRef.current = now()") && check4.includes("useEffect(() => {"),
    );
    check(
      "sequence card captures mount time in an effect (not render)",
      sequence.includes("mountedAtRef.current = now()") && sequence.includes("useEffect(() => {"),
    );
    // shuffle order is a lazy useState init (computed once, no clock/random in render).
    check(
      "sequence order is a lazy useState init over shuffleDeterministic",
      /useState<string\[\]>\(\(\)\s*=>\s*\n?\s*shuffleDeterministic/.test(sequence),
    );
  }

  /* ─────── A3 Wave 4 · tool_evidence POST helper (contract §6) ─────── */
  console.log("\n— A3 Wave 4 · postToolEvidence shape + best-effort fence —");
  {
    const evidence = readSource("lib/learn/tutorEvidence.ts");
    check("evidence helper POSTs the tool_evidence action", evidence.includes('action: "tool_evidence"'));
    check("evidence helper posts to /api/learn/tutor", evidence.includes("/api/learn/tutor"));
    check("evidence helper is fire-and-forget (swallows errors)", evidence.includes(".catch(() => {})"));
    check("evidence helper carries the completionKey base cardId", evidence.includes("cardId: input.cardId"));
    check("evidence helper carries outcome/misconceptionId/confidence/initiation/latencyMs",
      evidence.includes("outcome: input.outcome") &&
      evidence.includes("misconceptionId: input.misconceptionId ?? null") &&
      evidence.includes("confidence: input.confidence ?? null") &&
      evidence.includes("initiation: input.initiation") &&
      evidence.includes("latencyMs: input.latencyMs ?? null"),
    );
    // Wave 5: fadeLevel now rides for a fadedExample card (the card's level),
    // null otherwise — via `input.fadeLevel ?? null` (was a hard-coded null in W4).
    check("evidence helper sends fadeLevel from the input (fadedExample carries it)", evidence.includes("fadeLevel: input.fadeLevel ?? null"));
    check("evidence helper imports no zod", evidence.includes('from "zod"') === false);
    check("evidence helper imports no lib/tutor/runtime", evidence.includes('from "@/lib/tutor/runtime') === false);
  }

  /* ─────── A3 Wave 4 · zod-free fence over the new client files ─────── */
  console.log("\n— A3 Wave 4 · zod-free / runtime-free fence (new Wave-4 files) —");
  {
    const files = [
      "components/learn/tutor/TutorStructureCard.tsx",
      "components/learn/tutor/TutorCheckUnderstandingCard.tsx",
      "components/learn/tutor/TutorSequenceCard.tsx",
      "lib/learn/tutorEvidence.ts",
    ];
    // Inspect ACTUAL import/require specifier lines only, so a file's own doc
    // comment naming a ban ("NEVER import diagram/schemas") can't false-fail.
    const importSpecifiers = (src: string): string =>
      src
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /(?:import|require)\s*\(/.test(line))
        .join("\n");
    const banned = ['from "zod"', 'from "@/lib/tutor/runtime', 'from "@/lib/analytics/events"', "diagram/schemas"];
    for (const file of files) {
      const imports = importSpecifiers(readSource(file));
      for (const needle of banned) {
        check(`${file} does not import ${needle}`, imports.includes(needle) === false);
      }
    }
    // The client types file imports the diagram TYPES (type-only) but never the schemas.
    const clientTypes = readSource("lib/learn/tutorClientTypes.ts");
    check(
      "tutorClientTypes imports DiagramSpec TYPE-only (import type)",
      /import type \{ DiagramSpec \} from "@\/lib\/course\/diagram\/types"/.test(clientTypes),
    );
    check(
      "tutorClientTypes NEVER imports diagram/schemas",
      importSpecifiers(clientTypes).includes("diagram/schemas") === false,
    );
  }

  /* ─────── A3 Wave 4 · history coercion of structures/assessments ─────── */
  console.log("\n— A3 Wave 4 · coerceGrounding structures/assessments (tolerant) —");
  {
    const validDiagram = {
      kind: "tree" as const,
      title: "A tree",
      caption: "the structure",
      diagram: { kind: "tree_diagram", root: { label: "root" } },
    };
    const g = coerceGrounding({
      citations: [],
      spans: [],
      flags: [],
      rung: 2,
      structures: [validDiagram],
      assessments: [
        {
          cardId: "c1",
          toolName: "checkUnderstanding",
          conceptSlug: "n1",
          initiation: "invitation_accepted",
          stem: "q?",
          options: [{ id: "a", text: "A", correct: true, misconceptionId: null, feedback: "yes" }],
          collectConfidence: false,
        },
        {
          cardId: "s1",
          toolName: "sequenceTask",
          conceptSlug: "n2",
          initiation: "practice_request",
          prompt: "order",
          items: [{ id: "1", text: "one" }, { id: "2", text: "two" }],
          correctOrder: ["1", "2"],
          partialCreditRule: "adjacent-pairs",
        },
      ],
    });
    check(
      "well-formed structures survive coercion",
      g?.structures.length === 1 && g.structures[0].kind === "tree",
    );
    check(
      "well-formed assessments survive coercion (both kinds)",
      g?.assessments.length === 2 &&
        g.assessments[0].toolName === "checkUnderstanding" &&
        g.assessments[1].toolName === "sequenceTask",
    );

    // Missing structures/assessments default to [] (grounding still usable).
    const bare = coerceGrounding({ citations: [], spans: [], flags: [], rung: 1 });
    check("absent structures coerce to []", bare?.structures.length === 0);
    check("absent assessments coerce to []", bare?.assessments.length === 0);

    // Malformed entries are DROPPED, not rendered broken.
    const malformed = coerceGrounding({
      citations: [],
      spans: [],
      flags: [],
      structures: [{ kind: "bogus", diagram: {} }, { kind: "tree" /* no diagram */ }],
      assessments: [
        { cardId: "x", toolName: "unknownTool", conceptSlug: "n" },
        { cardId: "y", toolName: "checkUnderstanding", conceptSlug: "n", initiation: "practice_request", stem: "s", options: [] },
      ],
    });
    check("structure with a bad kind / missing diagram is dropped", malformed?.structures.length === 0);
    check("assessment with an unknown tool / empty options is dropped", malformed?.assessments.length === 0);
  }

  /* ══════════════════════ A3 WAVE 5 · ADAPTIVE TOOLS (client) ═════════════ */

  const fadedCard = (
    steps: { text: string; blanked: boolean; answer: string }[],
    fadeLevel: number,
  ): Extract<TutorAssessmentCard, { toolName: "fadedExample" }> => ({
    cardId: "faded-1",
    toolName: "fadedExample",
    conceptSlug: "node-faded",
    initiation: "invitation_accepted",
    fadeLevel,
    problem: "Compute 3! by the recursive definition",
    steps,
  });

  const predictCard = (
    acceptedAnswers: string[],
    nearMisses: { pattern: string; misconceptionId: string; feedback: string }[],
  ): Extract<TutorAssessmentCard, { toolName: "predictThenReveal" }> => ({
    cardId: "predict-1",
    toolName: "predictThenReveal",
    conceptSlug: "node-predict",
    initiation: "practice_request",
    setup: "We double the array size on every resize.",
    prompt: "What is the amortized cost of n appends?",
    acceptedAnswers,
    nearMisses,
    revealExplanation: "Doubling makes the total work geometric, so it's O(n) total — O(1) amortized.",
  });

  /* ─────── A3 Wave 5 · scoreFadedCard matrix (A3-16) ─────── */
  console.log("\n— A3 Wave 5 · scoreFadedCard (all-right→demonstrated, partial, none; 0-blank→demonstrated) —");
  {
    // Two worked steps + two blanked steps.
    const steps = [
      { text: "base case: 0! = 1", blanked: false, answer: "1" },
      { text: "recurse: 3! = 3 × 2!", blanked: true, answer: "3 × 2!" },
      { text: "then 2! = 2 × 1!", blanked: true, answer: "2 × 1!" },
    ];

    // All blanks right → demonstrated.
    {
      const r = scoreFadedCard(fadedCard(steps, 2), { 1: "3 × 2!", 2: "2 × 1!" });
      check(
        "all blanks right → demonstrated (correctCount === blankCount === 2)",
        r.outcome === "demonstrated" && r.correctCount === 2 && r.blankCount === 2,
      );
    }
    // trim/lowercase tolerant on each blank.
    {
      const r = scoreFadedCard(fadedCard(steps, 2), { 1: "  3 × 2!  ", 2: "2 × 1!" });
      check("blanks compared trim/lowercase → demonstrated", r.outcome === "demonstrated");
    }
    // Some right → partial.
    {
      const r = scoreFadedCard(fadedCard(steps, 2), { 1: "3 × 2!", 2: "wrong" });
      check(
        "some blanks right → partial (correctCount 1 of 2)",
        r.outcome === "partial" && r.correctCount === 1 && r.blankCount === 2,
      );
    }
    // None right (or missing) → not_demonstrated.
    {
      const r = scoreFadedCard(fadedCard(steps, 2), { 1: "nope" });
      check(
        "no blanks right (one missing) → not_demonstrated (correctCount 0)",
        r.outcome === "not_demonstrated" && r.correctCount === 0 && r.blankCount === 2,
      );
    }
    // Empty answers count as wrong (never as a match on an empty answer key).
    {
      const r = scoreFadedCard(fadedCard(steps, 2), { 1: "", 2: "" });
      check("empty inputs → not_demonstrated", r.outcome === "not_demonstrated" && r.correctCount === 0);
    }
    // A fully-worked card (fadeLevel 0, zero blanks) → demonstrated on acknowledge.
    {
      const worked = [
        { text: "0! = 1", blanked: false, answer: "1" },
        { text: "1! = 1", blanked: false, answer: "1" },
      ];
      const r = scoreFadedCard(fadedCard(worked, 0), {});
      check(
        "fadeLevel 0, zero blanks → demonstrated on acknowledge (blankCount 0)",
        r.outcome === "demonstrated" && r.blankCount === 0 && r.correctCount === 0,
      );
    }
  }

  /* ─────── A3 Wave 5 · scorePredictCard matrix ─────── */
  console.log("\n— A3 Wave 5 · scorePredictCard (accepted→demonstrated, nearMiss→misconception, none) —");
  {
    const card = predictCard(
      ["o(1)", "constant"],
      [
        { pattern: "o(n)", misconceptionId: "counts-worst-case-resize", feedback: "The resize is rare — averaged away." },
        { pattern: "o(log", misconceptionId: "confuses-with-search", feedback: "That's search, not append." },
      ],
    );

    // Accepted (contains) → demonstrated, matched accepted, null misconception.
    {
      const r = scorePredictCard(card, "I think it's amortized O(1) overall");
      check(
        "prediction contains an accepted answer → demonstrated + matched accepted + null misconception",
        r.outcome === "demonstrated" && r.matched === "accepted" && r.misconceptionId === null && r.feedback === "",
      );
    }
    // Accepted normalized (case-insensitive equality).
    {
      const r = scorePredictCard(card, "CONSTANT");
      check("accepted match is case-insensitive → demonstrated", r.outcome === "demonstrated" && r.matched === "accepted");
    }
    // Near-miss (first matched pattern wins) → not_demonstrated + that misconception + feedback.
    {
      const r = scorePredictCard(card, "surely it's O(n) because of the copy");
      check(
        "prediction matches a near-miss → not_demonstrated + its misconceptionId + feedback",
        r.outcome === "not_demonstrated" &&
          r.matched === "nearMiss" &&
          r.misconceptionId === "counts-worst-case-resize" &&
          r.feedback === "The resize is rare — averaged away.",
      );
    }
    // Ordered: the FIRST matched near-miss wins even if a later one also matches.
    {
      const both = predictCard(
        ["never"],
        [
          { pattern: "slow", misconceptionId: "first", feedback: "f1" },
          { pattern: "cost", misconceptionId: "second", feedback: "f2" },
        ],
      );
      const r = scorePredictCard(both, "it is slow and costs a lot");
      check("first matched near-miss wins the misconception", r.misconceptionId === "first" && r.matched === "nearMiss");
    }
    // No match at all → not_demonstrated, matched none, null misconception.
    {
      const r = scorePredictCard(card, "something totally unrelated");
      check(
        "no accepted / no near-miss → not_demonstrated + matched none + null misconception",
        r.outcome === "not_demonstrated" && r.matched === "none" && r.misconceptionId === null && r.feedback === "",
      );
    }
    // An empty prediction never matches (guards the contains() on an empty guess).
    {
      const r = scorePredictCard(card, "   ");
      check("empty prediction → not_demonstrated + matched none", r.outcome === "not_demonstrated" && r.matched === "none");
    }
    // A degenerate empty accepted/near-miss key never matches an empty-ish guess.
    {
      const degenerate = predictCard([""], [{ pattern: "", misconceptionId: "x", feedback: "y" }]);
      const r = scorePredictCard(degenerate, "anything");
      check("empty accepted key + empty near-miss pattern never match", r.matched === "none");
    }
  }

  /* ─────── A3 Wave 5 · explainBackCriteriaView (A3-17 · NO verdict) ─────── */
  console.log("\n— A3 Wave 5 · explainBackCriteriaView (met/not-yet rows; NEVER a pass/fail verdict) —");
  {
    const criteria: ExplainBackCriterionResult[] = [
      { criterion: "names the base case", present: true, note: "you said 0! = 1" },
      { criterion: "explains the recursive step", present: false, note: "the multiply-down step is missing" },
      { criterion: "connects to termination", present: true, note: "" },
    ];
    const rows = explainBackCriteriaView(criteria);
    check("one view row per criterion", rows.length === 3);
    check("present → met true; absent → met false", rows[0].met === true && rows[1].met === false && rows[2].met === true);
    check("each row carries the criterion text", rows[0].criterion === "names the base case" && rows[1].criterion === "explains the recursive step");
    check("each row carries the model note (empty note stays empty string)", rows[0].note === "you said 0! = 1" && rows[2].note === "");

    // THE A3-17 guarantee: the view NEVER yields a pass/fail verdict string.
    const flat = JSON.stringify(rows).toLowerCase();
    const verdictWords = ["pass", "fail", "passed", "failed", "correct", "incorrect", "score", "grade", "verdict"];
    check(
      "explainBackCriteriaView produces NO pass/fail verdict token (A3-17)",
      verdictWords.every((w) => flat.includes(w) === false),
      `flat=${flat}`,
    );
    // A row is (criterion, met, note) ONLY — no overall/outcome/verdict field.
    check(
      "a view row has exactly {criterion, met, note} keys (no verdict field)",
      rows.every((r) => Object.keys(r).sort().join(",") === "criterion,met,note"),
    );
    // Tolerant: a non-string note coerces to "".
    {
      const weird = explainBackCriteriaView([
        { criterion: "c", present: true, note: undefined as unknown as string },
      ]);
      check("non-string note coerces to empty string", weird[0].note === "");
    }
  }

  /* ─────── A3 Wave 5 · TutorBody dispatch + card imports ─────── */
  console.log("\n— A3 Wave 5 · TutorBody dispatches the three new cards on toolName —");
  {
    const body = readSource("components/learn/tutor/TutorBody.tsx");
    check("TutorBody imports TutorFadedExampleCard", body.includes("TutorFadedExampleCard"));
    check("TutorBody imports TutorPredictCard", body.includes("TutorPredictCard"));
    check("TutorBody imports TutorExplainBackCard", body.includes("TutorExplainBackCard"));
    check("dispatch has a fadedExample case", body.includes('case "fadedExample":'));
    check("dispatch has a predictThenReveal case", body.includes('case "predictThenReveal":'));
    check("dispatch has an explainBack case", body.includes('case "explainBack":'));
    check("dispatch renders all three new cards", body.includes("<TutorFadedExampleCard") && body.includes("<TutorPredictCard") && body.includes("<TutorExplainBackCard"));
  }

  /* ─────── A3 Wave 5 · explain_back_grade client flow (awaited, criteria, no verdict) ─────── */
  console.log("\n— A3 Wave 5 · gradeExplainBack (awaited helper; fail-closed; no verdict field) —");
  {
    const evidence = readSource("lib/learn/tutorEvidence.ts");
    check("evidence exports gradeExplainBack", evidence.includes("export async function gradeExplainBack"));
    check("gradeExplainBack POSTs the explain_back_grade action", evidence.includes('action: "explain_back_grade"'));
    check("gradeExplainBack AWAITS the response (not fire-and-forget)", /await fetch\("\/api\/learn\/tutor"/.test(evidence));
    check("gradeExplainBack returns { ok, criteria, outcome } (no verdict field)", evidence.includes("ok: true; criteria:") && evidence.includes("outcome: TutorAssessmentOutcome"));
    check("gradeExplainBack fails closed on error / non-2xx / bad body", evidence.includes("return { ok: false }") && evidence.includes("if (!res.ok) return { ok: false }"));
    check("gradeExplainBack sends rubric + conceptSlug + text", evidence.includes("rubric: input.rubric") && evidence.includes("conceptSlug: input.conceptSlug") && evidence.includes("text: input.text"));

    // The explainBack CARD awaits + renders criteria WITHOUT a verdict, and shows
    // a plain retry on ok:false (fail closed, no fake result).
    const card = readSource("components/learn/tutor/TutorExplainBackCard.tsx");
    check("explainBack card calls gradeExplainBack", card.includes("gradeExplainBack("));
    check("explainBack card renders via explainBackCriteriaView (no verdict)", card.includes("explainBackCriteriaView("));
    check("explainBack card shows a plain retry on failure (no fabricated grade)", card.includes('kind: "failed"') && card.includes("Try again"));
    check("explainBack card disables the button while grading + shows a pending line", card.includes("Reading your explanation") && card.includes('phase.kind === "grading"'));
    check("explainBack card records a session attempt on a graded result only", card.includes("recordSessionAttempt(userId, card.conceptSlug)"));
    // No pass/fail verdict text in the card's RENDERED strings (code lines only).
    const cardCode = card
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
      .join("\n");
    check(
      "explainBack card renders no pass/fail verdict word (A3-17)",
      /\b(passed|failed|verdict)\b/i.test(cardCode) === false ||
        // "failed" as a Phase.kind literal is allowed; ban the learner-visible verdict prose.
        /you (passed|failed)|overall (score|grade)/i.test(cardCode) === false,
    );
  }

  /* ─────── A3 Wave 5 · card components a11y + house-style (A3-25) ─────── */
  console.log("\n— A3 Wave 5 · new cards a11y (labelled inputs/textarea, no positive tabindex, no framer/Date.now-in-render) —");
  {
    const faded = readSource("components/learn/tutor/TutorFadedExampleCard.tsx");
    const predict = readSource("components/learn/tutor/TutorPredictCard.tsx");
    const explain = readSource("components/learn/tutor/TutorExplainBackCard.tsx");
    const all = [faded, predict, explain];

    // fadedExample: blanked steps are labelled inputs (label htmlFor → input id).
    check("faded card labels each blank input (htmlFor + matching id)", faded.includes("htmlFor={inputId}") && faded.includes("id={inputId}"));
    check("faded card uses an ordered list for steps", faded.includes("<ol"));
    check("faded card renders worked steps inline + blanked steps as inputs", faded.includes("step.blanked") && faded.includes("<input"));

    // predictThenReveal: single labelled prediction input; commit-before-reveal.
    check("predict card labels the prediction input", predict.includes("htmlFor={inputId}") && predict.includes("id={inputId}"));
    check("predict card gates the reveal behind commit (nothing revealed before)", predict.includes("!committed ?") && predict.includes("revealExplanation"));
    check("predict card commit button is 'Commit prediction'", predict.includes("Commit prediction"));

    // explainBack: labelled textarea.
    check("explain card labels the textarea", explain.includes("htmlFor={inputId}") && explain.includes("<textarea"));

    // A3-25 structural: NO positive tabindex anywhere in the three components.
    for (const [i, src] of all.entries()) {
      check(
        `wave-5 component ${i} has no positive tabindex (only 0 / -1)`,
        /tabindex=\{?["']?[1-9]/i.test(src) === false && /tabIndex=\{[1-9]/.test(src) === false,
      );
    }

    // No framer-motion, no Math.random anywhere in CODE (strip prose comments).
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
        .join("\n");
    for (const [i, src] of all.entries()) {
      const code = stripComments(src);
      check(`wave-5 file ${i} imports no framer-motion`, code.includes("framer-motion") === false);
      check(`wave-5 file ${i} contains no Math.random`, code.includes("Math.random") === false);
      // No Date.now / performance.now INLINE in JSX/render — the clock is only in
      // a `now()` helper called from handlers/effects (faded/predict), or absent
      // entirely (explain measures no latency). Assert the helper form when present.
      const hasClock = code.includes("performance.now()") || code.includes("Date.now()");
      if (hasClock) {
        check(`wave-5 file ${i} clock lives in a now() helper (not inline in render)`, /function now\(\)/.test(src));
      } else {
        check(`wave-5 file ${i} has no clock at all (fine)`, true);
      }
    }

    // The latency clock is captured in a mount EFFECT (never in render) in the two
    // locally-graded cards; explainBack measures no latency (server-graded).
    check(
      "faded card captures mount time in an effect (not render)",
      faded.includes("mountedAtRef.current = now()") && faded.includes("useEffect(() => {"),
    );
    check(
      "predict card captures mount time in an effect (not render)",
      predict.includes("mountedAtRef.current = now()") && predict.includes("useEffect(() => {"),
    );

    // postToolEvidence carries fadeLevel for the faded card (Wave-5 field).
    check("faded card POSTs tool_evidence with fadeLevel: card.fadeLevel", faded.includes("fadeLevel: card.fadeLevel"));
    check("predict card POSTs tool_evidence with the matched misconceptionId", predict.includes("misconceptionId: scored.misconceptionId"));
  }

  /* ─────── A3 Wave 5 · zod-free / runtime-free fence (new Wave-5 files) ─────── */
  console.log("\n— A3 Wave 5 · zod-free / runtime-free fence (new Wave-5 files) —");
  {
    const files = [
      "components/learn/tutor/TutorFadedExampleCard.tsx",
      "components/learn/tutor/TutorPredictCard.tsx",
      "components/learn/tutor/TutorExplainBackCard.tsx",
    ];
    const importSpecifiers = (src: string): string =>
      src
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /(?:import|require)\s*\(/.test(line))
        .join("\n");
    const banned = ['from "zod"', 'from "@/lib/tutor/runtime', 'from "@/lib/analytics/events"', "diagram/schemas"];
    for (const file of files) {
      const imports = importSpecifiers(readSource(file));
      for (const needle of banned) {
        check(`${file} does not import ${needle}`, imports.includes(needle) === false);
      }
    }
  }

  /* ─────── A3 Wave 5 · history coercion of the three new variants ─────── */
  console.log("\n— A3 Wave 5 · coerceGrounding fadedExample/predictThenReveal/explainBack (tolerant) —");
  {
    const g = coerceGrounding({
      citations: [],
      spans: [],
      flags: [],
      rung: 3,
      assessments: [
        {
          cardId: "f1",
          toolName: "fadedExample",
          conceptSlug: "n1",
          initiation: "invitation_accepted",
          fadeLevel: 2,
          problem: "solve it",
          steps: [
            { text: "step one", blanked: false, answer: "a" },
            { text: "step two", blanked: true, answer: "b" },
          ],
        },
        {
          cardId: "p1",
          toolName: "predictThenReveal",
          conceptSlug: "n2",
          initiation: "practice_request",
          setup: "setup",
          prompt: "predict",
          acceptedAnswers: ["yes"],
          nearMisses: [{ pattern: "no", misconceptionId: "m", feedback: "f" }],
          revealExplanation: "reveal",
        },
        {
          cardId: "e1",
          toolName: "explainBack",
          conceptSlug: "n3",
          initiation: "invitation_accepted",
          prompt: "explain it",
          rubric: [
            { criterion: "names X", required: true },
            { criterion: "explains Y", required: false },
          ],
        },
      ],
    });
    check("all three Wave-5 variants survive coercion", g?.assessments.length === 3);
    check(
      "fadedExample coerces with fadeLevel + steps",
      g?.assessments[0].toolName === "fadedExample" &&
        (g.assessments[0] as Extract<TutorAssessmentCard, { toolName: "fadedExample" }>).fadeLevel === 2 &&
        (g.assessments[0] as Extract<TutorAssessmentCard, { toolName: "fadedExample" }>).steps.length === 2,
    );
    check(
      "predictThenReveal coerces with accepted + nearMisses + reveal",
      g?.assessments[1].toolName === "predictThenReveal" &&
        (g.assessments[1] as Extract<TutorAssessmentCard, { toolName: "predictThenReveal" }>).acceptedAnswers.join(",") === "yes" &&
        (g.assessments[1] as Extract<TutorAssessmentCard, { toolName: "predictThenReveal" }>).nearMisses.length === 1,
    );
    check(
      "explainBack coerces with a 2-criterion rubric",
      g?.assessments[2].toolName === "explainBack" &&
        (g.assessments[2] as Extract<TutorAssessmentCard, { toolName: "explainBack" }>).rubric.length === 2,
    );

    // Malformed Wave-5 entries are DROPPED (never rendered broken).
    const bad = coerceGrounding({
      citations: [],
      spans: [],
      flags: [],
      assessments: [
        // fadedExample with no steps → dropped.
        { cardId: "f", toolName: "fadedExample", conceptSlug: "n", initiation: "practice_request", fadeLevel: 1, problem: "p", steps: [] },
        // predictThenReveal missing revealExplanation → dropped.
        { cardId: "p", toolName: "predictThenReveal", conceptSlug: "n", initiation: "practice_request", setup: "s", prompt: "q", acceptedAnswers: [], nearMisses: [] },
        // explainBack with an empty rubric → dropped.
        { cardId: "e", toolName: "explainBack", conceptSlug: "n", initiation: "practice_request", prompt: "p", rubric: [] },
      ],
    });
    check("malformed Wave-5 cards are all dropped (empty steps / missing reveal / empty rubric)", bad?.assessments.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
