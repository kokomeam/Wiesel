/**
 * TUTOR-1 Wave 3 (package C2) — the LIVE tutor turn loop.
 *
 * `runTutorTurn` is the single orchestration point for one learner turn: it
 * assembles the byte-stable layered prompt (L0..L4), runs a BOUNDED tool loop
 * (≤3 rounds) over the FIVE tutor tools, parses the structured turn output,
 * applies the deterministic scaffolding overrides, validates grounding against
 * the learner's own snapshot, and returns a fully-cleaned result the ROUTE
 * (Wave 3 §C3) persists + emits from.
 *
 * ── DESIGN INVARIANTS ────────────────────────────────────────────────────────
 *  • DETERMINISTIC + FULLY MOCKABLE: every model call goes through deps.model
 *    (the mock's scripted/structured seam); no wall-clock (nowIso is a seam);
 *    ids come from the caller's inputs, not Date.now.
 *  • NEVER THROWS: any failure settles into { ok:false, error } — the same
 *    contract as runGraphExtraction. A learner turn must never crash the route.
 *  • The MODEL is already pooled by the caller (withPooledModel) — the loop
 *    never wraps it again.
 *  • emit_evidence WRITES NOTHING here — the route emits the queued inferences.
 *
 * ── ORDER OF OPERATIONS (load-bearing) ───────────────────────────────────────
 *  model structured output
 *    → applyScaffolding (rung overrides: just-show-me / opening-turn clamp)
 *    → validateTurnOutput (citations resolve · canon suppression · grounding)
 *    → return { output: cleaned, flags, ok }.
 *  Scaffolding runs on the RAW TurnOutput (it needs the marker prose + rung);
 *  validation then cleans the (rung-adjusted) output.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import type {
  ModelClient,
  ModelInputItem,
  ModelStreamEvent,
} from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { getCachedSnapshot } from "@/lib/learn/publicationCache";
import { TUTOR_MASTERY_THRESHOLD } from "@/lib/tutor/mastery/config";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";

import { resolveCharter, serializeCharter, type TutorCharter } from "./charter";
import { assembleLessonContext, type LessonConceptNode } from "./lessonContext";
import { assembleLearnerState } from "./learnerState";
import {
  serializeHistory,
  collapseToChaining,
  HISTORY_MAX_TURNS,
  type HistoryTurn,
} from "./history";
import {
  assembleTutorPrompt,
  LAYER_BUDGETS,
} from "./promptLayers";
import {
  TurnOutputSchema,
  type TurnOutput,
} from "./outputContract";
import {
  applyScaffolding,
  detectJustShowMe,
} from "./scaffolding";
import {
  buildSnapshotIndex,
  validateTurnOutput,
  type SnapshotIndex,
  type ValidatedTurn,
} from "./grounding";
import {
  deriveSessionState,
  shouldInterjectRootCause,
  ROOT_CAUSE_INTERJECTION_MARKER,
  type SessionTurn,
} from "./session";
import {
  TUTOR_TOOLS,
  TUTOR_TOOL_NAMES,
  gatherLearnerState,
  insertEscalationCandidate,
  type MintedPracticeItem,
  type TutorToolCtx,
  type TutorToolDeps,
} from "./tools";
import { tierOf } from "./toolTiers";
import {
  applyInvocationPolicy,
  effectiveCooldown,
  invitationToolForRung,
  CLASS_A_TOOL_NAMES,
  INVITATION_LABELS,
  type InvitationState,
  type TurnInitiation,
  type TurnInvitation,
} from "./invocationPolicy";
import type {
  AssessmentCard,
  AssessmentInitiation,
  RenderStructureCard,
} from "./toolsA3";
import { evaluateEscalationTrigger } from "./escalationTriggers";
import type { TurnEscalationProposal } from "./outputContract";
import type { TutorInferencePayload } from "@/lib/analytics/events";
import type { z } from "zod";

type DB = SupabaseClient<Database>;

/** The `guidanceStyle` field on the charter maps 1:1 to the scaffolding style. */
type GuidanceStyle = TutorCharter["guidanceStyle"];

/* ─────────────────────────────── inputs ─────────────────────────────────── */

export interface RunTutorTurnDeps {
  /** Learner-scoped client (own mastery/queue/thread reads). */
  learnerClient: DB;
  /** Admin client (the ONE write — propose_escalation). */
  serviceClient: DB;
  /** ALREADY POOLED ModelClient (the caller wraps it via withPooledModel). */
  model: ModelClient;
  /** Injectable snapshot loader (defaults to getCachedSnapshot). */
  loadSnapshot?: (publicationId: string) => Promise<{ snapshot: PublicationSnapshot }>;
  /** The course's concept nodes (anchors drive L2/L3 + get_lesson_context). */
  conceptNodes: LessonConceptNode[];
  /** The course's concept edges (root-cause + prerequisite adjacency). */
  conceptEdges: EdgeLike[];
  /** Wall-clock seam (deterministic tests); reserved for future recency use. */
  nowIso?: string;
  /** Abort seam — threaded into every model call (cancel a stalled turn). */
  signal?: AbortSignal;
  /** Wave A2: observability hook — receives every normalized stream event of the
   *  MAIN structured call (started/text_delta/...); the service uses it for early
   *  chain-id capture; Wave 2 forwards deltas to the wire. Best-effort — a hook
   *  throw is swallowed and never kills the turn. */
  onModelEvent?: (ev: ModelStreamEvent) => void;
}

