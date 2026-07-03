/**
 * The maintenance-agent ORCHESTRATOR (Milestone 5).
 *
 * One run = Analyst (read tools over the rollups) → dedupe/prioritize findings
 * (cap MAINTENANCE_MAX_FANOUT, adopting open threshold-filed rows) → dispatch
 * Remediation subagents SEQUENTIALLY over the shared draft doc (each staging a
 * per-finding change-set whose items carry the finding's evidence) in parallel
 * with Comms subagents (drafting learner_messages rows — NEVER sending) → one
 * aggregated report persisted to agent_runs (the replay artifact).
 *
 * Safety rails (hard):
 *   • DRAFT only — every content mutation flows through the same CoursePatch →
 *     change-set pipeline as the human editor; nothing touches publications.
 *   • No sends: this module never imports the comms send seam; drafts are all
 *     it can produce. No enrollment mutation anywhere.
 *   • Every model call rides the global semaphore (≤2 concurrent) and ONE
 *     shared call+token budget; exhaustion skips remaining findings into
 *     report.skipped (they stay `open` for the next run).
 *   • Runs are fully logged: agent_runs.report carries the InsightReport, the
 *     dispatch map, and per-subagent transcripts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  buildSnapshotMaps,
  loadCourseAnalytics,
  type CourseAnalytics,
  type SnapshotMaps,
} from "@/lib/analytics/dashboard";
import { buildTemplate, type CommsTemplateId, type TemplateContext } from "@/lib/comms/templates";
import { createDraft } from "@/lib/comms/service";
import type { EmailBody } from "@/lib/comms/types";
import { findLesson } from "@/lib/course/queries";
import type { CourseDocument } from "@/lib/course/types";
import { getLivePublicationByCourse, parsePublicationSnapshot } from "@/lib/learn/resolve";
import {
  loopContext,
  reconcileDoc,
  stageChangeSetWithEvidence,
  type AgentRunParams,
  type LoopContext,
  type PhaseUsage,
} from "./agentLoop";
import { saveAssistantMessage } from "./conversations";
import type { AgentEvent } from "./events";
import {
  CommsDraftSchema,
  dedupeAndPrioritize,
  FindingSchema,
  InsightReportSchema,
  parseAnalysisScope,
  type AnalysisScope,
  type Finding,
  type PrioritizedFinding,
} from "./maintenanceSchema";
import type { ModelClient } from "./modelClient";
import { loadCourseDoc } from "./serverPersistence";
import { runSubagent, withSemaphore, type TokenBudget } from "./subagent";
import { ANALYST_TOOL_NAMES, REMEDIATION_TOOL_NAMES } from "./tools";
import type { AnalyticsToolContext, LearnerProfileJson } from "./tools/types";
import { z } from "zod";

type DB = SupabaseClient<Database>;

/* ─────────────────────────────── Budgets ───────────────────────────────── */

export const MAINTENANCE_MAX_CALLS = Math.max(
  4,
  Number(process.env.MAINTENANCE_MAX_CALLS) || 40
);
export const MAINTENANCE_MAX_TOKENS = Math.max(
  20_000,
  Number(process.env.MAINTENANCE_MAX_TOKENS) || 300_000
);
export const MAINTENANCE_MAX_FANOUT = Math.max(
  1,
  Number(process.env.MAINTENANCE_MAX_FANOUT) || 5
);

/* ───────────────────────────── System prompts ──────────────────────────── */

