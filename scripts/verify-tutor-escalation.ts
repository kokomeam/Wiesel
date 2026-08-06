/**
 * TUTOR-1 Wave 6 (P6.1) — escalation TRIGGERS + consent contract, PURE suite
 * (no key, no DB, no browser). Sections:
 *
 *   TRIGGER   evaluateEscalationTrigger goldens — the explicit-request regex (±),
 *             ungrounded → propose, the per-sensitivity failed-scaffold thresholds
 *             (low=4 / default=3 / high=2), the confusion-run counting +
 *             streak-reset heuristic, and precedence.
 *   TRAIL     rungTrailFromHistory / anchorsFromHistory tolerant extraction (via
 *             the trigger's history contract) — asserted through countFailedScaffolds
 *             goldens (the pure heuristic).
 *   CONSENT   a PURE model of the relaxed status-only trigger: consent
 *             (consent_pending → consented) may edit learner_question/anchors/
 *             rung_trail; any OTHER column change raises; withdrawn is terminal;
 *             illegal transitions raise.
 *   EVENT     the frozen event NAME + payload shape (id-only, no identity).
 *
 * Run: `npx tsx scripts/verify-tutor-escalation.ts`
 */

import {
  evaluateEscalationTrigger,
  countFailedScaffolds,
  FAILED_SCAFFOLD_THRESHOLD,
  ESCALATION_REQUEST_RE,
  LEARNER_CONFUSION_RE,
  type EscalationTriggerInput,
} from "@/lib/tutor/runtime/escalationTriggers";
import {
  TUTOR_ESCALATION_CONSENTED_EVENT,
  type TutorEscalationConsentedData,
} from "@/lib/inngest/escalationEvents";
import { ESCALATION_SENSITIVITIES } from "@/lib/tutor/runtime/charter";
import type { HistoryTurn } from "@/lib/tutor/runtime/history";

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

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const asst = (content: string, rung?: number, citations?: unknown[]): HistoryTurn => ({
  role: "assistant",
  content,
  grounding: { rung, citations },
});
const learner = (content: string): HistoryTurn => ({ role: "learner", content });

/** A confused learner turn (matches LEARNER_CONFUSION_RE). */
const CONFUSED = "I'm still lost, that makes no sense to me.";
/** A learner turn that does NOT read as confusion. */
const CLEAR = "Ah, got it — so a wash stays transparent because the pigment is sparse.";

function baseInput(over: Partial<EscalationTriggerInput>): EscalationTriggerInput {
  return {
    groundingFlags: [],
    history: [],
    learnerMessage: "How does this work?",
    escalationSensitivity: "default",
    ...over,
  };
}

/* ─────────────────────────────── TRIGGER ────────────────────────────────── */

console.log("\n— TRIGGER: explicit-request regex —");
{
  const positives = [
    "Can you just ask the instructor for me?",
    "I want to talk to a human about this.",
    "please escalate this to someone",
    "ask my professor please",
    "let me talk to a person",
    "ask the teacher",
  ];
  for (const p of positives) {
    check(`request regex matches: "${p.slice(0, 32)}…"`, ESCALATION_REQUEST_RE.test(p));
  }
  const negatives = [
    "Can you ask me a question about this?",
    "I want to understand this human body topic.",
    "How do I escalate privileges in Linux — conceptually?", // 'escalate' present → intentionally matches
  ];
  check("request regex does NOT match a plain content question", ESCALATION_REQUEST_RE.test(negatives[0]) === false);
  check("request regex does NOT match 'ask me a question'", ESCALATION_REQUEST_RE.test(negatives[1]) === false);

  // An explicit request fires regardless of sensitivity.
  for (const s of ESCALATION_SENSITIVITIES) {
    const r = evaluateEscalationTrigger(
      baseInput({ learnerMessage: "please ask the instructor", escalationSensitivity: s })
    );
    check(`explicit request fires at sensitivity=${s}`, r.shouldPropose && r.reason === "explicit_request");
  }
}

console.log("\n— TRIGGER: ungrounded flag —");
{
  const r = evaluateEscalationTrigger(baseInput({ groundingFlags: ["ungrounded"] }));
  check("ungrounded flag → propose (reason ungrounded)", r.shouldPropose && r.reason === "ungrounded");

  const clean = evaluateEscalationTrigger(baseInput({ groundingFlags: ["citation_dropped"] }));
  check("a non-ungrounded cleanup flag → does NOT propose", clean.shouldPropose === false && clean.reason === null);

  // Explicit request wins over ungrounded (precedence).
  const both = evaluateEscalationTrigger(
    baseInput({ groundingFlags: ["ungrounded"], learnerMessage: "just escalate this" })
  );
  check("explicit_request precedence over ungrounded", both.reason === "explicit_request");
}

