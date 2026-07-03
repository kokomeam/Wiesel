/**
 * Maintenance-agent integration test against LIVE Supabase + the MOCK model
 * (Milestone 5). Run: `npx tsx scripts/verify-maintenance-int.ts`
 * (npm run verify:maintenance:int). Requires SUPABASE_SERVICE_ROLE_KEY.
 *
 * Proves the acceptance end-to-end: with seeded fixture analytics, a
 * SCHEDULED run produces ≥1 CORRECT, EVIDENCE-ANNOTATED proposal on the
 * deliberately-bad fixture quiz; Accept applies it to the draft; Reject rolls
 * back atomically; budgets are respected; and EVERY safety rail holds (no
 * publication writes, no enrollment mutation, drafts only — the comms
 * provider records zero sends). Also: threshold-finding adoption + the open
 * dedupe index, and the run ledger's replayable report.
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean
 * them in Supabase → Auth. The course is deleted at the end (cascades).
 */

import { readFileSync } from "node:fs";

{
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  process.env.COMMS_PROVIDER = "mock";
}

import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import type { AgentEvent } from "@/lib/ai/events";
import { MAINTENANCE_MAX_CALLS, runMaintenanceRun } from "@/lib/ai/maintenance";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { loadCourseDoc } from "@/lib/ai/serverPersistence";
import { getMockSends, resetMockSends } from "@/lib/comms/mockProvider";
import { findBlock } from "@/lib/course/queries";
import { loadFixtureEnv, seedFixture } from "./seed-fixture-analytics";

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