const ANALYST_SYSTEM = `You are the WiseSel course ANALYST. You investigate learner analytics for ONE course using the read tools and produce evidence-grounded findings — never guesses.

Method:
1. Start with get_course_health_summary. Follow the signals: get_question_item_stats for flagged questions (then get_block/get_lesson to QUOTE the actual question wording in your evidence), get_lesson_funnel for drop-offs, get_slide_dwell_outliers for pacing, get_struggling_learners (+ get_learner_profile) for at-risk learners.
2. Every finding must cite concrete metrics (counts, percentages) in evidence.metrics and make its one-sentence case in evidence.summary — the creator sees that sentence verbatim, e.g. "Q3: 64% incorrect over 41 attempts; distractor B chosen 3× the key — likely ambiguous wording."
3. kinds: content_issue (a question/slide/lesson needs fixing — set targets.lessonId/blockId/questionId), learner_risk (a specific learner needs a check-in — set targets.userId), structure_gap (missing/misordered coverage the funnel exposes — set targets.lessonId).
4. severity: high = actively hurting many learners; medium = clear but contained; low = polish.
5. Prefer FEW, well-evidenced findings over many thin ones. If the data is healthy, say so — an empty findings list is a valid result.

End your tool session with a thorough prose analysis of everything you found (it feeds the structured report).`;

const REMEDIATION_SYSTEM = `You are the WiseSel REMEDIATION agent. You fix EXACTLY ONE evidenced content issue in a course draft — nothing else.

Rules:
- Address only the finding you were given. Do not restructure the course, touch other lessons, or "improve" unrelated content.
- Keep the creator's voice and the lesson's existing style. Prefer the SMALLEST edit that resolves the evidence: reword an ambiguous question, fix a wrong/misleading distractor, split an overloaded slide, add a missing worked example.
- For quiz fixes: the evidence tells you HOW learners failed (which distractor drew them, how the wording misleads). Fix the cause, keep the pedagogical intent, and make sure the correct answer stays genuinely correct.
- Your edits are staged for the creator's review with your evidence attached — they can reject everything, so act decisively but conservatively.

When you're done, briefly state what you changed and why it resolves the evidence.`;

const COMMS_SYSTEM = `You draft a SHORT, WARM check-in email from a course creator to one of their learners. You are given the learner's situation and a template skeleton.

Rules:
- Sound like a person, not a platform: first person, specific to this learner's situation, zero guilt-tripping, zero marketing tone.
- 1–3 short paragraphs. Don't repeat the greeting or sign-off (they're added around your paragraphs).
- Never invent facts about the learner. Use only what you're told.
- The email is a DRAFT the creator will edit and approve — it is never sent automatically.`;

const RemediationVerdictSchema = z.object({
  addressed: z.boolean(),
  summary: z.string().min(1).max(500),
});

/* ─────────────────────────── Run parameters ────────────────────────────── */

