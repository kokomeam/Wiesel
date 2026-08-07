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
 *
 * Run: `npx tsx scripts/verify-tutor-client.ts`
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Give the persisted store a real (in-memory) storage so its writes don't log
// "storage currently unavailable" noise under Node. Set BEFORE importing the
// store so the persist middleware picks it up.
const memStore = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() {
    return memStore.size;
  },
} as Storage;

import {
  useTutorStore,
  TUTOR_MIN_WIDTH,
  TUTOR_MAX_WIDTH,
  TUTOR_DEFAULT_WIDTH,
} from "@/lib/learn/tutorStore";
import { createEngagementTracker, type EngagementSignal } from "@/lib/learn/engagement";
import {
  gradePracticeAnswer,
  selfReportStableKey,
  ttftRating,
  type TutorPracticeItem,
  type TutorSSEEvent,
  type TutorTurnPayload,
} from "@/lib/learn/tutorClientTypes";
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
    // the client mirror (the client renders exactly these fields).
    for (const field of ["prose", "spans", "citations", "rung", "practiceItems", "escalationProposal", "flags"]) {
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