export interface RunTutorTurnCtx {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId?: string;
  blockId?: string;
  slideId?: string;
  /** Ambient assessment state — the model scaffolds (never states) a live answer. */
  quizActive?: boolean;
  /** The raw tutor_course_settings row (or null → charter defaults). */
  charterRow: Database["public"]["Tables"]["tutor_course_settings"]["Row"] | null;
  /** The replayed thread tail (oldest → newest). */
  historyTurns: HistoryTurn[];
  /** THIS turn's learner message. */
  learnerMessage: string;
  /** Opaque session flags (reserved — carried through, not interpreted). */
  sessionFlags?: Record<string, unknown>;
  /** A3 Wave 3 — THIS turn's SERVER-RESOLVED initiation (default question). The
   *  SERVICE resolves acceptance claims against the prior invitation BEFORE the
   *  loop runs; the loop never re-derives it. */
  initiation?: TurnInitiation;
  /** A3 Wave 3 — the derived invitation state over the session window (the
   *  service computes it from the loaded history via deriveInvitationState).
   *  Absent ⇒ no prior offers (direct callers / tests). */
  invitationState?: InvitationState;
}

/* ─────────────────────────────── result ─────────────────────────────────── */

export interface TutorTurnResult {
  ok: boolean;
  /** The cleaned, validated turn (marker-free prose + resolved citations). */
  output: ValidatedTurn["cleaned"] | null;
  /** Grounding flags (citation_dropped / anchor_downgraded / ungrounded / …). */
  groundingFlags: string[];
  /** The raw evidence payloads the tutor emitted (the ROUTE emits these). */
  evidence: TutorInferencePayload[];
  /** Practice items minted this turn (generate_practice), if any. */
  practiceItems: MintedPracticeItem[];
  /** The escalation, when propose_escalation ran (candidateId or null). */
  escalation: { candidateId: string | null; consentRequired: true } | null;
  /** One {tool, summary} per tool call executed (replayable trace). */
  toolTrace: { tool: string; summary: string }[];
  /** Accumulated token usage across every model round. */
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number };
  /** The LAST round's provider response id (the chaining anchor for the next turn). */
  responseId: string | null;
  /** The rung the turn resolved at (post-scaffolding), for the row + telemetry. */
  rung: number | null;
  /** W3.5 · session markers stamped on THIS turn (e.g. 'root_cause_interjection').
   *  Persisted into the assistant row's grounding jsonb so the NEXT turn's derived
   *  session state sees which once-per-session behaviors already fired. */
  sessionMarkers: string[];
  /** A2 · the fail-closed approval gate: when the model requests an IRREVERSIBLE
   *  (or unclassified/unknown) tool, the loop HALTS BEFORE executing it and settles
   *  a completed-but-gated turn with this field set to the offending tool name.
   *  The turn is `ok:false` + `output:null` (nothing FAILED — nothing RAN either),
   *  so service.ts step (6) `if (!turn.ok || !turn.output)` skips ALL assistant
   *  persistence + evidence emission. The ROUTE maps this to an approval_required
   *  wire frame. Absent/null on every non-gated turn. */
  approvalRequired?: { toolName: string } | null;
  /** A3 Wave 3 — the AT-MOST-ONE quiet invitation this turn offers (question
   *  turns only: a downgraded Class-A tool call or a stripped model-emitted
   *  practice attach). The service stamps it into the assistant grounding (the
   *  offered-marker the NEXT turn's derived state reads); the route surfaces it
   *  on the settled `turn` payload. Null/absent when none. */
  invitation?: TurnInvitation | null;
  /** A3 Wave 4 — the renderStructure cards this turn produced (Class P). They ride
   *  ANY turn incl. a question turn (A3-12) — NEVER stripped. Default []. */
  structures: RenderStructureCard[];
  /** A3 Wave 4 — the checkUnderstanding / sequenceTask cards this turn produced
   *  (Class A). Forced [] on a question turn (mirrors practiceItems). The sink
   *  stamps each card's `initiation` from the turn ctx. Default []. */
  assessments: AssessmentCard[];
  error?: string;
}

/* ─────────────────────────────── constants ──────────────────────────────── */

/** The bounded tool-loop cap — ≤3 rounds (Wave 3 §3.1: the interactive turn). */
const MAX_TOOL_ROUNDS = 3;

/** How many chars of each history turn seed the recent-session synopsis (≤6). */
const SYNOPSIS_CHARS = 80;

/* ── W3.5 · session behaviors + assessment integrity ─────────────────────────
 *
 * The highest rung a `concept_review_only` charter permits while a quiz is LIVE.
 * A rung-4 verbatim answer is never allowed during an active assessment; rung 3
 * (a worked partial that still leaves the last step) is the ceiling, so concept
 * scaffolding continues but the on-screen question is never handed over. */
export const ASSESSMENT_ACTIVE_MAX_RUNG = 3;

/** Default copy the loop appends when it CLAMPS a would-be full answer during an
 *  active assessment (concept_review_only). `charter.toneNotes` tweaks the voice
 *  via `assessmentDeferCopy(toneNotes)` — never the substance. */
export const ASSESSMENT_DEFER_COPY =
  "I can't hand over the answer to a live quiz question — but I'll gladly walk the concept behind it right now, and the question itself the moment you've made your attempt.";

/** The tone-aware variant. A charter tone note is woven into a short lead so the
 *  defer reads in the creator's voice; the commitment (no verbatim answer, help
 *  with the concept) is invariant. */
export function assessmentDeferCopy(toneNotes?: string | null): string {
  const note = toneNotes?.trim();
  if (!note) return ASSESSMENT_DEFER_COPY;
  return `${ASSESSMENT_DEFER_COPY} (${note})`;
}

/** The typed refusal copy for a `block` charter while a quiz is live — the whole
 *  turn short-circuits to this (rung 0, zero model calls, zero evidence). */
export const ASSESSMENT_BLOCK_COPY =
  "While this quiz is in progress I can't help with it — that's the course's rule for graded work. As soon as you've submitted, I'm here to review any concept it covered.";

/** The per-turn instruction appended to the model input when a quiz is active.
 *  Names the integrity behavior so it rides the per-turn input (NOT L0). */
function assessmentInstruction(mode: "block" | "concept_review_only"): string {
  return mode === "block"
    ? "A graded quiz is ACTIVE and this course blocks assessment help: do not help with the quiz; warmly point to reviewing the concepts after the attempt."
    : "A graded quiz is ACTIVE: scaffold the underlying CONCEPT only — never state the answer to the on-screen question verbatim, at any rung. Concept review divorced from the live question is fine.";
}

