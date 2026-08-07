/**
 * TUTOR-1 Amendment A3 Wave 3 — the INVOCATION POLICY (pure — zero I/O).
 *
 * The legacy practice surface (generate_practice + TurnOutputSchema.practiceItems)
 * is the GOVERNED Class-A prototype. Three paths (directive §4), enforced in CODE,
 * never the prompt:
 *
 *   Path 1 — learner practice_request  → the tool executes directly, items render,
 *            NO invitation.
 *   Path 2 — invitation_accepted       → the tool executes, items render.
 *   Path 3 — question                  → the tool MUST NOT execute; a Class-A tool
 *            call is DOWNGRADED to at most ONE quiet invitation; model-emitted
 *            practiceItems are likewise stripped-and-downgraded.
 *
 * ── PROVENANCE (the wire rule) ───────────────────────────────────────────────
 * ONLY acceptance claims ride the wire (`initiation: { kind: "invitation_accepted",
 * toolName, nodeId }` on the POST body); question vs practice_request is SERVER-
 * derived (`detectPracticeRequest` — regex-only, false-negative bias per §4). An
 * acceptance claim is validated against the IMMEDIATELY-prior assistant turn's
 * stored invitation (same toolName + nodeId, no learner turn between); an invalid,
 * mismatched, or stale claim fails TOWARD `{ kind: "question" }`.
 *
 * ── THE INVITATION LIFECYCLE (derived, never stored) ─────────────────────────
 * An offered invitation is stamped into the assistant turn's `grounding.invitation`
 * (service.ts buildGrounding) — that stamp IS the offered-marker (the sessionMarkers
 * precedent). A learner turn's `grounding.initiation` (stamped only when
 * non-question) records how the turn was initiated. `deriveInvitationState` walks
 * the SAME trailing 30-min session window as session.ts (it reuses
 * deriveSessionState verbatim): an offer is ACCEPTED iff the NEXT learner turn's
 * initiation is a matching invitation_accepted; IGNORED once any later learner turn
 * exists; the trailing run of ignored offers drives the two-ignore COOLDOWN, reset
 * by any acceptance or any explicit practice request. `effectiveCooldown` folds in
 * the pending offer the CURRENT (not-yet-persisted) message is about to resolve —
 * a question message ignores it, so the second consecutive brush-off suppresses
 * the offer on THIS turn, not one turn late.
 *
 * ── [FWD] the model fallback ─────────────────────────────────────────────────
 * §7 of the audit sketches a two-stage classifier (regex short-circuit → low-effort
 * strict-JSON model call through the pooled deps.model, the lib/ai/intent.ts
 * shape). Wave 3 ships the regex stage ONLY — the low-effort model fallback is a
 * documented [FWD], deliberately NOT built (false-negative bias: an unmistakable
 * ask executes; anything ambiguous stays a question and at most earns an
 * invitation).
 */

import { deriveSessionState, type SessionTurn } from "./session";

/* ─────────────────────────────── initiation ─────────────────────────────── */

/** How THIS turn was initiated. SERVER-derived; only acceptance claims ride the
 *  wire. The FROZEN Wave-3 contract (Builder F mirrors zod-free). */
export type TurnInitiation =
  | { kind: "question" }
  | { kind: "practice_request" }
  | { kind: "invitation_accepted"; nodeId: string; toolName: string };

/** The ONLY initiation shape a client may claim on the POST body. */
export interface InvitationAcceptanceClaim {
  kind: "invitation_accepted";
  toolName: string;
  nodeId: string;
}

/** The at-most-one quiet invitation a question turn may offer. Persisted on the
 *  assistant row's grounding jsonb (the offered-marker) + surfaced on the settled
 *  `turn` payload. */
export interface TurnInvitation {
  toolName: string;
  nodeId: string;
  label: string;
}

/* ─────────────────────────────── Class-A registry ───────────────────────── */

/** The Class-A (learner-active assessment) tool names GOVERNED by this policy.
 *  Only generate_practice is ACTIVE today — Waves 4/5 extend this set alongside
 *  INVITATION_LABELS as checkUnderstanding / sequenceTask / … land. */
export const CLASS_A_TOOL_NAMES: ReadonlySet<string> = new Set(["generate_practice"]);

