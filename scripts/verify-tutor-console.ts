/**
 * Creator Tutor Console — PURE suite (no key, no DB, no browser). TUTOR-1 Wave 5
 * (P5.1). Covers:
 *
 *   - The bundle Zod schema: a valid overview bundle parses; a valid charter
 *     bundle (overview null) parses; a SUPPRESSED usage bundle (usage null +
 *     usageSuppressed true) parses; an out-of-vocab charter enum is rejected.
 *   - The graph-STATUS signal (hasAcceptedGraph — "does mastery scaffolding
 *     exist?", NOT an enable gate: the tutor is on by default and answers without
 *     a graph): active nodes AND no pending change-set → true; no nodes → false;
 *     pending change-set → false.
 *   - Charter enum re-validation (the server-action path): TutorCharterSchema
 *     .partial() accepts a subset, rejects an out-of-vocab value, caps tone ≤500.
 *   - Migration drift guards (regex over 20260805100000): the `>= 5` cohort floor
 *     literal, author-gate returns null (not the course author), the definer +
 *     revoke-from-public/anon + grant-to-authenticated grants pattern, and the
 *     unknown-tab raise.
 *
 * Run: `npx tsx scripts/verify-tutor-console.ts`
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { hasAcceptedGraph } from "@/lib/studio/tutorConsole";
import { TutorCharterSchema } from "@/lib/tutor/runtime/charter";

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

/* A structural mirror of the loader's private BundleSchema — the suite pins the
 * exact contract the RPC emits + the UI reads. The int suite (live RPC → the
 * loader's own parse) is the authority; this is the pure shape check. */
const TestBundleSchema = z.object({
  course: z.object({ id: z.string(), title: z.string() }),
  enablement: z.object({
    enabled: z.boolean(),
    hasAcceptedGraph: z.boolean(),
    nodeCount: z.number().int(),
    pendingGraphChangeSetId: z.string().nullable(),
    currentVersionId: z.string().nullable(),
    charter: z.object({
      guidanceStyle: z.string(),
      courseCanon: z.string(),
      scope: z.string(),
      toneNotes: z.string().nullable(),
      assessmentHelp: z.string(),
      escalationSensitivity: z.string(),
    }),
    charterVersions: z.array(
      z.object({
        id: z.string(),
        actorEmail: z.string().nullable(),
        createdAt: z.string(),
        snapshot: z.record(z.string(), z.unknown()),
      })
    ),
  }),
  overview: z
    .object({
      usage: z
        .object({
          uniqueLearners: z.number().int(),
          sessions: z.number().int(),
          turns: z.number().int(),
        })
        .nullable(),
      usageSuppressed: z.boolean(),
      cost: z.object({
        byJobType: z.array(
          z.object({
            jobType: z.string(),
            calls: z.number().int(),
            inputTokens: z.number().int(),
            outputTokens: z.number().int(),
            costUsd: z.number().nullable(),
          })
        ),
        totalUsd: z.number(),
      }),
    })
    .nullable(),
});

const baseEnablement = {
  enabled: false,
  hasAcceptedGraph: true,
  nodeCount: 12,
  pendingGraphChangeSetId: null,
  currentVersionId: "v-1",
  charter: {
    guidanceStyle: "guided_default",
    courseCanon: "strict",
    scope: "course_only",
    toneNotes: null,
    assessmentHelp: "concept_review_only",
    escalationSensitivity: "default",
  },
  charterVersions: [
    { id: "v-1", actorEmail: "a@example.com", createdAt: "2026-08-05T00:00:00Z", snapshot: { guidanceStyle: "guided_default" } },
  ],
};

console.log("\n# bundle Zod contract");
check(
  "a valid OVERVIEW bundle (usage present ≥5) parses",
  TestBundleSchema.safeParse({
    course: { id: "c-1", title: "Course" },
    enablement: baseEnablement,
    overview: {
      usage: { uniqueLearners: 7, sessions: 20, turns: 55 },
      usageSuppressed: false,
      cost: { byJobType: [{ jobType: "tutor_turn", calls: 3, inputTokens: 100, outputTokens: 40, costUsd: 0.01 }], totalUsd: 0.01 },
    },
  }).success
);
check(
  "a SUPPRESSED overview bundle (usage null + usageSuppressed true) parses",
  TestBundleSchema.safeParse({
    course: { id: "c-1", title: "Course" },
    enablement: baseEnablement,
    overview: {
      usage: null,
      usageSuppressed: true,
      cost: { byJobType: [], totalUsd: 0 },
    },
  }).success
);
check(
  "a CHARTER bundle (overview null) parses",
  TestBundleSchema.safeParse({
    course: { id: "c-1", title: "Course" },
    enablement: baseEnablement,
    overview: null,
  }).success
);
check(
  "a bundle missing the enablement block is REJECTED",
  !TestBundleSchema.safeParse({ course: { id: "c-1", title: "Course" }, overview: null }).success
);