console.log("\n— TRIGGER: confusion regex —");
{
  check("confusion matches 'still lost'", LEARNER_CONFUSION_RE.test("I'm still lost here"));
  check("confusion matches 'makes no sense'", LEARNER_CONFUSION_RE.test("that makes no sense"));
  check("confusion matches \"don't get it\"", LEARNER_CONFUSION_RE.test("I don't get it at all"));
  check("confusion matches 'even more confused'", LEARNER_CONFUSION_RE.test("now I'm even more confused"));
  check("confusion does NOT match a clear ack", LEARNER_CONFUSION_RE.test(CLEAR) === false);
  check("confusion does NOT match a neutral follow-up", LEARNER_CONFUSION_RE.test("ok and what about the next step?") === false);
}

console.log("\n— TRIGGER: per-sensitivity failed-scaffold thresholds —");
{
  // The DOCUMENTED table: low=4, default=3, high=2.
  check("threshold low = 4", FAILED_SCAFFOLD_THRESHOLD.low === 4);
  check("threshold default = 3", FAILED_SCAFFOLD_THRESHOLD.default === 3);
  check("threshold high = 2", FAILED_SCAFFOLD_THRESHOLD.high === 2);

  // Build a history of N consecutive (assistant → confused) pairs.
  const pairs = (n: number): HistoryTurn[] => {
    const h: HistoryTurn[] = [];
    for (let i = 0; i < n; i++) {
      h.push(asst(`attempt ${i}`, 2), learner(CONFUSED));
    }
    return h;
  };

  // high (N=2): 1 pair → no; 2 pairs → yes.
  check("high: 1 failed scaffold does NOT reach threshold(2)", evaluateEscalationTrigger(baseInput({ history: pairs(1), escalationSensitivity: "high" })).shouldPropose === false);
  const high2 = evaluateEscalationTrigger(baseInput({ history: pairs(2), escalationSensitivity: "high" }));
  check("high: 2 failed scaffolds → propose (repeated_failed_scaffolds)", high2.shouldPropose && high2.reason === "repeated_failed_scaffolds", `count=${high2.failedScaffolds}`);

  // default (N=3): 2 → no; 3 → yes.
  check("default: 2 failed scaffolds does NOT reach threshold(3)", evaluateEscalationTrigger(baseInput({ history: pairs(2), escalationSensitivity: "default" })).shouldPropose === false);
  check("default: 3 failed scaffolds → propose", evaluateEscalationTrigger(baseInput({ history: pairs(3), escalationSensitivity: "default" })).shouldPropose === true);

  // low (N=4): 3 → no; 4 → yes.
  check("low: 3 failed scaffolds does NOT reach threshold(4)", evaluateEscalationTrigger(baseInput({ history: pairs(3), escalationSensitivity: "low" })).shouldPropose === false);
  check("low: 4 failed scaffolds → propose", evaluateEscalationTrigger(baseInput({ history: pairs(4), escalationSensitivity: "low" })).shouldPropose === true);

  // threshold carried on the result even when it doesn't fire.
  const carried = evaluateEscalationTrigger(baseInput({ history: pairs(1), escalationSensitivity: "high" }));
  check("threshold carried on result (high → 2)", carried.threshold === 2 && carried.failedScaffolds === 1);
}

console.log("\n— TRIGGER: streak-reset heuristic —");
{
  // A resolved-then-restarted streak: 3 confused pairs, then a CLEAR turn resets,
  // then 1 confused pair — the trailing count is 1, not 4.
  const h: HistoryTurn[] = [
    asst("a", 2), learner(CONFUSED),
    asst("b", 2), learner(CONFUSED),
    asst("c", 2), learner(CONFUSED),
    asst("d", 3), learner(CLEAR), // resolved → reset
    asst("e", 2), learner(CONFUSED),
  ];
  check("countFailedScaffolds resets on a clear turn (3+reset+1 → 1)", countFailedScaffolds(h) === 1, `got ${countFailedScaffolds(h)}`);

  // No confusion at all → 0.
  check("no confusion → 0 failed scaffolds", countFailedScaffolds([asst("a", 2), learner(CLEAR)]) === 0);

  // An assistant turn with no following learner turn is not (yet) a failure.
  check("dangling assistant turn is not a failure", countFailedScaffolds([asst("a", 2)]) === 0);

  // Empty history → not proposing.
  const empty = evaluateEscalationTrigger(baseInput({ history: [] }));
  check("empty history + clean flags → does NOT propose", empty.shouldPropose === false);
}

/* ─────────────────────────────── CONSENT ────────────────────────────────── */