/** Invitation button labels — directive copy VERBATIM, the single source. Keys
 *  beyond generate_practice are the Waves-4/5 tools (label copy ships now so the
 *  rung map below is complete data; availability flips via CLASS_A_TOOL_NAMES). */
export const INVITATION_LABELS: Record<string, string> = {
  generate_practice: "Try a practice problem",
  checkUnderstanding: "Try a practice problem",
  sequenceTask: "Put these in order",
  fadedExample: "Try one yourself",
  predictThenReveal: "Predict what happens",
  explainBack: "Explain it back",
};

/** Ruling R-6 — A3 §4's invitation-tool table mapped onto the EXISTING 0–4 rung
 *  ladder (A3 "1 Elicit" ⇒ rungs 0–1 · "2 Nudge" ⇒ 2 · "3 Scaffold" ⇒ 3 ·
 *  "4 Resolve" ⇒ 4). The map is FULL data — Waves 4/5 only flip tool availability
 *  in CLASS_A_TOOL_NAMES; this table never changes shape. */
export const RUNG_INVITATION_TOOLS: Record<0 | 1 | 2 | 3 | 4, readonly string[]> = {
  0: ["checkUnderstanding", "predictThenReveal"],
  1: ["checkUnderstanding", "predictThenReveal"],
  2: ["sequenceTask", "fadedExample"],
  3: ["fadedExample"],
  4: ["checkUnderstanding"],
};

/**
 * The invitation tool to offer at a rung: the mapped preference list filtered by
 * what is ACTIVE (CLASS_A_TOOL_NAMES ∩ implemented), falling back to
 * generate_practice while it is the only implemented Class-A surface. Once Waves
 * 4/5 activate the mapped tools, the preference order starts winning with no
 * change here.
 */
export function invitationToolForRung(rung: number): string {
  const clamped = Math.min(4, Math.max(0, Math.round(rung))) as 0 | 1 | 2 | 3 | 4;
  const active = RUNG_INVITATION_TOOLS[clamped].filter((t) => CLASS_A_TOOL_NAMES.has(t));
  return active[0] ?? "generate_practice";
}

/* ─────────────────────────── practice-request regex ─────────────────────── */

/**
 * The conservative practice-request detector — regex-ONLY, false-negative bias
 * (§4): catch only unmistakable asks. The suggestion chip "Quiz me on this
 * lesson" MUST match. Anything ambiguous stays a question (and at most earns an
 * invitation). The low-effort model fallback is a documented [FWD] — see the
 * module header.
 */
export const PRACTICE_REQUEST_RE =
  /\b(?:quiz me|test me|give me (?:a |another |one more )?practice (?:problem|question|exercise)s?|can i practice|let me try (?:one|another)|practice this)\b/i;

/** Pure, conservative practice-request detection over the learner's message. */
export function detectPracticeRequest(message: string): boolean {
  return PRACTICE_REQUEST_RE.test(message);
}

/* ─────────────────────────── initiation resolution ──────────────────────── */

/**
 * Resolve THIS turn's initiation from the wire claim + the message + the
 * immediately-prior assistant turn's stored invitation.
 *
 *  • An acceptance claim is honored ONLY when it matches `priorInvitation`
 *    (same toolName + same nodeId). Mismatched / stale (no prior invitation —
 *    incl. an expired session window or a learner turn in between) fails TOWARD
 *    `{ kind: "question" }` — a forged or out-of-date press never executes the
 *    tool.
 *  • With no claim, an unmistakable practice ask (detectPracticeRequest) is a
 *    practice_request; everything else is a question.
 */
export function resolveInitiation(args: {
  claimed: InvitationAcceptanceClaim | null | undefined;
  message: string;
  priorInvitation: TurnInvitation | null;
}): TurnInitiation {
  const { claimed, message, priorInvitation } = args;
  if (claimed) {
    if (
      claimed.kind === "invitation_accepted" &&
      priorInvitation !== null &&
      claimed.toolName === priorInvitation.toolName &&
      claimed.nodeId === priorInvitation.nodeId
    ) {
      return { kind: "invitation_accepted", toolName: claimed.toolName, nodeId: claimed.nodeId };
    }
    // Invalid / mismatched / stale claims fail toward question (never toward
    // execution — the message under a pressed button is not a typed ask).
    return { kind: "question" };
  }
  return detectPracticeRequest(message) ? { kind: "practice_request" } : { kind: "question" };
}