/** The per-turn instruction appended when the root-cause interjection fires. */
function rootCauseInterjectionInstruction(title: string): string {
  return `If it feels natural this turn, briefly offer to check "${title}" first — offer it ONCE, and drop it immediately if the learner would rather push on.`;
}

/* ─────────────────────────────── the loop ───────────────────────────────── */

export async function runTutorTurn(
  deps: RunTutorTurnDeps,
  ctx: RunTutorTurnCtx
): Promise<TutorTurnResult> {
  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  // Hoisted so the outer catch can return whatever response id the turn HAD captured
  // (A2-3): the `started` event of the main call sets it BEFORE any output token, so
  // an aborted/thrown turn still surfaces the id it got — the chain stays coherent.
  let lastResponseId: string | null = null;
  const empty = (error: string): TutorTurnResult => ({
    ok: false,
    output: null,
    groundingFlags: [],
    evidence: [],
    practiceItems: [],
    escalation: null,
    toolTrace: [],
    usage,
    responseId: lastResponseId,
    rung: null,
    sessionMarkers: [],
    structures: [],
    assessments: [],
    error,
  });

  try {
    /* ── Charter (L1). ── */
    const charter = resolveCharter(ctx.charterRow);
    const style: GuidanceStyle = charter.guidanceStyle;

    /* ── Snapshot + index. ── */
    const loaded = deps.loadSnapshot
      ? await deps.loadSnapshot(ctx.publicationId)
      : await getCachedSnapshot(ctx.publicationId);
    const snapshot = loaded.snapshot;
    const index: SnapshotIndex = buildSnapshotIndex(snapshot);

    /* ── The docked lesson (fall back to the first lesson of the snapshot). ── */
    const lessonId = ctx.lessonId ?? firstLessonId(snapshot);

    /* ── L1 · L2. ── */
    const charterSerialized = serializeCharter(charter);
    const lessonContext = lessonId
      ? assembleLessonContext(snapshot, lessonId, deps.conceptNodes, {
          blockId: ctx.blockId,
          slideId: ctx.slideId,
          budgetChars: LAYER_BUDGETS.l2Chars,
        })
      : "LESSON: (none)";

    /* ── W6 · escalation trail: the session's rung history + accumulated cited
     *    anchors, read from the thread tail. These ride the tool ctx so a
     *    propose_escalation candidate carries the rung_trail + anchors (was []).
     *    The deterministic trigger later augments them with THIS turn's rung +
     *    resolved citations before it writes. ── */
    const sessionRungTrail = rungTrailFromHistory(ctx.historyTurns);
    const historyAnchors = anchorsFromHistory(ctx.historyTurns);

    /* ── Tool deps (shared by the loop's tool executions). ── */
    const toolCtx: TutorToolCtx = {
      userId: ctx.userId,
      courseId: ctx.courseId,
      publicationId: ctx.publicationId,
      version: ctx.version,
      lessonId,
      rungTrail: sessionRungTrail,
      anchors: historyAnchors,
    };
    const toolDeps: TutorToolDeps = {
      learnerClient: deps.learnerClient,
      serviceClient: deps.serviceClient,
      snapshot,
      snapshotIndex: index,
      conceptNodes: deps.conceptNodes,
      conceptEdges: deps.conceptEdges,
      charter,
      ctx: toolCtx,
      model: deps.model,
    };

    // Wall-clock seam (deterministic tests). Hoisted above L3 so the A3 Wave-5
    // explain-back session derivation + the W3.5 session state share one clock.
    const nowIso = deps.nowIso ?? new Date().toISOString();

    /* ── L3: the learner state (own rows, learner-scoped) + a recent synopsis. ── */
    const state = await gatherLearnerState(toolDeps);
    state.recentSynopsis = deriveSynopsis(ctx.historyTurns);

    /* ── A3 Wave 5 · the adaptive-tool deps (threaded AFTER L3 is built). ──
     *  masteryByNode: the learner's decayed mastery keyed by concept node id
     *  (R-1 — conceptSlug IS the node uuid); fadedExample derives its fade level
     *  from it (A3-16). explainBackConcepts: the node ids already explainBacked in
     *  THIS session window, so explainBack drops a per-session-per-concept
     *  duplicate. Both are optional deps the loop mutates onto toolDeps. */
    toolDeps.masteryByNode = new Map(state.masteryRows.map((r) => [r.nodeId, r.decayedP]));
    toolDeps.explainBackConcepts = explainBackedConceptsThisSession(ctx.historyTurns, nowIso);
    const learnerState = assembleLearnerState(state, {
      threshold: TUTOR_MASTERY_THRESHOLD,
      budgetChars: LAYER_BUDGETS.l3Chars,
    });

    /* ── W3.5 · SESSION STATE (derived from history) + the two behavior hooks. ──
     *
     * Session state is derived statelessly from the thread history (session.ts).
     * TWO behaviors ride the PER-TURN INPUT (never L0 — so the cached prefix is
     * untouched): the root-cause interjection instruction and the assessment-
     * integrity instruction. The `block` case short-circuits BEFORE any model
     * call; the concept_review_only clamp is applied AFTER scaffolding. */
    const sessionTurns: SessionTurn[] = ctx.historyTurns.map((t) => ({
      role: t.role,
      content: t.content,
      createdAt: t.createdAt ?? nowIso,
      grounding: t.grounding,
    }));
    const sessionState = deriveSessionState(sessionTurns, nowIso);

    // (a) ASSESSMENT INTEGRITY, mode 'block': short-circuit with a typed refusal
    //     BEFORE the model — zero model calls, zero evidence, rung 0, no citations.
    if (ctx.quizActive && charter.assessmentHelp === "block") {
      const spans = [{ kind: "grounded" as const, text: ASSESSMENT_BLOCK_COPY }];
      return {
        ok: true,
        output: {
          citations: [],
          rung: 0,
          evidence: [],
          practiceItems: undefined,
          escalationProposal: null,
          prose: ASSESSMENT_BLOCK_COPY,
          spans,
        },
        groundingFlags: [],
        evidence: [],
        practiceItems: [],
        escalation: null,
        toolTrace: [],
        usage,
        responseId: null,
        rung: 0,
        sessionMarkers: [],
        structures: [],
        assessments: [],
      };
    }

    /* ── A3 Wave 3 · INVOCATION-POLICY inputs. `initiation` is SERVER-RESOLVED
     *    (default question); the effective cooldown folds the pending offer the
     *    CURRENT message is about to resolve into the persisted trailing-ignore
     *    run — so a second consecutive brush-off suppresses the offer on THIS
     *    turn, not one turn late. ── */
    const initiation: TurnInitiation = ctx.initiation ?? { kind: "question" };
    const invitationState: InvitationState =
      ctx.invitationState ?? { priorInvitation: null, consecutiveIgnored: 0, cooldownActive: false };
    const cooldownActive = effectiveCooldown(invitationState, initiation);

    // (b) The extra per-turn instruction lines (input-only; L0 is never touched).
    const extraInstructions: string[] = [];

    // Assessment integrity for a LIVE quiz under concept_review_only.
    const assessmentActive = !!ctx.quizActive && charter.assessmentHelp === "concept_review_only";
    if (assessmentActive) {
      extraInstructions.push(assessmentInstruction("concept_review_only"));
    }

    // Root-cause interjection — fire at most ONCE per session (session.ts owns the
    // gate); the marker is stamped into THIS turn's grounding on the way out.
    const interject = shouldInterjectRootCause({
      sessionState,
      rootCauseNodeId: state.rootCauseNodeId,
      lessonNodeIds: state.lessonNodeIds,
    });
    let interjectionStamped = false;
    if (interject && state.rootCauseNodeId) {
      const title = state.nodeTitleById?.get(state.rootCauseNodeId) ?? state.rootCauseNodeId;
      extraInstructions.push(rootCauseInterjectionInstruction(title));
      interjectionStamped = true;
    }

    // A3 Wave 3/4 — per-turn initiation awareness (input-only; L0 stays
    // byte-stable). On acceptance, NAME THE MAPPED TOOL (the offer was produced by
    // invitationToolForRung): the accepted invitation's toolName is the tool to
    // call — checkUnderstanding / sequenceTask / generate_practice — so the
    // instruction no longer hard-codes generate_practice. A stale/unknown accepted
    // toolName degrades to the rung-mapped tool (fallback generate_practice).
    if (initiation.kind === "invitation_accepted") {
      const label = INVITATION_LABELS[initiation.toolName] ?? INVITATION_LABELS.generate_practice;
      const deliverTool = CLASS_A_TOOL_NAMES.has(initiation.toolName)
        ? initiation.toolName
        : invitationToolForRung(0);
      extraInstructions.push(
        `The learner accepted your invitation: ${label} on this concept. Deliver it now (call ${deliverTool} for that concept).`
      );
    } else if (initiation.kind === "practice_request") {
      extraInstructions.push("The learner explicitly asked for practice — deliver it directly this turn.");
    } else if (cooldownActive) {
      extraInstructions.push("Do not offer or attach practice this turn.");
    }

    /* ── L4: textual history, OR provider-side chaining when the flag is on. ── */
    const chained = collapseToChaining(ctx.historyTurns);
    const historyText = chained
      ? "" // chaining collapses the textual replay
      : serializeHistory(ctx.historyTurns, LAYER_BUDGETS.l4Chars);

    /* ── Assemble the prompt (system + developer + input). ── */
    const basePrompt = assembleTutorPrompt({
      charterSerialized,
      lessonContext,
      learnerState,
      historyText,
      learnerMessage: ctx.learnerMessage,
    });
    // Append the behavior instructions to the per-turn INPUT (after the message),
    // so the stable L0/L1/L2 prefix — the cache line — is byte-unchanged.
    const prompt = extraInstructions.length
      ? { ...basePrompt, input: `${basePrompt.input}\n\n${extraInstructions.join("\n")}` }
      : basePrompt;

    /* ── Strict tool schemas for the five tutor tools. ── */
    const tools = TUTOR_TOOL_NAMES.map((name) => {
      const t = TUTOR_TOOLS[name];
      return { name: t.name, description: t.description, parameters: toStrictJsonSchema(t.params) };
    });

    const responseFormat = {
      name: "tutor_turn_output",
      schema: toStrictJsonSchema(TurnOutputSchema),
    };

    const job = TUTOR_MODELS.tutor_turn;

    /* ── The BOUNDED tool loop. Each round runs one model turn; any tool_call
     *    events are executed locally, their compact JSON results fed back as
     *    function_call/function_call_output items; after MAX_TOOL_ROUNDS or when
     *    the model answers (structured final, no tool calls) we parse. ── */
    const developerItem: ModelInputItem = { role: "developer", content: prompt.developer };
    const userItem: ModelInputItem = { role: "user", content: prompt.input };
    const conversation: ModelInputItem[] = [developerItem, userItem];

    const toolTrace: { tool: string; summary: string }[] = [];
    const evidence: TutorInferencePayload[] = [];
    const practiceItems: MintedPracticeItem[] = [];
    // A3 Wave 4 · the structure + assessment side channels. `assessments` are
    // stamped with the turn's real initiation as the sink collects them (question
    // turns carry none — the intercept downgrades a Class-A call BEFORE execution).
    const structures: RenderStructureCard[] = [];
    const assessments: AssessmentCard[] = [];
    const assessmentInitiation: AssessmentInitiation | null =
      initiation.kind === "practice_request" || initiation.kind === "invitation_accepted"
        ? initiation.kind
        : null;
    let escalation: TutorTurnResult["escalation"] = null;
    // A3 Wave 3 — the FIRST downgraded Class-A tool call this turn (question turns
    // only); applyInvocationPolicy converts it into the at-most-one invitation.
    let pendingDowngrade: { toolName: string; nodeId: string } | null = null;
    // Seed with the chaining anchor (if any); the main call's `started` event / final
    // result overwrite it. Assigns to the hoisted binding so the catch can read it.
    lastResponseId = chained?.previousResponseId ?? null;
    let finalText = "";
    let parsedOutput: TurnOutput | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      // The MAIN call STREAMS (Wave A2): the `started` event carries the provider
      // response id BEFORE the first output token, so early chain-id capture can
      // persist it even if the turn later aborts. The handler (a) stamps
      // lastResponseId the instant `started` lands (the post-result assignment still
      // wins when a final result carries one), and (b) forwards EVERY event to
      // deps.onModelEvent (a hook throw is swallowed — it must never kill the turn).
      const onEvent = (ev: ModelStreamEvent) => {
        if (ev.type === "started" && ev.responseId) lastResponseId = ev.responseId;
        if (deps.onModelEvent) {
          try {
            deps.onModelEvent(ev);
          } catch {
            /* observability hook is best-effort */
          }
        }
      };
      const result = await deps.model.runTurn(
        {
          system: prompt.system,
          input: conversation,
          tools,
          responseFormat,
          stream: true,
          signal: deps.signal,
          model: job.model,
          effort: job.effort,
          timeoutMs: job.timeoutMs,
          maxRetries: job.maxRetries,
          maxOutputTokens: job.maxOutputTokens,
          // R-2 (approved ruling) — P-3 UPDATE: the MAIN foreground tutor turn is
          // stored provider-side (store:true), so `previous_response_id` chaining is
          // a LIVE seam (there is now something to chain onto). This is scoped to
          // the tutor_turn foreground call only — the item-gen / repair sub-calls
          // keep their per-path default. It ENABLES the seam; it does NOT turn
          // chaining on: TUTOR_ENABLE_CHAINING stays OFF by default (L4 textual
          // replay is unchanged), and the A2 chain-id capture already reads the
          // response id off the `started` event.
          store: true,
          ...(chained ? { previousResponseId: chained.previousResponseId } : {}),
        },
        onEvent
      );
      addUsage(usage, result.usage);
      lastResponseId = result.responseId ?? lastResponseId;
      finalText = result.text;

      if (result.finishReason === "error") {
        return { ...empty(result.errorKind ?? "model_error"), usage, responseId: lastResponseId };
      }

      // No tool calls → the model answered. Parse the structured final.
      if (result.toolCalls.length === 0) {
        parsedOutput = parseTurnOutput(result.text);
        break;
      }

      // Execute each requested tool locally; feed compact JSON results back.
      for (const call of result.toolCalls) {
        // A2 · THE FAIL-CLOSED APPROVAL GATE (runs BEFORE any execution AND before
        // the unknown-tool ToolError path). An IRREVERSIBLE tier — which includes
        // any name with no explicit tier row (tierOf fails closed to "irreversible",
        // so an unknown tool is by definition gated) — HALTS the whole turn: nothing
        // executes, no function_call/function_call_output is fed back (so the model
        // is never re-asked), and we settle a completed-but-gated result. ok:false +
        // output:null (nothing FAILED and nothing RAN) means service.ts step (6)
        // `if (!turn.ok || !turn.output)` persists NO assistant row and emits NO
        // evidence. The ROUTE turns approvalRequired into an approval_required frame.
        if (tierOf(call.name) === "irreversible") {
          return {
            ok: false,
            output: null,
            groundingFlags: [],
            evidence: [],
            practiceItems: [],
            escalation: null,
            toolTrace,
            usage,
            responseId: lastResponseId,
            rung: null,
            sessionMarkers: [],
            structures: [],
            assessments: [],
            approvalRequired: { toolName: call.name },
          };
        }

        // A3 Wave 3 · THE INVOCATION-POLICY INTERCEPT (Path 3). A Class-A tool
        // call on a QUESTION turn is NOT executed (§5: generation on acceptance
        // costs nothing on offer): record the downgrade candidate, feed a
        // synthetic function_call_output telling the model to finish its prose
        // turn, log tutor_tool_downgraded (wire/log-only observability — a
        // persisted event would need the full union recipe; deliberate), and
        // CONTINUE — downgraded, never blocked (A3-7). The settled turn surfaces
        // at most ONE invitation via applyInvocationPolicy.
        if (initiation.kind === "question" && CLASS_A_TOOL_NAMES.has(call.name)) {
          const nodeId = firstNodeIdFromArgs(call.arguments);
          if (!pendingDowngrade) pendingDowngrade = { toolName: call.name, nodeId };
          console.log(
            JSON.stringify({
              tag: "tutor_tool_downgraded",
              toolName: call.name,
              nodeId,
              courseId: ctx.courseId,
              initiation: "question",
            })
          );
          conversation.push({ type: "function_call", callId: call.callId, name: call.name, arguments: call.arguments });
          conversation.push({
            type: "function_call_output",
            callId: call.callId,
            output: compactJson({
              summary:
                "Converted to a quiet invitation the learner can press — do not retry the tool; finish your prose turn.",
              data: { downgraded: true },
            }),
          });
          continue;
        }

        conversation.push({ type: "function_call", callId: call.callId, name: call.name, arguments: call.arguments });
        const { summary, data } = await runTool(call.name, call.arguments, toolDeps);
        toolTrace.push({ tool: call.name, summary });

        // Collect side-channel outputs the loop must surface. The sink stamps
        // each assessment card's `initiation` from the turn ctx (the tool minted a
        // placeholder — the sink knows the real initiation).
        collectToolOutputs(call.name, data, {
          evidence,
          practiceItems,
          structures,
          assessments,
          assessmentInitiation,
          setEscalation: (e) => (escalation = e),
        });

        conversation.push({
          type: "function_call_output",
          callId: call.callId,
          output: compactJson({ summary, data }),
        });
      }
    }

    // If we exhausted the tool rounds without a structured answer, ask ONCE more
    // for the final structured turn (no tools this time — force the answer).
    if (!parsedOutput) {
      // Rare repair path — stays NON-STREAMING (Wave 2 revisits).
      const noop = (_ev: ModelStreamEvent) => void _ev;
      const result = await deps.model.runTurn(
        {
          system: prompt.system,
          input: [
            ...conversation,
            { role: "user", content: "Now produce your final tutor turn as the structured JSON object. Do not call any more tools." },
          ],
          tools: [],
          responseFormat,
          stream: false,
          signal: deps.signal,
          model: job.model,
          effort: job.effort,
          timeoutMs: job.timeoutMs,
          maxRetries: job.maxRetries,
          maxOutputTokens: job.maxOutputTokens,
        },
        noop
      );
      addUsage(usage, result.usage);
      lastResponseId = result.responseId ?? lastResponseId;
      finalText = result.text;
      if (result.finishReason === "error") {
        return { ...empty(result.errorKind ?? "model_error"), usage, responseId: lastResponseId };
      }
      parsedOutput = parseTurnOutput(result.text);
    }

    // A single re-ask on parse failure (the runStructuredCall convention, inline).
    if (!parsedOutput) {
      // Rare repair path — stays NON-STREAMING (Wave 2 revisits).
      const noop = (_ev: ModelStreamEvent) => void _ev;
      const result = await deps.model.runTurn(
        {
          system: prompt.system,
          input: [
            developerItem,
            userItem,
            { role: "user", content: "The previous response was not valid JSON for the required schema. Respond again with ONLY the JSON object." },
          ],
          tools: [],
          responseFormat,
          stream: false,
          signal: deps.signal,
          model: job.model,
          effort: job.effort,
          timeoutMs: job.timeoutMs,
          maxRetries: job.maxRetries,
          maxOutputTokens: job.maxOutputTokens,
        },
        noop
      );
      addUsage(usage, result.usage);
      lastResponseId = result.responseId ?? lastResponseId;
      finalText = result.text;
      parsedOutput = parseTurnOutput(result.text);
    }

    if (!parsedOutput) {
      return { ...empty("schema_parse_failed"), usage, responseId: lastResponseId };
    }

    void finalText;

    /* ── Scaffolding overrides on the RAW output (needs marker prose + rung). ── */
    let scaffolded = applyScaffolding(parsedOutput, {
      style,
      isOpeningTurn: ctx.historyTurns.length === 0,
      justShowMe: detectJustShowMe(ctx.learnerMessage),
    });

    /* ── W3.5 · ASSESSMENT INTEGRITY clamp (concept_review_only + live quiz). ──
     *
     * The rung is CLAMPED to ≤ ASSESSMENT_ACTIVE_MAX_RUNG while a quiz is live —
     * even an explicit "just show me" (which scaffolding lifted to rung 4) is
     * DEFERRED, never a verbatim answer. When the clamp actually reduces the rung
     * (the turn WANTED to give the answer), the charter-tone-aware defer copy is
     * appended so the learner hears why. Runs on the RAW marked prose (before
     * grounding strips markers) so the appended copy rides through cleanly. */
    if (assessmentActive && scaffolded.rung > ASSESSMENT_ACTIVE_MAX_RUNG) {
      const deferCopy = assessmentDeferCopy(charter.toneNotes);
      scaffolded = {
        ...scaffolded,
        rung: ASSESSMENT_ACTIVE_MAX_RUNG,
        proseWithSpanMarkers: `${scaffolded.proseWithSpanMarkers} ${deferCopy}`.trim(),
      };
    }

    /* ── Grounding validation + canon suppression → the cleaned turn. ── */
    const validated = validateTurnOutput(scaffolded, index, { courseCanon: charter.courseCanon });

    // The turn's OWN evidence (the structured output) merges with any tool-emitted
    // evidence — de-duplicated by (nodeId, direction, turnRef) so a tool that also
    // emitted the same inference doesn't double-count.
    mergeEvidence(evidence, scaffolded.evidence);

    // Evidence items must reference REAL concept nodes: the contract accepts any
    // string nodeId at parse time (a mangled id must not cost the whole turn),
    // so the loop is where non-resolving items drop — flagged, mirroring
    // citation_dropped. Only survivors reach the frozen event schema downstream.
    const knownNodeIds = new Set(deps.conceptNodes.map((n) => n.id));
    const resolvedEvidence = evidence.filter((e) => knownNodeIds.has(e.nodeId));
    if (resolvedEvidence.length !== evidence.length) validated.flags.push("evidence_dropped");

    /* ── W6 (P6.1) · DETERMINISTIC escalation trigger. ────────────────────────
     *
     * `escalationSensitivity` must actually drive escalation: after grounding, the
     * deterministic gate decides whether the runtime should OFFER a hand-off the
     * model didn't (explicit human-request · ungrounded turn · ≥ N failed
     * scaffolds this session, N from sensitivity). When it fires AND the model
     * didn't already propose (escalation still null), the runtime mints the
     * proposal, writes a consent-pending candidate (rung_trail + this turn's
     * resolved anchors stamped), and surfaces the proposal on the cleaned output
     * so the consent card renders. The model's own proposal always wins if present. */
    let cleaned = validated.cleaned;
    if (!escalation) {
      const trigger = evaluateEscalationTrigger({
        groundingFlags: validated.flags,
        history: ctx.historyTurns,
        learnerMessage: ctx.learnerMessage,
        escalationSensitivity: charter.escalationSensitivity,
      });
      if (trigger.shouldPropose) {
        // The proposal payload the card renders: the learner's verbatim question,
        // the concept(s) they're stuck on (this lesson's nodes), and the tutor's
        // best answer this turn (the cleaned prose).
        const proposal: TurnEscalationProposal =
          cleaned.escalationProposal ?? {
            learnerQuestion: ctx.learnerMessage,
            nodeIds: state.lessonNodeIds,
            proposedAnswer: cleaned.prose,
          };
        // Write the candidate through the SHARED insert (rung_trail = the full
        // session trail incl. this turn; anchors = this turn's resolved citations).
        const insertDeps: TutorToolDeps = {
          ...toolDeps,
          ctx: {
            ...toolCtx,
            rungTrail: [...sessionRungTrail, scaffolded.rung],
            anchors: cleaned.citations,
          },
        };
        const res = await insertEscalationCandidate(insertDeps, {
          learnerQuestion: proposal.learnerQuestion,
          nodeIds: proposal.nodeIds,
          proposedAnswer: proposal.proposedAnswer,
        });
        escalation = { candidateId: res.candidateId, consentRequired: true };
        cleaned = { ...cleaned, escalationProposal: proposal };
      }
    }

    /* ── A3 Wave 3 · INVOCATION POLICY (Path 3 enforcement in CODE). ──────────
     * On a QUESTION turn the settled output NEVER carries practiceItems: model-
     * emitted items are stripped and (with any tool-call downgrade) collapse to
     * AT MOST ONE quiet invitation; the two-ignore cooldown suppresses even
     * that. Paths 1/2 pass through untouched, invitation null (A3-8). */
    const policy = applyInvocationPolicy({
      output: cleaned,
      initiation,
      pendingDowngrade,
      cooldownActive,
    });
    cleaned = policy.output;

    return {
      ok: validated.ok,
      output: cleaned,
      groundingFlags: validated.flags,
      evidence: resolvedEvidence,
      // Belt-and-braces: the intercept means generate_practice never RAN on a
      // question turn, so the minted side channel is empty by construction —
      // force it anyway so no code path can render imposed items.
      practiceItems: initiation.kind === "question" ? [] : practiceItems,
      escalation,
      toolTrace,
      usage,
      responseId: lastResponseId,
      rung: scaffolded.rung,
      // Stamp the root-cause marker only when the interjection actually fired AND
      // the turn completed ok — a failed turn persists nothing, so no marker.
      sessionMarkers: interjectionStamped ? [ROOT_CAUSE_INTERJECTION_MARKER] : [],
      invitation: policy.invitation,
      // A3 Wave 4 · structures ride ANY turn untouched (A3-12); assessments are
      // FORCED [] on a question turn (mirroring practiceItems) — belt-and-braces
      // over the intercept, which already prevents a Class-A tool from executing
      // on a question turn.
      structures,
      assessments: initiation.kind === "question" ? [] : assessments,
    };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}

