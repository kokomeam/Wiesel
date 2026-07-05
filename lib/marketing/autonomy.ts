/**
 * The autonomy policy engine — PURE, deterministic, zero IO, no model call.
 *
 * This is the deliberate mirror of the gate itself: governance decisions are
 * enforced in inspectable, diffable CODE, never left to model judgment. The
 * engine answers exactly one question — given the course's autonomy mode, its
 * policy, and the facts of one irreversible tool call, how is that call
 * routed? — and records every guardrail it evaluated so the decision is
 * auditable after the fact (`marketing_action.autonomy_decision`).
 *
 * The three modes govern ONLY the irreversible tier (the gate routes read and
 * reversible tools before this engine is ever consulted):
 *
 *   manual   — every irreversible action produces one approval card.
 *   assisted — same, but send_test_email addressed to the CREATOR'S OWN email
 *              auto-logs (it reaches nobody else), and the gate resolves
 *              ambiguous targeting via a clarifying question before the card.
 *   auto     — an explicit, creator-authored policy may pre-approve specific
 *              tools within caps. Anything that isn't a clean match falls back
 *              to a card — never a guess, never silent execution outside the
 *              policy. The empty policy auto-approves NOTHING.
 *
 * Invariants this module upholds by construction:
 *   - HARD_DENY_TOOLS are checked before anything else and always route to a
 *     card, under every mode and every policy configuration.
 *   - A tool name this engine doesn't recognize can never be auto-approved,
 *     even if a policy explicitly lists it (fail closed to irreversible +
 *     never-auto-approvable). The gate's registry lookup already throws on
 *     unknown tools; this is defense in depth.
 *   - Guardrails only narrow: ONE failing guardrail routes to a card no matter
 *     how many others pass. Unconfigured policy fields fail closed — a creator
 *     opting a tool in must also set the caps/hours before anything executes.
 */

import { z } from "zod";

export type AutonomyMode = "manual" | "assisted" | "auto";

/**
 * Never auto-approvable, regardless of mode or policy — checked FIRST in every
 * routing path. Why these three:
 *   cancel_campaign            — destroys an in-flight campaign (cancels queued
 *                                sends, terminal state); the blast radius is
 *                                the whole campaign.
 *   send_consent_confirmations — bulk-emails an entire lead list under one
 *                                action; consent asks are the most
 *                                reputation-sensitive send in the suite.
 *   launch_campaign            — enrolls the whole approved audience into a
 *                                multi-email sequence AND snapshots
 *                                `approvedAudienceIds`; the single
 *                                highest-blast-radius moment there is.
 */
export const HARD_DENY_TOOLS: ReadonlySet<string> = new Set([
  "cancel_campaign",
  "send_consent_confirmations",
  "launch_campaign",
]);

/**
 * Every irreversible tool this engine knows. Kept in sync with the registry by
 * a drift-guard check in scripts/verify-marketing-autonomy.ts (compares this
 * set against the tools whose declared reversibility is "irreversible"). A
 * name absent from this set is treated as unknown → never auto-approvable.
 */
export const KNOWN_IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
  "publish_landing_page",
  "unpublish_landing_page",
  "activate_sequence",
  "enroll_segment_in_sequence",
  "send_broadcast",
  "send_test_email",
  "send_consent_confirmation",
  "send_consent_confirmations",
  "launch_campaign",
  "cancel_campaign",
]);

/** The tools a policy MAY opt into auto-approval (known minus hard-denied). */
export const AUTO_APPROVABLE_TOOLS: ReadonlySet<string> = new Set(
  [...KNOWN_IRREVERSIBLE_TOOLS].filter((t) => !HARD_DENY_TOOLS.has(t))
);

export interface AllowedHours {
  /** Inclusive start hour 0–23 in `timezone`. */
  startHour: number;
  /** Exclusive end hour 1–24 in `timezone`. */
  endHour: number;
  /** IANA timezone; null = UTC. */
  timezone: string | null;
}