/* ─────────────────────────── invitation state ───────────────────────────── */

/** How many consecutively-ignored offers activate the cooldown. */
export const INVITATION_COOLDOWN_IGNORES = 2;

export interface InvitationState {
  /** The invitation on the MOST RECENT assistant turn with NO learner turn after
   *  it (the only offer an acceptance claim may validate against). Null when the
   *  last offer was already answered, the session window expired, or none exists. */
  priorInvitation: TurnInvitation | null;
  /** The trailing run of IGNORED offers among PERSISTED turns (reset by any
   *  acceptance or any learner practice_request initiation). A pending trailing
   *  offer is NOT counted here — `effectiveCooldown` resolves it against the
   *  current message. */
  consecutiveIgnored: number;
  /** consecutiveIgnored >= INVITATION_COOLDOWN_IGNORES over persisted turns. */
  cooldownActive: boolean;
}

/** Read a turn's stored invitation off its grounding jsonb (defensive). */
export function invitationOf(turn: SessionTurn): TurnInvitation | null {
  const g = turn.grounding;
  if (!g || typeof g !== "object") return null;
  const raw = (g as Record<string, unknown>).invitation;
  if (!raw || typeof raw !== "object") return null;
  const inv = raw as Record<string, unknown>;
  if (typeof inv.toolName !== "string" || typeof inv.nodeId !== "string") return null;
  return {
    toolName: inv.toolName,
    nodeId: inv.nodeId,
    label:
      typeof inv.label === "string"
        ? inv.label
        : INVITATION_LABELS[inv.toolName] ?? INVITATION_LABELS.generate_practice,
  };
}

/** Read a learner turn's stored initiation off its grounding jsonb (defensive —
 *  question rows carry none by design). */
export function initiationOf(turn: SessionTurn): TurnInitiation | null {
  const g = turn.grounding;
  if (!g || typeof g !== "object") return null;
  const raw = (g as Record<string, unknown>).initiation;
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "practice_request") return { kind: "practice_request" };
  if (
    rec.kind === "invitation_accepted" &&
    typeof rec.toolName === "string" &&
    typeof rec.nodeId === "string"
  ) {
    return { kind: "invitation_accepted", toolName: rec.toolName, nodeId: rec.nodeId };
  }
  if (rec.kind === "question") return { kind: "question" };
  return null;
}

/**
 * Derive the invitation lifecycle state over the current SESSION window (the
 * SAME trailing < 30-min window as session.ts — deriveSessionState is reused
 * verbatim, so a 31-minute silence resets the whole lifecycle exactly like every
 * other once-per-session behavior).
 *
 *  • An assistant turn whose grounding carries `invitation` is an OFFER.
 *  • An offer is ACCEPTED iff the NEXT learner turn's grounding.initiation is a
 *    matching invitation_accepted (same toolName + nodeId).
 *  • It is IGNORED otherwise, once any later learner turn exists. An offer with
 *    no later learner turn yet is PENDING (neither — it is the priorInvitation
 *    available for acceptance this turn).
 *  • consecutiveIgnored is the TRAILING run of ignored offers; reset to 0 by any
 *    acceptance OR any learner practice_request initiation.
 */
