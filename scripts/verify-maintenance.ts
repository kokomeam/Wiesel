/**
 * Maintenance-agent PURE verification (Milestone 5) — no DB, no key.
 * Run: `npx tsx scripts/verify-maintenance.ts`  (npm run verify:maintenance)
 *
 * Covers: the GLOBAL model-call semaphore (≤2 in flight under 6 concurrent
 * calls — the acceptance's concurrency assertion, via a gated fake client),
 * budget truncation semantics, the InsightReport/Finding/CommsDraft schemas
 * (incl. strict-JSON conversion), dedupe/prioritize/fan-out-cap + threshold
 * adoption, analyze-intent regex routing, scope parsing, and the six
 * analytics read tools' compact shapes + caps over a synthetic capability.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { CourseAnalytics, SnapshotMaps } from "@/lib/analytics/dashboard";
import { classifyIntent } from "@/lib/ai/intent";
import {
  CommsDraftSchema,
  dedupeAndPrioritize,
  dedupeKeyForFinding,
  FindingSchema,
  InsightReportSchema,
  parseAnalysisScope,
  type Finding,
} from "@/lib/ai/maintenanceSchema";
import type { ModelClient, ModelTurnResult } from "@/lib/ai/modelClient";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import {
  runStructuredCall,
  runSubagent,
  Semaphore,
  withSemaphore,
} from "@/lib/ai/subagent";
import { executeTool, ToolError } from "@/lib/ai/tools";
import type { AnalyticsToolContext, ToolContext } from "@/lib/ai/tools/types";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument } from "@/lib/course/types";
import { z } from "zod";

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

function makeDoc(): CourseDocument {
  const modules = [1, 2, 3].map((n) => {
    const m = createModule(`Module topic ${n}`, n - 1);
    m.lessons = [1, 2].map((k) => {
      const l = createLesson(`Lesson ${n}.${k} on “Pointers”`, k - 1);
      l.blocks = [createBlock("lecture_text", 0)];
      return l;
    });
    return m;
  });
  return {
    id: crypto.randomUUID(),
    title: "Scope fixture",
    description: "",
    plan: { outcomes: [], prerequisites: [] },
    modules,
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId: crypto.randomUUID(),
      aiReadableVersion: "1.0",
    },
  };
}

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return FindingSchema.parse({
    kind: "content_issue",
    severity: "medium",
    title: "A finding",
    evidence: { metrics: { n: 10 }, summary: "Something is off." },
    targets: { lessonId: null, blockId: null, questionId: null, userId: null },
    recommendation: "Fix it.",
    ...overrides,
  });
}

async function main() {
  /* ── 1. Semaphore: ≤2 in flight under 6 concurrent calls ── */
  console.log("\n— Semaphore (the concurrency acceptance) —");
  const sem = new Semaphore(2);
  let inFlight = 0;
  let maxInFlight = 0;
  const gates: (() => void)[] = [];
  const fake: ModelClient = {
    model: "fake",
    async runTurn(): Promise<ModelTurnResult> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      return { text: "{}", toolCalls: [], finishReason: "stop" };
    },
  };
  const capped = withSemaphore(fake, sem);
  const calls = Array.from({ length: 6 }, () =>
    capped.runTurn({ system: "", input: [], tools: [] }, () => {})
  );
  // Let the microtask queue settle so every acquire has had its chance.
  await new Promise((r) => setImmediate(r));
  check("only 2 calls started immediately", gates.length === 2 && sem.inFlight === 2);
  while (gates.length > 0 || sem.inFlight > 0) {
    const gate = gates.shift();
    if (gate) gate();
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all(calls);
  check("all 6 calls completed", true);
  check("never more than 2 in flight", maxInFlight === 2, `max ${maxInFlight}`);
  check("semaphore fully released", sem.inFlight === 0);

  /* ── 2. Structured call + budget truncation ── */
  console.log("\n— Structured calls + budgets —");
  const VerdictSchema = z.object({ verdict: z.string() });
  const okModel = createMockModelClient([], {
    finalText: "done",
    structured: { test_verdict: { verdict: "fine" } },
  });
  const okCall = await runStructuredCall(okModel, {
    system: "s",
    input: "i",
    outputName: "test_verdict",
    outputSchema: VerdictSchema,
  });
  check("structured call parses the mock's payload", okCall.ok && okCall.data?.verdict === "fine");

  const badModel = createMockModelClient([], {
    finalText: "done",
    structured: { test_verdict: { wrong: true } },
  });
  const badCall = await runStructuredCall(badModel, {
    system: "s",
    input: "i",
    outputName: "test_verdict",
    outputSchema: VerdictSchema,
  });
  check(
    "invalid payload → one re-ask then schema_parse_failed",
    !badCall.ok && badCall.error === "schema_parse_failed" && badModel.getCalls().length === 2
  );

  const exhaustedResult = await runSubagent({
    c: {
      supabase: null as unknown as SupabaseClient<Database>,
      model: okModel,
      courseId: "c",
      lessonId: "l",
      ownerId: "o",
      conversationId: "",
      emit: () => {},
      callBudget: { remaining: 0 },
    },
    role: "comms",
    systemPrompt: "s",
    context: "ctx",
    userMessage: "u",
    outputSchema: VerdictSchema,
    outputName: "test_verdict",
    tokenBudget: { remaining: 1000 },
  });
  check(
    "call budget exhausted → graceful {ok:false, truncated}",
    !exhaustedResult.ok && exhaustedResult.truncated && exhaustedResult.error === "budget_exhausted"
  );
  const tokenExhausted = await runSubagent({
    c: {
      supabase: null as unknown as SupabaseClient<Database>,
      model: okModel,
      courseId: "c",
      lessonId: "l",
      ownerId: "o",
      conversationId: "",
      emit: () => {},
      callBudget: { remaining: 10 },
    },
    role: "comms",
    systemPrompt: "s",
    context: "ctx",
    userMessage: "u",
    outputSchema: VerdictSchema,
    outputName: "test_verdict",
    tokenBudget: { remaining: 0 },
  });
  check("token budget exhausted → graceful truncation", !tokenExhausted.ok && tokenExhausted.truncated);

  /* ── 3. Schemas ── */
  console.log("\n— Schemas —");
  check(
    "InsightReport strict-JSON conversion doesn't throw",
    (() => {
      try {
        toStrictJsonSchema(InsightReportSchema);
        toStrictJsonSchema(CommsDraftSchema);
        return true;
      } catch {
        return false;
      }
    })()
  );
  check(
    "Finding rejects a bad severity",
    !FindingSchema.safeParse({ ...finding({ id: "f" }), severity: "urgent" }).success
  );
  check(
    "CommsDraft caps paragraphs at 4",
    !CommsDraftSchema.safeParse({
      template: "stalled_nudge",
      subject: "s",
      paragraphs: ["a", "b", "c", "d", "e"],
    }).success
  );

  /* ── 4. Dedupe + prioritize ── */
  console.log("\n— Dedupe / prioritize / fan-out cap —");
  const q1 = finding({
    id: "a1",
    targets: { lessonId: "L1", blockId: "B1", questionId: "Q1", userId: null },
    severity: "medium",
  });
  const q1dup = finding({
    id: "a2",
    targets: { lessonId: "L1", blockId: "B1", questionId: "Q1", userId: null },
    severity: "high",
  });
  check("dedupe key: question wins", dedupeKeyForFinding(q1) === "question:Q1");
  const risk = finding({
    id: "a3",
    kind: "learner_risk",
    targets: { lessonId: null, blockId: null, questionId: null, userId: "U1" },
    severity: "high",
  });
  check("dedupe key: learner risk", dedupeKeyForFinding(risk) === "learner_risk:U1");

  const threshold = {
    id: "filed-1",
    dedupe_key: "question:Q1",
    finding: finding({ id: "t1", targets: { lessonId: "L1", blockId: "B1", questionId: "Q1", userId: null } }),
  };
  const merged = dedupeAndPrioritize([q1, q1dup, risk], [threshold], 5);
  check("analyst self-duplicates collapse", merged.length === 2);
  const adopted = merged.find((m) => m.dedupeKey === "question:Q1");
  check(
    "analyst finding ADOPTS the filed threshold row",
    adopted?.adoptedFindingId === "filed-1" && adopted?.finding.id === "a1"
  );
  check("severity-desc ordering", merged[0].finding.severity === "high");

  const many = Array.from({ length: 9 }, (_, i) =>
    finding({
      id: `m${i}`,
      targets: { lessonId: null, blockId: null, questionId: `MQ${i}`, userId: null },
    })
  );
  check("fan-out capped at 5", dedupeAndPrioritize(many, [], 5).length === 5);
  const unfiled = {
    id: "filed-2",
    dedupe_key: "question:QX",
    finding: finding({ id: "t2", targets: { lessonId: "L2", blockId: "B2", questionId: "QX", userId: null } }),
  };
  check(
    "an un-rediscovered threshold row still joins the run",
    dedupeAndPrioritize([q1], [unfiled], 5).some((m) => m.adoptedFindingId === "filed-2")
  );

  /* ── 5. Intent routing + scope parsing ── */
  console.log("\n— Analyze intent + scope —");
  const neverCallModel = createMockModelClient([], { finalText: "" });
  for (const msg of [
    "Why are students dropping off in module 3?",
    "analyze course health",
    "which quiz questions are struggling learners failing?",
    "show me the drop-off analytics",
  ]) {
    const mode = await classifyIntent(neverCallModel, { hasDeck: true }, msg);
    check(`"${msg.slice(0, 40)}…" → analyze`, mode === "analyze");
  }
  check("regex short-circuit (no model call)", neverCallModel.getCalls().length === 0);
  check(
    "a build request still routes away from analyze",
    (await classifyIntent(
      createMockModelClient([], { finalText: "", structured: { intent: { mode: "edit" } } }),
      { hasDeck: true },
      "build a module on pointers with 3 lessons"
    )) === "generate_module"
  );

  const doc = makeDoc();
  const scoped = parseAnalysisScope(doc, "why are students dropping off in module 3?");
  check(
    "scope: 'module 3' → that module's lessons",
    scoped.moduleId === doc.modules[2].id && scoped.lessonIds?.length === 2
  );
  const lessonScope = parseAnalysisScope(doc, "analyze lesson 2 please");
  check(
    "scope: 'lesson 2' → the second lesson course-wide",
    lessonScope.lessonIds?.[0] === doc.modules[0].lessons[1].id
  );
  const quotedScope = parseAnalysisScope(doc, 'analyze the "Pointers" lesson');
  check("scope: quoted title matches", quotedScope.lessonIds?.length === 1);
  check(
    "scope: nothing matches → whole course",
    parseAnalysisScope(doc, "analyze everything").lessonIds === undefined
  );

  /* ── 6. Analytics read tools over a synthetic capability ── */
  console.log("\n— Analytics read tools —");
  const questionStats = Array.from({ length: 25 }, (_, i) => ({
    course_id: "c",
    publication_id: "p",
    version: 1,
    block_id: `block-${i}`,
    question_id: `q-${i}`,
    lesson_id: `lesson-${i % 3}`,
    n: 30,
    pct_correct: i === 0 ? 30 : 85,
    answer_distribution: { A: i === 0 ? 20 : 2, B: i === 0 ? 6 : 25 } as Record<string, number>,
    key_value: "B",
    discrimination: i === 0 ? 0.05 : 0.4,
    computed_at: "2026-07-03T00:00:00Z",
  }));
  const synthetic: CourseAnalytics = {
    overview: {
      totalEnrollments: 41,
      activeEnrollments: 30,
      completedEnrollments: 6,
      active7d: 12,
      enrollmentsByDay: [],
    },
    funnel: [
      { course_id: "c", publication_id: "p", version: 1, lesson_id: "lesson-0", lesson_order: 1, started_count: 41, completed_count: 24, dropoff_pct: null, computed_at: "" },
      { course_id: "c", publication_id: "p", version: 1, lesson_id: "lesson-1", lesson_order: 2, started_count: 19, completed_count: 14, dropoff_pct: 0.5366, computed_at: "" },
    ],
    questionStats: questionStats as CourseAnalytics["questionStats"],
    slideDwell: [],
    videoRetention: [],
    flags: [
      { course_id: "c", user_id: "u2", flag_type: "repeated_quiz_failure", detail: {}, computed_at: "" },
    ] as CourseAnalytics["flags"],
    roster: [
      {
        user_id: "u2",
        display_name: "Jordan",
        email: "hidden@example.com",
        enrolled_at: "2026-06-01T00:00:00Z",
        enrollment_status: "active",
        progress_pct: 40,
        completed_lessons: 1,
        total_lessons: 3,
        last_activity_at: null,
        flags: [],
      },
    ] as unknown as CourseAnalytics["roster"],
    computedAt: "2026-07-03T00:00:00Z",
  };
  const maps: SnapshotMaps = {
    lessonTitles: new Map([
      ["lesson-0", "Supply and demand"],
      ["lesson-1", "Equilibrium"],
    ]),
    blocks: new Map(),
    questions: new Map([["q-0", { prompt: "The deliberately ambiguous one?", blockId: "block-0" }]]),
    choiceLabels: new Map([
      ["A", "Demand increases"],
      ["B", "Quantity demanded increases"],
    ]),
    hasQuiz: true,
  };
  const capability: AnalyticsToolContext = {
    data: synthetic,
    maps,
    loadLearnerProfile: async (userId) =>
      userId === "u2"
        ? {
            userId,
            displayName: "Jordan",
            enrolledAt: "2026-06-01T00:00:00Z",
            enrollmentStatus: "active",
            progressPct: 40,
            completedLessons: 1,
            totalLessons: 3,
            lastActivityAt: null,
            flags: ["repeated_quiz_failure"],
            recentAttempts: [],
          }
        : null,
  };
  const ctx: ToolContext = {
    doc: doc,
    courseId: "c",
    lessonId: "lesson-0",
    analytics: capability,
  };

  const health = await executeTool("get_course_health_summary", "{}", ctx);
  const healthData = health.data as { enrollments: number; flaggedQuestions: number; strugglingLearners: number };
  check(
    "health summary aggregates the rollups",
    healthData.enrollments === 41 && healthData.flaggedQuestions >= 1 && healthData.strugglingLearners === 1
  );
  const items = await executeTool("get_question_item_stats", JSON.stringify({ lessonId: null }), ctx);
  const itemData = items.data as { questions: { questionId: string; flags: string[]; topDistractor: { label: string } | null; prompt: string }[] };
  check("item stats capped at 20", itemData.questions.length === 20, `got ${itemData.questions.length}`);
  check(
    "worst question sorts first, flags + distractor label + prompt attached",
    itemData.questions[0].questionId === "q-0" &&
      itemData.questions[0].flags.length >= 2 &&
      itemData.questions[0].topDistractor?.label === "Demand increases" &&
      itemData.questions[0].prompt.includes("ambiguous")
  );
  const scopedItems = await executeTool(
    "get_question_item_stats",
    JSON.stringify({ lessonId: "lesson-1" }),
    ctx
  );
  check(
    "item stats scope to a lesson",
    (scopedItems.data as { questions: unknown[] }).questions.length < 20
  );
  const strugglers = await executeTool("get_struggling_learners", "{}", ctx);
  const strugglerData = strugglers.data as { learners: Record<string, unknown>[] };
  check(
    "struggling learners NEVER include emails",
    strugglerData.learners.length === 1 &&
      !JSON.stringify(strugglerData).includes("hidden@example.com")
  );
  const profile = await executeTool("get_learner_profile", JSON.stringify({ userId: "u2" }), ctx);
  check("learner profile resolves via the lazy loader", (profile.data as { displayName: string }).displayName === "Jordan");
  let toolErrored = false;
  try {
    await executeTool("get_course_health_summary", "{}", { ...ctx, analytics: undefined });
  } catch (err) {
    toolErrored = err instanceof ToolError;
  }
  check("tools ToolError without the capability", toolErrored);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