export interface AutonomyPolicy {
  /** Tools the creator explicitly opted into auto-approval. Empty = auto mode
   *  is inert. */
  autoApproveTools: string[];
  /** Max recipients a single auto-approved send may reach. null = unset →
   *  any send with recipients fails closed. */
  maxRecipients: number | null;
  /** Max budget (cents) an auto-approved action may spend. No current tool
   *  carries a budget; the cap exists so one can never sneak in un-capped. */
  maxBudgetCents: number | null;
  /** Hours during which auto-execution is allowed. null = unset → fails
   *  closed for every auto candidate. */
  allowedHours: AllowedHours | null;
  /** Always manual-review the first send to a segment this course has never
   *  sent to. Default true. */
  firstSendToNewSegmentManual: boolean;
}

export const EMPTY_POLICY: AutonomyPolicy = {
  autoApproveTools: [],
  maxRecipients: null,
  maxBudgetCents: null,
  allowedHours: null,
  firstSendToNewSegmentManual: true,
};

export const DEFAULT_MODE: AutonomyMode = "assisted";
export const DEFAULT_REVERT_WINDOW_HOURS = 24;

export interface AutonomySettings {
  mode: AutonomyMode;
  policy: AutonomyPolicy;
  /** How long a reversible action stays one-click revertable (1–720h). */
  revertWindowHours: number;
}

export const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = {
  mode: DEFAULT_MODE,
  policy: EMPTY_POLICY,
  revertWindowHours: DEFAULT_REVERT_WINDOW_HOURS,
};

/* ───────────────────────────── policy parsing ───────────────────────────── */

const AllowedHoursSchema = z.object({
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  timezone: z.string().nullable().catch(null),
});

const PolicySchema = z.object({
  autoApproveTools: z.array(z.string()).catch([]),
  maxRecipients: z.number().int().positive().nullable().catch(null),
  maxBudgetCents: z.number().int().positive().nullable().catch(null),
  allowedHours: AllowedHoursSchema.nullable().catch(null),
  firstSendToNewSegmentManual: z.boolean().catch(true),
});

/**
 * Tolerant parse of the stored `policy` jsonb. Anything malformed degrades to
 * the EMPTY (inert) policy — a corrupt policy can only ever REDUCE autonomy,
 * never grant it.
 */
export function parsePolicy(json: unknown): AutonomyPolicy {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ...EMPTY_POLICY };
  const parsed = PolicySchema.safeParse({ ...EMPTY_POLICY, ...(json as Record<string, unknown>) });
  return parsed.success ? parsed.data : { ...EMPTY_POLICY };
}

const MODES: ReadonlySet<string> = new Set(["manual", "assisted", "auto"]);

export function parseMode(value: unknown): AutonomyMode {
  return typeof value === "string" && MODES.has(value) ? (value as AutonomyMode) : DEFAULT_MODE;
}

/* ─────────────────────────── decision evaluation ────────────────────────── */

/** Everything the engine needs to route one irreversible call — assembled by
 *  the gate from the tool's preview + segment history + the injected clock. */
export interface AutonomyFacts {
  toolName: string;
  /** Recipients this call would reach (from the tool's approvalPreview).
   *  null = the tool reaches nobody countable (e.g. publish). */
  audienceCount: number | null;
  /** Spend in cents; null = the tool spends nothing. */
  budgetCents: number | null;
  /** The segment this call targets (tool.segmentKey); null = not segmented. */
  segmentKey: string | null;
  /** Has this course ever sent to `segmentKey`? null = unknown → fails closed. */
  segmentSeenBefore: boolean | null;
  /** Injected clock (services.clock.epochMs()) — deterministic in tests. */
  nowMs: number;
  /** send_test_email only: does `to` match the signed-in creator's email? */
  recipientIsOwner: boolean;
}

export type GuardrailName =
  | "hard_deny"
  | "tool_allowlist"
  | "recipient_cap"
  | "budget_cap"
  | "allowed_hours"
  | "new_segment";

