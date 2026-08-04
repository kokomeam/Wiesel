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
} from "@/lib/learn/tutorClientTypes";

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
  console.log("\n— ttftRating thresholds (good <1500 / ni <3000 / poor) —");
  {
    check("1499 → good", ttftRating(1499) === "good");
    check("1500 → needs-improvement (boundary)", ttftRating(1500) === "needs-improvement");
    check("2999 → needs-improvement", ttftRating(2999) === "needs-improvement");
    check("3000 → poor (boundary)", ttftRating(3000) === "poor");
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