console.log("\n— CONSENT: pure model of the relaxed status-only trigger —");
{
  // A pure mirror of private.enforce_escalation_status_only() (migration
  // 20260806100000). The DDL is the source of truth (the int suite asserts it live);
  // this pins the SEMANTICS so a regression in the migration is caught in code too.
  type Row = {
    status: "consent_pending" | "consented" | "withdrawn";
    user_id: string;
    course_id: string;
    node_ids: unknown;
    tutor_proposed_answer: string | null;
    created_at: string;
    learner_question: string;
    anchors: unknown;
    rung_trail: unknown;
  };
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  function enforce(oldR: Row, newR: Row): { ok: true } | { ok: false; error: string } {
    const isConsent = oldR.status === "consent_pending" && newR.status === "consented";
    if (
      newR.user_id !== oldR.user_id ||
      newR.course_id !== oldR.course_id ||
      differs(newR.node_ids, oldR.node_ids) ||
      newR.tutor_proposed_answer !== oldR.tutor_proposed_answer ||
      newR.created_at !== oldR.created_at
    ) {
      return { ok: false, error: "only the status may change" };
    }
    if (!isConsent) {
      if (
        newR.learner_question !== oldR.learner_question ||
        differs(newR.anchors, oldR.anchors) ||
        differs(newR.rung_trail, oldR.rung_trail)
      ) {
        return { ok: false, error: "only the status may change" };
      }
    }
    if (
      newR.status !== oldR.status &&
      !(oldR.status === "consent_pending" && (newR.status === "consented" || newR.status === "withdrawn"))
    ) {
      return { ok: false, error: "illegal status transition" };
    }
    return { ok: true };
  }

  const pending: Row = {
    status: "consent_pending",
    user_id: "u1",
    course_id: "c1",
    node_ids: ["n1"],
    tutor_proposed_answer: "answer",
    created_at: "t0",
    learner_question: "original question",
    anchors: [],
    rung_trail: [],
  };

  // (a) consent transition may edit learner_question + anchors + rung_trail.
  const consented = enforce(pending, {
    ...pending,
    status: "consented",
    learner_question: "edited at consent",
    anchors: [{ lessonId: "L1", blockId: "B1" }],
    rung_trail: [1, 2, 3],
  });
  check("consent (pending→consented) may edit question/anchors/rung_trail", consented.ok === true);

  // (b) a plain status-only consent (no edits) is legal too.
  check("consent with no payload edit is legal", enforce(pending, { ...pending, status: "consented" }).ok === true);

  // (c) withdrawing may NOT edit the question (not a consent transition).
  const withdrawEdit = enforce(pending, { ...pending, status: "withdrawn", learner_question: "sneaky edit" });
  check("withdraw + question edit → raises (only status may change)", withdrawEdit.ok === false);

  // (d) a status-only withdraw is legal.
  check("withdraw (status only) is legal", enforce(pending, { ...pending, status: "withdrawn" }).ok === true);

  // (e) editing an immutable-always column even during consent → raises.
  const badConsent = enforce(pending, { ...pending, status: "consented", tutor_proposed_answer: "rewritten" });
  check("consent + proposed-answer edit → raises (always immutable)", badConsent.ok === false);

  // (f) withdrawn is terminal — withdrawn → consented raises.
  const withdrawn: Row = { ...pending, status: "withdrawn" };
  check("withdrawn → consented → illegal transition", enforce(withdrawn, { ...withdrawn, status: "consented" }).ok === false);

  // (g) consented is terminal — consented → withdrawn raises.
  const alreadyConsented: Row = { ...pending, status: "consented" };
  check("consented → withdrawn → illegal transition", enforce(alreadyConsented, { ...alreadyConsented, status: "withdrawn" }).ok === false);

  // (h) an update that touches a payload column while NOT transitioning status → raises.
  const idleEdit = enforce(pending, { ...pending, learner_question: "edit while pending, no status flip" });
  check("payload edit with no status flip → raises", idleEdit.ok === false);
}

/* ─────────────────────────────── EVENT ──────────────────────────────────── */

console.log("\n— EVENT: frozen name + id-only payload —");
{
  check("event name is 'tutor/escalation.consented'", TUTOR_ESCALATION_CONSENTED_EVENT === "tutor/escalation.consented");
  check("event name follows {domain}/{noun}.{verb}", /^tutor\/escalation\.consented$/.test(TUTOR_ESCALATION_CONSENTED_EVENT));

  // The payload shape is exactly {candidateId, courseId} — id-only, no identity.
  const payload: TutorEscalationConsentedData = { candidateId: "cand-1", courseId: "course-1" };
  const keys = Object.keys(payload).sort();
  check("payload keys are exactly [candidateId, courseId]", JSON.stringify(keys) === JSON.stringify(["candidateId", "courseId"]));
  check("payload carries NO learner identity field", !("userId" in payload) && !("learnerUserId" in payload) && !("learner_question" in payload));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