export function deriveInvitationState(turns: SessionTurn[], nowIso: string): InvitationState {
  const { sessionTurns } = deriveSessionState(turns, nowIso);

  let consecutiveIgnored = 0;
  let pendingOffers: TurnInvitation[] = [];
  for (const t of sessionTurns) {
    if (t.role === "assistant") {
      const inv = invitationOf(t);
      if (inv) pendingOffers.push(inv);
      continue;
    }
    if (t.role !== "learner") continue;
    const init = initiationOf(t);
    if (pendingOffers.length > 0) {
      const accepted =
        init?.kind === "invitation_accepted" &&
        pendingOffers.some((o) => o.toolName === init.toolName && o.nodeId === init.nodeId);
      if (accepted) consecutiveIgnored = 0;
      else consecutiveIgnored += pendingOffers.length;
      pendingOffers = [];
    }
    if (init?.kind === "practice_request") consecutiveIgnored = 0;
  }

  // priorInvitation: the invitation on the MOST RECENT assistant turn with no
  // learner turn after it — acceptance only validates against the IMMEDIATELY-
  // prior offer. (Instructor turns don't consume an offer.)
  let priorInvitation: TurnInvitation | null = null;
  for (let i = sessionTurns.length - 1; i >= 0; i -= 1) {
    const t = sessionTurns[i];
    if (t.role === "learner") break;
    if (t.role === "assistant") {
      priorInvitation = invitationOf(t);
      break;
    }
  }

  return {
    priorInvitation,
    consecutiveIgnored,
    cooldownActive: consecutiveIgnored >= INVITATION_COOLDOWN_IGNORES,
  };
}

/**
 * The cooldown as it applies to THIS turn: the persisted trailing-ignore run,
 * PLUS the pending offer the CURRENT (not-yet-persisted) message resolves — a
 * question message ignores it, so the second consecutive brush-off suppresses
 * the offer on THIS turn rather than one turn late. An acceptance or explicit
 * practice request resets the run (and Paths 1/2 never invite anyway).
 */
export function effectiveCooldown(state: InvitationState, initiation: TurnInitiation): boolean {
  if (initiation.kind !== "question") return false;
  const ignored = state.consecutiveIgnored + (state.priorInvitation ? 1 : 0);
  return ignored >= INVITATION_COOLDOWN_IGNORES;
}

/* ─────────────────────────── the policy application ─────────────────────── */

/** The structural slice of a turn output the policy touches — TurnOutput AND the
 *  grounding-cleaned turn both satisfy it. */
export interface PolicyPracticeItemLike {
  nodeId: string;
}
export interface PolicyableOutput {
  practiceItems?: PolicyPracticeItemLike[] | null;
}

/**
 * Enforce the three paths on a settled turn output (post-parse, post-grounding):
 *
 *  • Paths 1/2 (practice_request / invitation_accepted): the output passes
 *    through UNTOUCHED and the invitation is null — a turn that delivers
 *    practice never also invites (A3-8).
 *  • Path 3 (question): `practiceItems` are STRIPPED (assessment is never
 *    imposed on a turn the learner didn't initiate). The strip collapses to AT
 *    MOST ONE invitation: a tool-call downgrade recorded by the loop
 *    (`pendingDowngrade`) wins; else the FIRST stripped item's nodeId seeds the
 *    candidate. The invitation is FORCED null under cooldown (A3-10) and — as a
 *    structural guard — whenever the settled output still carries practiceItems
 *    (A3-9; unreachable on question turns since the strip precedes it).
 */
export function applyInvocationPolicy<T extends PolicyableOutput>(args: {
  output: T;
  initiation: TurnInitiation;
  pendingDowngrade: { toolName: string; nodeId: string } | null;
  cooldownActive: boolean;
}): { output: T; invitation: TurnInvitation | null } {
  const { output, initiation, pendingDowngrade, cooldownActive } = args;

  // Paths 1/2 — the learner initiated: items render, never an invitation.
  if (initiation.kind !== "question") {
    return { output, invitation: null };
  }

  // Path 3 — strip model-emitted practiceItems from the settled output.
  const items = output.practiceItems ?? [];
  const stripped: T = items.length > 0 ? { ...output, practiceItems: null } : output;

  // At most ONE invitation: the tool-call downgrade wins; else the first
  // stripped item's nodeId.
  const candidate =
    pendingDowngrade ??
    (items.length > 0 ? { toolName: "generate_practice", nodeId: items[0].nodeId } : null);

  let invitation: TurnInvitation | null = null;
  if (candidate && !cooldownActive) {
    invitation = {
      toolName: candidate.toolName,
      nodeId: candidate.nodeId,
      label: INVITATION_LABELS[candidate.toolName] ?? INVITATION_LABELS.generate_practice,
    };
  }

  // A3-9 structural guard: an invitation NEVER coexists with surviving items.
  if (invitation && (stripped.practiceItems?.length ?? 0) > 0) invitation = null;

  return { output: stripped, invitation };
}