async function main() {
  const env = loadFixtureEnv();
  if (!env.url || !env.anon) throw new Error("Missing Supabase env in .env.local");
  if (!env.service) throw new Error("verify:maintenance:int needs SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient<Database>(env.url, env.service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("\n— Seeding the fixture —");
  const fx = await seedFixture({ url: env.url, anon: env.anon, service: env.service });
  check("fixture seeded", true);

  try {
    /* ── 1. Threshold filing substrate: an open finding + the dedupe index ── */
    console.log("\n— Threshold findings + dedupe —");
    const filedFinding = {
      id: crypto.randomUUID(),
      kind: "content_issue" as const,
      severity: "medium" as const,
      title: "Quiz question flagged by nightly thresholds",
      evidence: {
        metrics: { pctCorrect: 36, n: 41 },
        summary: "Only 36% of 41 learners answer correctly",
      },
      targets: {
        lessonId: fx.lessonA.id,
        blockId: fx.quizBlockId,
        questionId: fx.badQuestionId,
        userId: null,
      },
      recommendation: "Review the question wording, the correct answer, and the distractors.",
    };
    const filed = await admin
      .from("agent_findings")
      .insert({
        course_id: fx.courseId,
        kind: "content_issue",
        severity: "medium",
        dedupe_key: `question:${fx.badQuestionId}`,
        finding: filedFinding as unknown as Json,
      })
      .select("id")
      .single();
    if (filed.error) throw filed.error;
    check("threshold finding filed (open)", true);
    const dup = await admin.from("agent_findings").insert({
      course_id: fx.courseId,
      kind: "content_issue",
      severity: "medium",
      dedupe_key: `question:${fx.badQuestionId}`,
      finding: filedFinding as unknown as Json,
    });
    check("open-dedupe index rejects a duplicate filing", dup.error?.code === "23505");

    /* ── 2. Queue + run (scheduled trigger, mock model) ── */
    console.log("\n— The scheduled run —");
    const queued = await admin
      .from("agent_runs")
      .insert({ course_id: fx.courseId, trigger: "scheduled", status: "queued" })
      .select("id")
      .single();
    if (queued.error) throw queued.error;

    const insightReport = {
      summary:
        "One quiz question is misleading learners: its wording conflates demand with quantity demanded, and one learner needs a check-in.",
      findings: [
        {
          id: "f-quiz",
          kind: "content_issue",
          severity: "high",
          title: "Ambiguous supply-and-demand question",
          evidence: {
            metrics: { pctCorrect: 36, n: 41, topDistractorCount: 24, keyCount: 8 },
            summary:
              "Q1: 64% incorrect over 41 attempts; distractor “Demand increases” chosen 3× the key — likely ambiguous wording.",
          },
          targets: {
            lessonId: fx.lessonA.id,
            blockId: fx.quizBlockId,
            questionId: fx.badQuestionId,
            userId: null,
          },
          recommendation: "Reword the prompt to distinguish demand from quantity demanded.",
        },
        {
          id: "f-learner",
          kind: "learner_risk",
          severity: "high",
          title: "A learner keeps failing the same quiz",
          evidence: {
            metrics: { failedAttempts: 2, lastScorePct: 30 },
            summary: "Two failing attempts on the supply-and-demand check, last score 30%.",
          },
          targets: { lessonId: null, blockId: null, questionId: null, userId: fx.student2.userId },
          recommendation: "Draft a personal check-in.",
        },
      ],
    };
    const model = createMockModelClient(
      [
        // Analyst loop: read the rollups, then close with prose analysis.
        {
          toolCalls: [
            { name: "get_course_health_summary", arguments: {} },
            { name: "get_question_item_stats", arguments: { lessonId: null } },
          ],
        },
        {
          text: "The supply-and-demand question is ambiguous (36% correct, distractor 3× the key). One learner is repeatedly failing it.",
        },
        // Remediation loop: rewrite the bad quiz, then close.
        {
          toolCalls: [
            {
              name: "write_quiz",
              arguments: {
                blockId: fx.quizBlockId,
                lessonId: null,
                title: "Supply and demand check",
                questions: [
                  {
                    kind: "multiple_choice",
                    prompt:
                      "When the PRICE of a good falls, what happens along the demand curve?",
                    explanation: "A price change moves along the curve.",
                    choices: [
                      "The demand curve shifts right",
                      "Quantity demanded increases",
                      "Supply decreases",
                    ],
                    correctIndex: 1,
                  },
                  {
                    kind: "true_false",
                    prompt: "A demand curve slopes downward.",
                    explanation: "Yes.",
                    correctAnswer: true,
                  },
                ],
              },
            },
          ],
        },
        { text: "Reworded the ambiguous question; the key is now unambiguous." },
      ],
      {
        finalText: "done",
        structured: {
          insight_report: insightReport,
          remediation_verdict: { addressed: true, summary: "Reworded the ambiguous question." },
          comms_draft: {
            template: "struggling_topic",
            subject: "A hand with supply and demand?",
            paragraphs: [
              "I noticed the supply-and-demand check has been putting up a fight — that one trips a lot of people up.",
              "If the wording reads ambiguously to you, reply and tell me. It helps me improve the course.",
            ],
          },
        },
      }
    );

    resetMockSends();
    const events: AgentEvent[] = [];
    const result = await runMaintenanceRun({
      supabase: admin,
      model,
      courseId: fx.courseId,
      ownerId: fx.author.userId,
      trigger: "scheduled",
      runId: queued.data.id,
      emit: (e) => events.push(e),
    });

    check("run completed", result.status === "completed", result.summary);
    check("≥1 evidence-annotated proposal staged", result.changeSets >= 1);
    check("1 learner draft produced", result.drafts === 1);

    const runRow = await admin
      .from("agent_runs")
      .select("status, report, budget_used, started_at, finished_at")
      .eq("id", queued.data.id)
      .single();
    const report = runRow.data?.report as {
      insight?: { findings?: unknown[] };
      dispatched?: { findingId: string; changeSetId?: string; messageId?: string }[];
      transcripts?: Record<string, unknown[]>;
    } | null;
    const budget = runRow.data?.budget_used as { calls?: number; outputTokens?: number } | null;
    check(
      "run ledger: completed + replayable report + budget_used",
      runRow.data?.status === "completed" &&
        (report?.insight?.findings?.length ?? 0) === 2 &&
        (report?.dispatched?.length ?? 0) === 2 &&
        Object.keys(report?.transcripts ?? {}).length >= 2 &&
        (budget?.calls ?? 0) > 0 &&
        !!runRow.data?.started_at &&
        !!runRow.data?.finished_at
    );
    check(
      "budgets respected (model calls ≤ cap and match the ledger)",
      model.getCalls().length <= MAINTENANCE_MAX_CALLS &&
        (budget?.calls ?? 0) <= MAINTENANCE_MAX_CALLS
    );

    /* ── 3. Findings: adoption + proposal linkage ── */
    console.log("\n— Findings —");
    const adopted = await admin
      .from("agent_findings")
      .select("run_id, status, change_set_id")
      .eq("id", filed.data.id)
      .single();
    check(
      "the open threshold finding was ADOPTED by the run",
      adopted.data?.run_id === queued.data.id
    );
    check(
      "…and is now proposed with a change-set attached",
      adopted.data?.status === "proposed" && !!adopted.data?.change_set_id
    );
    const changeSetId = adopted.data!.change_set_id!;

    const riskRow = await admin
      .from("agent_findings")
      .select("status")
      .eq("course_id", fx.courseId)
      .eq("dedupe_key", `learner_risk:${fx.student2.userId}`)
      .single();
    check("the learner-risk finding is proposed (draft attached)", riskRow.data?.status === "proposed");

    /* ── 4. Evidence rides on every proposed item (the product moment) ── */
    console.log("\n— Evidence —");
    const items = await admin
      .from("change_set_items")
      .select("evidence, op, block_id")
      .eq("change_set_id", changeSetId);
    const itemEvidence = (items.data ?? [])[0]?.evidence as { summary?: string; findingId?: string } | null;
    check("change-set items exist", (items.data ?? []).length >= 1);
    check(
      "every item carries the finding's evidence",
      (items.data ?? []).every(
        (i) =>
          ((i.evidence as { summary?: string } | null)?.summary ?? "").includes("64% incorrect")
      ) && itemEvidence?.findingId === "f-quiz"
    );
    check(
      "the change_set event streamed the evidence live",
      events.some(
        (e) =>
          e.type === "change_set" &&
          ((e.evidence as { summary?: string } | undefined)?.summary ?? "").includes("64% incorrect")
      )
    );
    check(
      "maintenance stage events streamed (analyze → findings → report)",
      ["analyze", "findings", "report"].every((stage) =>
        events.some((e) => e.type === "maintenance" && e.stage === stage)
      )
    );

    /* ── 5. The learner draft (Comms) — draft ONLY, never sent ── */
    console.log("\n— Comms draft —");
    const messages = await admin
      .from("learner_messages")
      .select("status, user_id, finding_id, subject")
      .eq("course_id", fx.courseId);
    check(
      "exactly one draft, for the struggling learner, finding-linked",
      (messages.data ?? []).length === 1 &&
        messages.data?.[0]?.status === "draft" &&
        messages.data?.[0]?.user_id === fx.student2.userId &&
        !!messages.data?.[0]?.finding_id
    );

    /* ── 6. SAFETY RAILS ── */
    console.log("\n— Safety rails —");
    const pubs = await admin
      .from("course_publications")
      .select("id", { count: "exact", head: true })
      .eq("course_id", fx.courseId);
    check("no publication was created/updated by the agent", pubs.count === 1);
    const enrollments = await admin
      .from("enrollments")
      .select("status, comms_opt_out")
      .eq("course_id", fx.courseId);
    check(
      "no enrollment mutation",
      (enrollments.data ?? []).length === 2 &&
        (enrollments.data ?? []).every((e) => e.status === "active" && e.comms_opt_out === false)
    );
    check("ZERO emails sent by the run (no auto-send path)", getMockSends().length === 0);

    /* ── 7. Accept applies to the draft ── */
    console.log("\n— Accept —");
    await acceptChangeSet(fx.author.client, changeSetId);
    // The route also transitions the linked finding — same statement, same client:
    await fx.author.client
      .from("agent_findings")
      .update({ status: "accepted" })
      .eq("change_set_id", changeSetId)
      .eq("status", "proposed");
    const afterAccept = await loadCourseDoc(admin, fx.courseId);
    const acceptedQuiz = findBlock(afterAccept!, fx.quizBlockId)?.block;
    const acceptedJson = JSON.stringify(acceptedQuiz);
    check(
      "the fix is live in the DRAFT (reworded, unambiguous prompt)",
      acceptedJson.includes("along the demand curve") && !acceptedJson.includes("demand increases. What happens?")
    );
    const acceptedFinding = await admin
      .from("agent_findings")
      .select("status")
      .eq("id", filed.data.id)
      .single();
    check("finding transitioned to accepted", acceptedFinding.data?.status === "accepted");

    /* ── 8. Reject rolls back atomically ── */
    console.log("\n— Reject (atomic rollback) —");
    const run2 = await admin
      .from("agent_runs")
      .insert({ course_id: fx.courseId, trigger: "scheduled", status: "queued" })
      .select("id")
      .single();
    if (run2.error) throw run2.error;
    const model2 = createMockModelClient(
      [
        { toolCalls: [{ name: "get_question_item_stats", arguments: { lessonId: null } }] },
        { text: "Still looks off." },
        {
          toolCalls: [
            {
              name: "write_quiz",
              arguments: {
                blockId: fx.quizBlockId,
                lessonId: null,
                title: "SECOND REWRITE",
                questions: [
                  { kind: "true_false", prompt: "Second pass?", explanation: "x", correctAnswer: true },
                ],
              },
            },
          ],
        },
        { text: "Rewrote again." },
      ],
      {
        finalText: "done",
        structured: {
          insight_report: {
            summary: "The question still underperforms.",
            findings: [
              {
                ...insightReport.findings[0],
                id: "f-quiz-2",
                evidence: {
                  metrics: { pctCorrect: 36 },
                  summary: "Still 36% correct — second pass.",
                },
              },
            ],
          },
          remediation_verdict: { addressed: true, summary: "Second rewrite." },
          comms_draft: {
            template: "stalled_nudge",
            subject: "x",
            paragraphs: ["y"],
          },
        },
      }
    );
    const result2 = await runMaintenanceRun({
      supabase: admin,
      model: model2,
      courseId: fx.courseId,
      ownerId: fx.author.userId,
      trigger: "scheduled",
      runId: run2.data.id,
      emit: () => {},
    });
    check("second run staged a new proposal", result2.status === "completed" && result2.changeSets === 1);
    const secondFinding = await admin
      .from("agent_findings")
      .select("change_set_id")
      .eq("course_id", fx.courseId)
      .eq("status", "proposed")
      .not("change_set_id", "is", null)
      .single();
    const secondChangeSetId = secondFinding.data!.change_set_id!;
    const midDoc = await loadCourseDoc(admin, fx.courseId);
    check(
      "the second rewrite is applied pre-review",
      JSON.stringify(findBlock(midDoc!, fx.quizBlockId)?.block).includes("SECOND REWRITE")
    );
    await rejectChangeSet(fx.author.client, secondChangeSetId, fx.author.userId);
    const afterReject = await loadCourseDoc(admin, fx.courseId);
    check(
      "reject restored the prior draft BYTE-FOR-BYTE",
      JSON.stringify(findBlock(afterReject!, fx.quizBlockId)?.block) === acceptedJson
    );
  } finally {
    console.log("\n— Cleanup —");
    const del = await fx.author.client.from("courses").delete().eq("id", fx.courseId);
    check("fixture course deleted (runs/findings/messages cascade)", del.error === null, del.error?.message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
