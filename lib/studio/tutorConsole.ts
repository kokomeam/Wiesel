/**
 * Creator Tutor Console loader (TUTOR-1 Wave 5, P5.1).
 *
 * `loadTutorConsole(supabase, courseId, tab)` is the ONE round trip the console's
 * Overview + Enablement & charter tabs make: the author-gated definer RPC
 * `tutor_console_bundle(p_course_id, p_tab)` (migration 20260805100000). It
 * mirrors loadAnalyticsDashboard — call through rpcJson with a hand-authored Zod
 * schema (the jsonb RPC returns `Json`, so there is nothing to splice into
 * database.types.ts), and return `null` when the RPC returns null (non-author /
 * missing course → the page 404s). Any transport/parse error also collapses to
 * null so the page 404s rather than 500s on a mis-shaped payload.
 *
 * PRIVACY: the RPC has already applied the ≥5 cohort floor to `overview.usage`
 * (below floor → usage is null + usageSuppressed true). This module never
 * recomputes a floor — the raw learner tables are unreadable to authors by any
 * path; the RPC is the ONLY surface.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";
import {
  GUIDANCE_STYLES,
  COURSE_CANONS,
  TUTOR_SCOPES,
  ASSESSMENT_HELP_MODES,
  ESCALATION_SENSITIVITIES,
} from "@/lib/tutor/runtime/charter";

type DB = SupabaseClient<Database>;

/** The four console tabs. Overview + charter load through this bundle; graph +
 *  analytics own their own RPCs (P5.2 / P5.3). */
export type TutorConsoleTab = "overview" | "charter";

/* ─────────────────────────────── schemas ────────────────────────────────── */

/** The six charter knobs, exactly as the RPC emits them (mirrors the DDL CHECK
 *  vocabularies via the charter.ts consts — a divergence trips the pure suite). */
const CharterSchema = z.object({
  guidanceStyle: z.enum(GUIDANCE_STYLES),
  courseCanon: z.enum(COURSE_CANONS),
  scope: z.enum(TUTOR_SCOPES),
  toneNotes: z.string().nullable(),
  assessmentHelp: z.enum(ASSESSMENT_HELP_MODES),
  escalationSensitivity: z.enum(ESCALATION_SENSITIVITIES),
});
export type ConsoleCharter = z.infer<typeof CharterSchema>;

const CharterVersionSchema = z.object({
  id: z.string(),
  actorEmail: z.string().nullable(),
  createdAt: z.string(),
  // The stored snapshot is the full charter + a promptVersion stamp; kept opaque
  // here (the UI reads only the known charter keys via a defensive cast).
  snapshot: z.record(z.string(), z.unknown()),
});
export type TutorCharterVersion = z.infer<typeof CharterVersionSchema>;

const EnablementSchema = z.object({
  enabled: z.boolean(),
  hasAcceptedGraph: z.boolean(),
  nodeCount: z.number().int(),
  pendingGraphChangeSetId: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  charter: CharterSchema,
  // Creator-owned config history (not learner data → unfloored) — always present,
  // read by both the Overview timeline and the Charter tab's history list.
  charterVersions: z.array(CharterVersionSchema),
});
export type TutorEnablement = z.infer<typeof EnablementSchema>;

/** Usage is COHORT-FLOORED: null below the ≥5 floor (the RPC decides). */
const UsageSchema = z
  .object({
    uniqueLearners: z.number().int(),
    sessions: z.number().int(),
    turns: z.number().int(),
  })
  .nullable();
export type TutorUsage = z.infer<typeof UsageSchema>;

const CostByJobSchema = z.object({
  jobType: z.string(),
  calls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
});
export type TutorCostByJob = z.infer<typeof CostByJobSchema>;

const OverviewSchema = z.object({
  usage: UsageSchema,
  usageSuppressed: z.boolean(),
  cost: z.object({
    byJobType: z.array(CostByJobSchema),
    totalUsd: z.number(),
  }),
});
export type TutorOverview = z.infer<typeof OverviewSchema>;

const BundleSchema = z.object({
  course: z.object({ id: z.string(), title: z.string() }),
  enablement: EnablementSchema,
  // Present only on the overview tab (the RPC emits null otherwise).
  overview: OverviewSchema.nullable(),
});
export type TutorConsoleBundle = z.infer<typeof BundleSchema>;

/* ─────────────────────────────── graph status ───────────────────────────── */

/**
 * A pure STATUS signal — "does mastery scaffolding exist?" — NOT an enable gate.
 * True once a course has an ACCEPTED concept graph: active concept nodes exist AND
 * no concept_graph change-set is still pending review. Enabling the tutor NEVER
 * depends on this (the tutor is on by default and answers lesson-grounded without
 * a graph); the console reads it only to describe the optional quality enhancement.
 * Mirrors the SQL the RPC uses (`node_count > 0 and pending is null`).
 */
export function hasAcceptedGraph(args: {
  activeNodeCount: number;
  pendingGraphChangeSetId: string | null;
}): boolean {
  return args.activeNodeCount > 0 && args.pendingGraphChangeSetId === null;
}

/* ─────────────────────────────── loader ─────────────────────────────────── */

/**
 * One round trip for a console tab. Returns null when the course doesn't exist
 * or the caller isn't its author (the RPC authorizes internally → null) — the
 * page turns that into a 404. Errors (transport / mis-shaped payload) also
 * collapse to null so the page 404s rather than surfacing a 500.
 */
export async function loadTutorConsole(
  supabase: DB,
  courseId: string,
  tab: TutorConsoleTab
): Promise<TutorConsoleBundle | null> {
  try {
    const data = await rpcJson(
      supabase,
      "tutor_console_bundle",
      { p_course_id: courseId, p_tab: tab },
      BundleSchema.nullable()
    );
    return data;
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "tutor_console_load",
        courseId,
        tab,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
    return null;
  }
}