/* ─────────────────────────────── helpers ────────────────────────────────── */

/** Execute a tutor tool by name; unknown names return an error result (never throws). */
async function runTool(
  name: string,
  rawArgs: string,
  deps: TutorToolDeps
): Promise<{ summary: string; data: unknown }> {
  const tool = (TUTOR_TOOLS as Record<string, (typeof TUTOR_TOOLS)[keyof typeof TUTOR_TOOLS]>)[name];
  if (!tool) {
    return { summary: `Unknown tool: ${name}`, data: { error: "unknown_tool" } };
  }
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(rawArgs || "{}");
  } catch {
    return { summary: `Invalid JSON arguments for ${name}`, data: { error: "invalid_args" } };
  }
  const validated = (tool.params as z.ZodType).safeParse(parsedArgs);
  if (!validated.success) {
    return {
      summary: `Invalid arguments for ${name}: ${validated.error.issues[0]?.message ?? "schema error"}`,
      data: { error: "invalid_args" },
    };
  }
  try {
    return await tool.execute(validated.data, deps);
  } catch (err) {
    return { summary: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: "tool_error" } };
  }
}

/** A3 Wave 3/4 — the concept a downgraded Class-A call targeted: the FIRST entry
 *  of a `nodeIds` array (generate_practice), a scalar `nodeId`, or a scalar
 *  `conceptSlug` (the checkUnderstanding / sequenceTask arg shape — the concept
 *  node uuid, R-1); "" when the args don't parse (the invitation still offers —
 *  acceptance then matches on the empty id, harmless). */