export interface MaintenanceRunParams {
  supabase: DB;
  model: ModelClient;
  courseId: string;
  ownerId: string;
  trigger: "chat" | "scheduled" | "threshold";
  /** Claim an existing queued row (scheduled drain) instead of inserting. */
  runId?: string;
  scope?: AnalysisScope;
  /** Chat only — the final summary is saved to this conversation. */
  conversationId?: string | null;
  lessonId?: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface MaintenanceRunResult {
  runId: string;
  status: "completed" | "failed";
  summary: string;
  findings: number;
  changeSets: number;
  drafts: number;
}

/* ───────────────────── Analytics capability builder ────────────────────── */

async function buildAnalyticsCapability(
  supabase: DB,
  courseId: string,
  publicationId: string,
  snapshotMaps: SnapshotMaps
): Promise<{ capability: AnalyticsToolContext; data: CourseAnalytics }> {
  const data = await loadCourseAnalytics(supabase, courseId, publicationId);
  const profileCache = new Map<string, LearnerProfileJson | null>();

  async function loadLearnerProfile(userId: string): Promise<LearnerProfileJson | null> {
    if (profileCache.has(userId)) return profileCache.get(userId) ?? null;
    const roster = data.roster.find((r) => r.user_id === userId);
    if (!roster) {
      profileCache.set(userId, null);
      return null;
    }
    const [progress, attempts] = await Promise.all([
      supabase
        .from("learn_progress")
        .select("lesson_id, status, pct, last_activity_at")
        .eq("course_id", courseId)
        .eq("user_id", userId),
      supabase
        .from("quiz_attempts")
        .select("block_id, attempt_number, score, max_score, submitted_at")
        .eq("course_id", courseId)
        .eq("user_id", userId)
        .order("submitted_at", { ascending: false })
        .limit(5),
    ]);
    const lastActivity = (progress.data ?? [])
      .map((r) => r.last_activity_at)
      .sort()
      .at(-1);
    const profile: LearnerProfileJson = {
      userId,
      displayName: roster.display_name,
      enrolledAt: roster.enrolled_at,
      enrollmentStatus: roster.enrollment_status,
      progressPct: Number(roster.progress_pct ?? 0),
      completedLessons: roster.completed_lessons,
      totalLessons: roster.total_lessons,
      lastActivityAt: lastActivity ?? null,
      flags: data.flags.filter((f) => f.user_id === userId).map((f) => f.flag_type),
      recentAttempts: (attempts.data ?? []).map((a) => ({
        blockId: a.block_id,
        attempt: a.attempt_number,
        scorePct: Math.round((100 * a.score) / Math.max(1, a.max_score)),
        at: a.submitted_at,
      })),
    };
    profileCache.set(userId, profile);
    return profile;
  }

  return { capability: { data, maps: snapshotMaps, loadLearnerProfile }, data };
}

/* ─────────────────────────── Small helpers ─────────────────────────────── */

/** Compact JSON brief of one lesson for the Remediation context (capped). */
function lessonBrief(doc: CourseDocument, lessonId: string): string {
  const found = findLesson(doc, lessonId);
  if (!found) return "(lesson not found in the draft)";
  const lesson = found.lesson;
  const brief = {
    lessonId: lesson.id,
    title: lesson.title,
    blocks: lesson.blocks.map((b) => ({
      id: b.id,
      type: b.type,
      title: b.title ?? "",
      ...(b.type === "quiz"
        ? {
            questions: b.questions.map((q) => ({
              id: q.id,
              kind: q.kind,
              prompt: q.prompt,
              ...("choices" in q
                ? { choices: q.choices.map((c) => ({ id: c.id, text: c.text })) }
                : {}),
            })),
          }
        : {}),
    })),
  };
  const json = JSON.stringify(brief);
  return json.length > 6000 ? `${json.slice(0, 6000)}…(truncated)` : json;
}

function findingEvidenceJson(finding: Finding): Json {
  return {
    findingId: finding.id,
    kind: finding.kind,
    severity: finding.severity,
    title: finding.title,
    summary: finding.evidence.summary,
    metrics: finding.evidence.metrics,
    targets: finding.targets,
    recommendation: finding.recommendation,
  } as unknown as Json;
}

/** Insert (or adopt) one prioritized finding; returns its agent_findings id. */
async function persistFinding(
  supabase: DB,
  courseId: string,
  runId: string,
  item: PrioritizedFinding
): Promise<string | null> {
  if (item.adoptedFindingId) {
    const { error } = await supabase
      .from("agent_findings")
      .update({ run_id: runId, finding: item.finding as unknown as Json })
      .eq("id", item.adoptedFindingId);
    if (error) console.error("[maintenance] adopt finding failed", error.message);
    return item.adoptedFindingId;
  }
  const insert = await supabase
    .from("agent_findings")
    .insert({
      run_id: runId,
      course_id: courseId,
      kind: item.finding.kind,
      severity: item.finding.severity,
      dedupe_key: item.dedupeKey,
      finding: item.finding as unknown as Json,
    })
    .select("id")
    .maybeSingle();
  if (insert.error) {
    // 23505 = an open row with this key raced in (e.g. tonight's filing) — adopt it.
    if (insert.error.code === "23505") {
      const existing = await supabase
        .from("agent_findings")
        .select("id")
        .eq("course_id", courseId)
        .eq("dedupe_key", item.dedupeKey)
        .eq("status", "open")
        .maybeSingle();
      if (existing.data) {
        await supabase
          .from("agent_findings")
          .update({ run_id: runId, finding: item.finding as unknown as Json })
          .eq("id", existing.data.id);
        return existing.data.id;
      }
    }
    console.error("[maintenance] persist finding failed", insert.error.message);
    return null;
  }
  return insert.data?.id ?? null;
}

function addUsage(total: PhaseUsage, part: PhaseUsage): void {
  total.inputTokens += part.inputTokens;
  total.outputTokens += part.outputTokens;
  total.reasoningTokens += part.reasoningTokens;
  total.cachedTokens += part.cachedTokens;
}

/* ───────────────────────────── The orchestrator ────────────────────────── */

export async function runMaintenanceRun(p: MaintenanceRunParams): Promise<MaintenanceRunResult> {
  // 1. Create or claim the run row.
  let runId = p.runId ?? null;
  if (runId) {
    const claim = await p.supabase
      .from("agent_runs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", runId)
      .in("status", ["queued", "running"])
      .select("id");
    if (claim.error || (claim.data ?? []).length === 0) {
      throw new Error("Could not claim the queued maintenance run.");
    }
  } else {
    const inserted = await p.supabase
      .from("agent_runs")
      .insert({
        course_id: p.courseId,
        trigger: p.trigger,
        status: "running",
        scope: (p.scope ?? null) as unknown as Json,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (inserted.error) throw inserted.error;
    runId = inserted.data.id;
  }

  const usage: PhaseUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  const tokenBudget: TokenBudget = { remaining: MAINTENANCE_MAX_TOKENS };
  const transcripts: Record<string, { tool: string; summary: string }[]> = {};
  const dispatched: { findingId: string; kind: string; changeSetId?: string; messageId?: string }[] = [];
  const skipped: { findingId: string; reason: string }[] = [];
  let changeSets = 0;
  let drafts = 0;

  const fail = async (message: string): Promise<MaintenanceRunResult> => {
    await p.supabase
      .from("agent_runs")
      .update({ status: "failed", error: message.slice(0, 500), finished_at: new Date().toISOString() })
      .eq("id", runId!);
    p.emit({ type: "error", message });
    return { runId: runId!, status: "failed", summary: message, findings: 0, changeSets, drafts };
  };

  try {
    p.emit({ type: "maintenance", stage: "analyze", detail: "Reading the course's learner analytics…" });

    // 2. Load the draft + the live publication + the analytics capability.
    let doc = await loadCourseDoc(p.supabase, p.courseId).catch(() => null);
    if (!doc) return await fail("Course not found or failed to load.");
    const publication = await getLivePublicationByCourse(p.supabase, p.courseId);
    if (!publication) {
      return await fail(
        "This course has no live publication yet — learner analytics only exist for published versions. Publish first, then ask me again."
      );
    }
    const snapshot = parsePublicationSnapshot(publication);
    const maps = buildSnapshotMaps(snapshot);
    const { capability } = await buildAnalyticsCapability(p.supabase, p.courseId, publication.id, maps);

    // 3. The shared context: semaphore-wrapped model + ONE call/token budget.
    const c: LoopContext = {
      ...loopContext({
        supabase: p.supabase,
        model: withSemaphore(p.model),
        courseId: p.courseId,
        lessonId: p.lessonId ?? "",
        ownerId: p.ownerId,
        conversationId: p.conversationId ?? "",
        emit: p.emit,
        signal: p.signal,
      }),
      callBudget: { remaining: MAINTENANCE_MAX_CALLS },
      analytics: capability,
    };

    // 4. Open threshold-filed findings → Analyst context + adoption pool.
    const openRows = await p.supabase
      .from("agent_findings")
      .select("id, dedupe_key, finding")
      .eq("course_id", p.courseId)
      .eq("status", "open");
    const thresholdRows = (openRows.data ?? []).flatMap((r) => {
      const parsed = FindingSchema.safeParse(r.finding);
      return parsed.success ? [{ id: r.id, dedupe_key: r.dedupe_key, finding: parsed.data }] : [];
    });

    // 5. Analyst.
    const scopeNote = p.scope?.lessonIds?.length
      ? `SCOPE: restrict the analysis to these lesson ids (the creator asked about them): ${p.scope.lessonIds.join(", ")}.`
      : "SCOPE: the whole course.";
    const thresholdNote = thresholdRows.length
      ? `PREVIOUSLY FLAGGED by nightly thresholds (verify and enrich rather than rediscover):\n${thresholdRows
          .map((r) => `- [${r.finding.severity}] ${r.finding.evidence.summary}`)
          .join("\n")}`
      : "No previously-flagged findings are open.";

    const analyst = await runSubagent({
      c,
      role: "analyst",
      systemPrompt: ANALYST_SYSTEM,
      context: `${scopeNote}\n\n${thresholdNote}`,
      userMessage:
        p.scope?.prompt ??
        "Run a full course-health analysis and report your findings as the structured InsightReport.",
      outputSchema: InsightReportSchema,
      outputName: "insight_report",
      tools: ANALYST_TOOL_NAMES,
      doc,
      maxTurns: 6,
      tokenBudget,
    });
    addUsage(usage, analyst.usage);
    transcripts.analyst = analyst.transcript;
    if (!analyst.ok || !analyst.data) {
      return await fail(
        analyst.error === "budget_exhausted"
          ? "The analysis ran out of budget before producing a report."
          : "The analyst could not produce a valid report. Try again."
      );
    }
    const insight = analyst.data;

    // 6. Dedupe + prioritize (adopting open threshold rows), cap the fan-out.
    const prioritized = dedupeAndPrioritize(insight.findings, thresholdRows, MAINTENANCE_MAX_FANOUT);
    p.emit({
      type: "maintenance",
      stage: "findings",
      detail: `${prioritized.length} finding(s) to act on`,
      findings: prioritized.map((f) => ({
        id: f.finding.id,
        kind: f.finding.kind,
        severity: f.finding.severity,
        title: f.finding.title,
      })),
    });

    // Persist every prioritized finding (run-linked).
    const findingIds = new Map<string, string>(); // finding.id → agent_findings.id
    for (const item of prioritized) {
      const id = await persistFinding(p.supabase, p.courseId, runId, item);
      if (id) findingIds.set(item.finding.id, id);
    }

    // 7. Dispatch. Remediation runs SEQUENTIALLY over the shared doc (no doc
    // races — concurrency lives in the semaphore-capped model calls); Comms
    // drafts run CONCURRENTLY alongside.
    const contentFindings = prioritized.filter(
      (f) => f.finding.kind !== "learner_risk" && f.finding.targets.lessonId
    );
    const riskFindings = prioritized.filter(
      (f) => f.finding.kind === "learner_risk" && f.finding.targets.userId
    );
    for (const f of prioritized) {
      if (!contentFindings.includes(f) && !riskFindings.includes(f)) {
        skipped.push({ findingId: f.finding.id, reason: "no actionable target" });
      }
    }

    const remediateAll = async () => {
      for (const item of contentFindings) {
        const rowId = findingIds.get(item.finding.id);
        if (tokenBudget.remaining <= 0 || (c.callBudget?.remaining ?? 1) <= 0) {
          skipped.push({ findingId: item.finding.id, reason: "budget" });
          continue;
        }
        p.emit({
          type: "maintenance",
          stage: "remediate",
          detail: `Proposing a fix: ${item.finding.title}`,
        });
        const lessonId = item.finding.targets.lessonId!;
        const baseline = structuredClone(doc!);
        const result = await runSubagent({
          c,
          role: "remediation",
          systemPrompt: REMEDIATION_SYSTEM,
          context: `THE FINDING (fix exactly this):\n${JSON.stringify(item.finding)}\n\nTHE TARGET LESSON (draft):\n${lessonBrief(doc!, lessonId)}`,
          userMessage:
            "Apply the smallest edit that resolves the evidence, then report whether you addressed it.",
          outputSchema: RemediationVerdictSchema,
          outputName: "remediation_verdict",
          tools: REMEDIATION_TOOL_NAMES,
          doc: doc!,
          lessonId,
          maxTurns: 8,
          tokenBudget,
        });
        addUsage(usage, result.usage);
        transcripts[`remediation:${item.finding.id}`] = result.transcript;
        if (result.doc && result.docMutated) {
          doc = result.doc;
          await reconcileDoc(c, doc);
          const cs = await stageChangeSetWithEvidence(
            { ...c, lessonId },
            doc,
            baseline,
            null,
            findingEvidenceJson(item.finding)
          );
          if (cs && rowId) {
            changeSets += 1;
            await p.supabase
              .from("agent_findings")
              .update({ status: "proposed", change_set_id: cs.changeSetId })
              .eq("id", rowId);
            dispatched.push({
              findingId: item.finding.id,
              kind: item.finding.kind,
              changeSetId: cs.changeSetId,
            });
            continue;
          }
        }
        skipped.push({
          findingId: item.finding.id,
          reason: result.truncated ? "budget" : "no change produced",
        });
      }
    };

    const commsOne = async (item: PrioritizedFinding) => {
      const rowId = findingIds.get(item.finding.id);
      const userId = item.finding.targets.userId!;
      if (tokenBudget.remaining <= 0 || (c.callBudget?.remaining ?? 1) <= 0) {
        skipped.push({ findingId: item.finding.id, reason: "budget" });
        return;
      }
      const profile = await capability.loadLearnerProfile(userId);
      if (!profile) {
        skipped.push({ findingId: item.finding.id, reason: "learner not found" });
        return;
      }
      p.emit({
        type: "maintenance",
        stage: "comms",
        detail: `Drafting a check-in for ${profile.displayName}`,
      });

      // Pick the template skeleton from the learner's situation.
      const failing = profile.flags.includes("repeated_quiz_failure");
      const templateId: CommsTemplateId = failing
        ? "struggling_topic"
        : profile.progressPct >= 70
          ? "almost_done"
          : "stalled_nudge";
      const failedBlock = profile.recentAttempts[0]?.blockId;
      const failedLesson = failedBlock ? maps.blocks.get(failedBlock) : undefined;
      const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
      const creator = await p.supabase
        .from("profiles")
        .select("display_name")
        .eq("id", p.ownerId)
        .maybeSingle();
      const tctx: TemplateContext = {
        learnerName: profile.displayName,
        creatorName: creator.data?.display_name ?? "Your course creator",
        courseTitle: snapshot.course.title || "the course",
        courseUrl: `${base}/learn/${publication.slug}`,
        lessonTitle: failedLesson?.lessonTitle,
        lessonUrl: failedLesson ? `${base}/learn/${publication.slug}/${failedLesson.lessonId}` : undefined,
      };
      const skeleton = buildTemplate(templateId, tctx);

      // Personalize via the model — deterministic template fallback on failure
      // (a draft ALWAYS exists for the creator to edit).
      const draft = await runSubagent({
        c,
        role: "comms",
        systemPrompt: COMMS_SYSTEM,
        context: `LEARNER SITUATION:\n${JSON.stringify({ profile, finding: item.finding.evidence.summary })}\n\nTEMPLATE SKELETON (match its intent, personalize the middle):\n${JSON.stringify(skeleton)}`,
        userMessage: "Write the personalized draft.",
        outputSchema: CommsDraftSchema,
        outputName: "comms_draft",
        tokenBudget,
      });
      addUsage(usage, draft.usage);

      let subject = skeleton.subject;
      let body: EmailBody = skeleton.body;
      if (draft.ok && draft.data) {
        subject = draft.data.subject;
        const button = skeleton.body.find((b) => b.kind === "button");
        body = [
          { kind: "paragraph", text: `Hi ${profile.displayName},` },
          ...draft.data.paragraphs.map((text) => ({ kind: "paragraph" as const, text })),
          ...(button ? [button] : []),
          { kind: "paragraph", text: `— ${tctx.creatorName}` },
        ];
      }
      try {
        const message = await createDraft(p.supabase, {
          courseId: p.courseId,
          userId,
          findingId: rowId ?? null,
          subject,
          body,
        });
        drafts += 1;
        if (rowId) {
          await p.supabase.from("agent_findings").update({ status: "proposed" }).eq("id", rowId);
        }
        dispatched.push({ findingId: item.finding.id, kind: item.finding.kind, messageId: message.id });
      } catch (err) {
        console.error("[maintenance] draft insert failed", err);
        skipped.push({ findingId: item.finding.id, reason: "draft insert failed" });
      }
    };

    await Promise.all([remediateAll(), Promise.all(riskFindings.map((f) => commsOne(f)))]);

    // 8. Settle the run.
    const budgetUsed = {
      calls: MAINTENANCE_MAX_CALLS - (c.callBudget?.remaining ?? 0),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cachedTokens: usage.cachedTokens,
    };
    const report = {
      insight,
      dispatched,
      skipped,
      transcripts,
      truncated: analyst.truncated || tokenBudget.remaining <= 0,
    };
    await p.supabase
      .from("agent_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        report: report as unknown as Json,
        budget_used: budgetUsed as unknown as Json,
      })
      .eq("id", runId);

    p.emit({
      type: "maintenance",
      stage: "report",
      detail: `${changeSets} proposal(s) staged · ${drafts} draft message(s)`,
    });
    console.log(
      JSON.stringify({
        tag: "maintenance_run",
        runId,
        trigger: p.trigger,
        findings: prioritized.length,
        changeSets,
        drafts,
        skipped: skipped.length,
        ...budgetUsed,
      })
    );
    return {
      runId,
      status: "completed",
      summary: insight.summary,
      findings: prioritized.length,
      changeSets,
      drafts,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Maintenance run failed.";
    return await fail(message);
  }
}

/* ─────────────────────────── The chat trigger ──────────────────────────── */

/** The `analyze` intent's entry — parses scope from the message, runs the
 *  orchestrator, and settles the conversation with a summary message. */
export async function runMaintenanceTurn(
  p: AgentRunParams,
  doc: CourseDocument
): Promise<void> {
  const scope = parseAnalysisScope(doc, p.userMessage);
  try {
    const result = await runMaintenanceRun({
      supabase: p.supabase,
      model: p.model,
      courseId: p.courseId,
      ownerId: p.ownerId,
      trigger: "chat",
      scope,
      conversationId: p.conversationId,
      lessonId: p.lessonId,
      emit: p.emit,
      signal: p.signal,
    });
    const content =
      result.status === "completed"
        ? `${result.summary}\n\n${
            result.changeSets > 0
              ? `I've staged ${result.changeSets} evidence-backed proposal(s) for your review — each shows WHY above Accept/Reject. `
              : ""
          }${
            result.drafts > 0
              ? `I've also drafted ${result.drafts} learner check-in(s) — review, edit, and approve them in the panel; nothing sends without you.`
              : ""
          }`.trim()
        : result.summary;
    await saveAssistantMessage(p.supabase, p.conversationId, p.courseId, {
      text: content,
      toolCalls: [],
    });
    p.emit({ type: "assistant_message", content });
  } finally {
    p.emit({ type: "done" });
  }
}