const MIGRATION = readFileSync(
  new URL("../supabase/migrations/20260805100000_tutor_console_rpcs.sql", import.meta.url),
  "utf8"
);

console.log(
  "\n# graph-STATUS signal (hasAcceptedGraph — mastery scaffolding exists?, NOT an enable gate)"
);
check(
  "active nodes AND no pending change-set → accepted graph (scaffolding exists)",
  hasAcceptedGraph({ activeNodeCount: 7, pendingGraphChangeSetId: null }) === true
);
check(
  "no active nodes → NO accepted graph (tutor still answers from lessons — enabling is NOT blocked)",
  hasAcceptedGraph({ activeNodeCount: 0, pendingGraphChangeSetId: null }) === false
);
check(
  "a pending graph change-set → NO accepted graph yet (review in flight)",
  hasAcceptedGraph({ activeNodeCount: 7, pendingGraphChangeSetId: "cs-1" }) === false
);
check(
  "both missing → NO accepted graph",
  hasAcceptedGraph({ activeNodeCount: 0, pendingGraphChangeSetId: "cs-1" }) === false
);

console.log("\n# charter enum re-validation (the server-action path)");
check(
  "a subset patch parses (partial)",
  TutorCharterSchema.partial().safeParse({ guidanceStyle: "socratic_strict" }).success
);
check(
  "an out-of-vocab guidance style is REJECTED",
  !TutorCharterSchema.partial().safeParse({ guidanceStyle: "bogus" }).success
);
check(
  "an out-of-vocab escalation sensitivity is REJECTED",
  !TutorCharterSchema.partial().safeParse({ escalationSensitivity: "extreme" }).success
);
check(
  "tone_notes > 500 chars is REJECTED",
  !TutorCharterSchema.partial().safeParse({ toneNotes: "x".repeat(501) }).success
);
check(
  "tone_notes exactly 500 chars is accepted",
  TutorCharterSchema.partial().safeParse({ toneNotes: "x".repeat(500) }).success
);
check(
  "null tone_notes is accepted (clears the field)",
  TutorCharterSchema.partial().safeParse({ toneNotes: null }).success
);
check(
  "all six enums together parse",
  TutorCharterSchema.partial().safeParse({
    guidanceStyle: "answer_forward",
    courseCanon: "open",
    scope: "course_plus_adjacent",
    assessmentHelp: "block",
    escalationSensitivity: "high",
    toneNotes: "Be warm.",
  }).success
);

console.log("\n# migration drift guards (20260805100000_tutor_console_rpcs.sql)");
check(
  "the RPC signature is (p_course_id uuid, p_tab text) returns jsonb",
  /create (or replace )?function public\.tutor_console_bundle\(p_course_id uuid, p_tab text\)\s*\n\s*returns jsonb/i.test(
    MIGRATION
  )
);
check("SECURITY DEFINER", /security definer/i.test(MIGRATION));
check(
  "the cohort floor `>= 5` appears verbatim (D-4)",
  /v_usage_learners >= 5/.test(MIGRATION) && /v_usage_learners < 5/.test(MIGRATION)
);
check(
  "sub-floor usage is suppressed (usage null + usageSuppressed true)",
  /v_usage := null/.test(MIGRATION) && /v_usage_suppressed/.test(MIGRATION)
);
check(
  "author-gate returns NULL for a non-author (never leaks course existence)",
  /author_id = v_uid/.test(MIGRATION) && /if not found then\s*\n\s*return null/i.test(MIGRATION)
);
check(
  "unknown tab RAISES (p_tab not in overview/charter)",
  /p_tab not in \('overview', 'charter'\)/.test(MIGRATION) && /raise exception 'unknown tab/.test(MIGRATION)
);
check(
  "revoke all from public, anon",
  /revoke all on function public\.tutor_console_bundle\(uuid, text\) from public, anon/.test(MIGRATION)
);
check(
  "grant execute to authenticated",
  /grant execute on function public\.tutor_console_bundle\(uuid, text\) to authenticated/.test(MIGRATION)
);
check(
  "cost is grouped by job_type from tutor_model_call telemetry (unfloored, no learner attribution)",
  /event_type = 'tutor_model_call'/.test(MIGRATION) && /group by e\.job_type/.test(MIGRATION)
);
check(
  "usage reads tutor_threads ⋈ tutor_turns as definer (never an author policy on them)",
  /from public\.tutor_threads t/.test(MIGRATION) && /join public\.tutor_turns tt/.test(MIGRATION)
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