function firstNodeIdFromArgs(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      if (Array.isArray(rec.nodeIds) && typeof rec.nodeIds[0] === "string") return rec.nodeIds[0];
      if (typeof rec.nodeId === "string") return rec.nodeId;
      if (typeof rec.conceptSlug === "string") return rec.conceptSlug;
    }
  } catch {
    /* unparseable args still downgrade */
  }
  return "";
}

/** Route a tool's structured output into the loop's side channels. A3 Wave 4:
 *  renderStructure → structures sink; checkUnderstanding / sequenceTask →
 *  assessments sink, STAMPING each card's `initiation` from the turn ctx (the tool
 *  minted a placeholder — the sink is where the per-turn initiation is known). A
 *  question turn never reaches here for a Class-A tool (the intercept downgrades
 *  it BEFORE execution), so `assessmentInitiation` is non-null whenever an
 *  assessment card actually lands; a defensive null falls back to
 *  practice_request. */
function collectToolOutputs(
  name: string,
  data: unknown,
  sinks: {
    evidence: TutorInferencePayload[];
    practiceItems: MintedPracticeItem[];
    structures: RenderStructureCard[];
    assessments: AssessmentCard[];
    assessmentInitiation: AssessmentInitiation | null;
    setEscalation: (e: TutorTurnResult["escalation"]) => void;
  }
): void {
  if (data == null || typeof data !== "object") return;
  const rec = data as Record<string, unknown>;
  if (name === "emit_evidence" && Array.isArray(rec.items)) {
    for (const it of rec.items) sinks.evidence.push(it as TutorInferencePayload);
  } else if (name === "generate_practice" && Array.isArray(rec.items)) {
    for (const it of rec.items) sinks.practiceItems.push(it as MintedPracticeItem);
  } else if (name === "renderStructure" && rec.structure != null) {
    // Class P — the built (validated) OR drop-and-flagged card. Never stamped
    // with initiation; renders on any turn incl. a question turn (A3-12).
    sinks.structures.push(rec.structure as RenderStructureCard);
  } else if (
    (name === "checkUnderstanding" ||
      name === "sequenceTask" ||
      // A3 Wave 5 — the adaptive assessment tools land in the SAME sink. explainBack
      // returns a NULL assessment when it drops a per-session-per-concept duplicate
      // (rec.assessment == null) — the `!= null` guard skips it (the loop stamps
      // nothing for a null card).
      name === "fadedExample" ||
      name === "predictThenReveal" ||
      name === "explainBack") &&
    rec.assessment != null
  ) {
    const card = rec.assessment as AssessmentCard;
    sinks.assessments.push({ ...card, initiation: sinks.assessmentInitiation ?? "practice_request" });
  } else if (name === "propose_escalation") {
    sinks.setEscalation({
      candidateId: (rec.candidateId as string | null) ?? null,
      consentRequired: true,
    });
  }
}