export interface GuardrailResult {
  name: GuardrailName;
  status: "pass" | "fail" | "not_applicable";
  detail: string;
}

export type AutonomyRoute = "pending_approval" | "auto_log" | "auto_execute";

export interface AutonomyDecision {
  route: AutonomyRoute;
  mode: AutonomyMode;
  /** Every guardrail evaluated for this call — the audit trail. */
  guardrails: GuardrailResult[];
  /** Human-readable one-liner rendered in the activity log. */
  reason: string;
}

/** Hour-of-day of `nowMs` in an IANA timezone (null = UTC). Deterministic. */
export function hourInTimeZone(nowMs: number, timezone: string | null): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone ?? "UTC",
    }).format(new Date(nowMs));
    const hour = Number.parseInt(formatted, 10);
    // Intl yields "24" for midnight in some ICU versions.
    return Number.isFinite(hour) ? hour % 24 : new Date(nowMs).getUTCHours();
  } catch {
    // Unknown timezone string → UTC (the guardrail still applies).
    return new Date(nowMs).getUTCHours();
  }
}

function guardrail(name: GuardrailName, status: GuardrailResult["status"], detail: string): GuardrailResult {
  return { name, status, detail };
}

/**
 * Route one irreversible tool call. Order is load-bearing:
 *   1. hard deny (before anything else, under every mode)
 *   2. owner-addressed test email → auto_log (assisted + auto)
 *   3. manual / assisted → pending_approval
 *   4. auto → ALL guardrails must pass; ANY fail → pending_approval
 */