/** Parse + validate the structured turn output; null on any parse/schema failure. */
function parseTurnOutput(text: string): TurnOutput | null {
  try {
    const parsed = TurnOutputSchema.safeParse(JSON.parse(text || "{}"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Merge structured-output evidence into the tool-emitted set, de-duped by
 *  (nodeId, direction, turnRef). */
function mergeEvidence(into: TutorInferencePayload[], extra: TutorInferencePayload[]): void {
  const key = (e: TutorInferencePayload) => `${e.nodeId}|${e.direction}|${e.turnRef}`;
  const seen = new Set(into.map(key));
  for (const e of extra) {
    if (seen.has(key(e))) continue;
    seen.add(key(e));
    into.push(e);
  }
}

/** W6 · The session's rung trail: each assistant turn's grounding.rung, oldest →
 *  newest. Read tolerantly from the history grounding jsonb (an absent/malformed
 *  rung is skipped). The deterministic trigger appends this turn's rung before it
 *  stamps the candidate. */
function rungTrailFromHistory(turns: HistoryTurn[]): number[] {
  const trail: number[] = [];
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const g = t.grounding;
    if (g && typeof g === "object") {
      const rung = (g as Record<string, unknown>).rung;
      if (typeof rung === "number") trail.push(rung);
    }
  }
  return trail;
}

/** W6 · The anchors cited across the session: the flattened citations from each
 *  assistant turn's grounding jsonb (tolerant — a missing/malformed citations
 *  array is skipped). The deterministic trigger overrides this with THIS turn's
 *  resolved citations when it writes; the tool path uses the accumulated set. */
function anchorsFromHistory(turns: HistoryTurn[]): unknown[] {
  const anchors: unknown[] = [];
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const g = t.grounding;
    if (g && typeof g === "object") {
      const citations = (g as Record<string, unknown>).citations;
      if (Array.isArray(citations)) anchors.push(...citations);
    }
  }
  return anchors;
}

/** A3 Wave 5 — the concept node ids already explainBacked in the CURRENT session
 *  window (so explainBack drops a per-session-per-concept duplicate — A3-17).
 *  Derived from the assistant turns' persisted `grounding.assessments` (service.ts
 *  buildGrounding stamps every settled assessment card's {toolName, conceptSlug}
 *  onto the assistant row's grounding), filtered to toolName === "explainBack" and
 *  restricted to the SAME trailing < SESSION_GAP_MS window session.ts derives — a
 *  31-minute silence resets it like every once-per-session behavior. Tolerant:
 *  malformed/absent grounding contributes nothing. */
function explainBackedConceptsThisSession(turns: HistoryTurn[], nowIso: string): Set<string> {
  const sessionTurns: SessionTurn[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
    createdAt: t.createdAt ?? nowIso,
    grounding: t.grounding,
  }));
  const { sessionTurns: windowed } = deriveSessionState(sessionTurns, nowIso);
  const seen = new Set<string>();
  for (const t of windowed) {
    if (t.role !== "assistant") continue;
    const g = t.grounding;
    if (!g || typeof g !== "object") continue;
    const assessments = (g as Record<string, unknown>).assessments;
    if (!Array.isArray(assessments)) continue;
    for (const a of assessments) {
      if (a && typeof a === "object") {
        const rec = a as Record<string, unknown>;
        if (rec.toolName === "explainBack" && typeof rec.conceptSlug === "string") {
          seen.add(rec.conceptSlug);
        }
      }
    }
  }
  return seen;
}

/** The recent-session synopsis for L3: each of the last ≤6 turns' first ~80 chars. */
function deriveSynopsis(turns: HistoryTurn[]): string[] {
  return turns.slice(-6).map((t) => {
    const who = t.role === "learner" ? "L" : t.role === "instructor" ? "I" : "T";
    const trimmed = t.content.replace(/\s+/g, " ").trim().slice(0, SYNOPSIS_CHARS);
    return `${who}: ${trimmed}`;
  });
}

/** The first lesson id of a snapshot (module order → lesson order), or undefined. */
function firstLessonId(snapshot: PublicationSnapshot): string | undefined {
  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) return lesson.id;
  }
  return undefined;
}

function addUsage(
  total: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number },
  turn: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedTokens?: number } | undefined
): void {
  if (!turn) return;
  total.inputTokens += turn.inputTokens ?? 0;
  total.outputTokens += turn.outputTokens ?? 0;
  total.reasoningTokens += turn.reasoningTokens ?? 0;
  total.cachedTokens += turn.cachedTokens ?? 0;
}

/** Compact a tool result to JSON, capping runaway payloads (a big lesson-context
 *  block feeds back trimmed — the model already saw the docked lesson in L2). */
function compactJson(value: unknown, cap = 8_000): string {
  let s = JSON.stringify(value);
  if (s.length > cap) s = s.slice(0, cap) + '…"}';
  return s;
}

export { HISTORY_MAX_TURNS };