export function evaluateAutonomy(
  mode: AutonomyMode,
  policy: AutonomyPolicy,
  facts: AutonomyFacts
): AutonomyDecision {
  const guardrails: GuardrailResult[] = [];

  // 1 — hard deny, before mode, before policy, before everything.
  if (HARD_DENY_TOOLS.has(facts.toolName)) {
    guardrails.push(
      guardrail("hard_deny", "fail", `${facts.toolName} always requires the creator's explicit approval`)
    );
    return {
      route: "pending_approval",
      mode,
      guardrails,
      reason: `${facts.toolName} is never auto-approvable — approval card required.`,
    };
  }
  guardrails.push(guardrail("hard_deny", "pass", "not on the hard-deny list"));

  // 2 — a test email that reaches only the creator themselves is a log entry,
  // not an approval, in assisted and auto modes. A test addressed anywhere
  // else is a real outward send and stays on the card path.
  if (facts.toolName === "send_test_email" && facts.recipientIsOwner && mode !== "manual") {
    return {
      route: "auto_log",
      mode,
      guardrails,
      reason: "Test email to your own address — sent and logged, no approval needed.",
    };
  }

  // 3 — manual and assisted always produce a card for everything else.
  if (mode !== "auto") {
    return {
      route: "pending_approval",
      mode,
      guardrails,
      reason:
        mode === "manual"
          ? "Manual mode — every irreversible action needs your approval."
          : "Assisted mode — irreversible actions need your approval.",
    };
  }

  // 4 — auto mode: evaluate every guardrail; any single failure routes to a
  // card. Guardrails narrow; they never combine to grant more autonomy than
  // the strictest one allows.

  // tool_allowlist — must be a KNOWN irreversible tool the creator opted in.
  if (!KNOWN_IRREVERSIBLE_TOOLS.has(facts.toolName)) {
    guardrails.push(guardrail("tool_allowlist", "fail", `unknown tool "${facts.toolName}" is never auto-approvable`));
  } else if (!policy.autoApproveTools.includes(facts.toolName)) {
    guardrails.push(guardrail("tool_allowlist", "fail", `${facts.toolName} is not opted into auto-approval`));
  } else {
    guardrails.push(guardrail("tool_allowlist", "pass", `${facts.toolName} is opted in`));
  }

  // recipient_cap — a send with recipients needs a configured cap it fits under.
  if (facts.audienceCount === null) {
    guardrails.push(guardrail("recipient_cap", "not_applicable", "no recipients"));
  } else if (policy.maxRecipients === null) {
    guardrails.push(guardrail("recipient_cap", "fail", `no recipient cap configured (audience ${facts.audienceCount})`));
  } else if (facts.audienceCount > policy.maxRecipients) {
    guardrails.push(
      guardrail("recipient_cap", "fail", `audience ${facts.audienceCount} exceeds cap ${policy.maxRecipients}`)
    );
  } else {
    guardrails.push(
      guardrail("recipient_cap", "pass", `audience ${facts.audienceCount} within cap ${policy.maxRecipients}`)
    );
  }

  // budget_cap — same fail-closed shape (no current tool spends; belt for later).
  if (facts.budgetCents === null) {
    guardrails.push(guardrail("budget_cap", "not_applicable", "no spend"));
  } else if (policy.maxBudgetCents === null) {
    guardrails.push(guardrail("budget_cap", "fail", `no budget cap configured (spend ${facts.budgetCents}¢)`));
  } else if (facts.budgetCents > policy.maxBudgetCents) {
    guardrails.push(guardrail("budget_cap", "fail", `spend ${facts.budgetCents}¢ exceeds cap ${policy.maxBudgetCents}¢`));
  } else {
    guardrails.push(guardrail("budget_cap", "pass", `spend within cap`));
  }

  // allowed_hours — auto-execution is time-boxed for EVERY candidate; unset
  // hours fail closed (opting in means also saying when).
  if (policy.allowedHours === null) {
    guardrails.push(guardrail("allowed_hours", "fail", "no allowed hours configured"));
  } else {
    const hour = hourInTimeZone(facts.nowMs, policy.allowedHours.timezone);
    const { startHour, endHour, timezone } = policy.allowedHours;
    const within =
      startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour; // overnight window
    guardrails.push(
      guardrail(
        "allowed_hours",
        within ? "pass" : "fail",
        `${within ? "inside" : "outside"} allowed hours ${startHour}:00–${endHour}:00 ${timezone ?? "UTC"} (now ${hour}:00)`
      )
    );
  }

  // new_segment — first send to a segment this course has never sent to stays
  // manual (unless the creator explicitly turned the guardrail off).
  if (!policy.firstSendToNewSegmentManual) {
    guardrails.push(guardrail("new_segment", "not_applicable", "first-send review disabled by policy"));
  } else if (facts.segmentKey === null) {
    guardrails.push(guardrail("new_segment", "not_applicable", "not a segment send"));
  } else if (facts.segmentSeenBefore === true) {
    guardrails.push(guardrail("new_segment", "pass", `segment "${facts.segmentKey}" has been sent to before`));
  } else {
    // false OR null (unknown history) — both fail closed.
    guardrails.push(
      guardrail(
        "new_segment",
        "fail",
        facts.segmentSeenBefore === false
          ? `first send to segment "${facts.segmentKey}" — manual review required`
          : `segment history unknown for "${facts.segmentKey}"`
      )
    );
  }

  const failed = guardrails.filter((g) => g.status === "fail");
  if (failed.length > 0) {
    return {
      route: "pending_approval",
      mode,
      guardrails,
      reason: `Auto mode fell back to approval: ${failed.map((g) => g.detail).join("; ")}.`,
    };
  }
  return {
    route: "auto_execute",
    mode,
    guardrails,
    reason: "Auto mode — every policy guardrail passed.",
  };
}

/** Tolerant parse of a stored autonomy_decision jsonb (for the UI/audit). */
export function parseAutonomyDecision(json: unknown): AutonomyDecision | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.route !== "string" || typeof o.reason !== "string") return null;
  return {
    route: o.route as AutonomyRoute,
    mode: parseMode(o.mode),
    guardrails: Array.isArray(o.guardrails) ? (o.guardrails as GuardrailResult[]) : [],
    reason: o.reason,
  };
}
