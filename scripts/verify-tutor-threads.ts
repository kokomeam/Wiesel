/**
 * Tutor threads / charter / escalation — PURE suite (no key, no DB, no browser).
 * TUTOR-1 Wave 3 (W3.2).
 *
 *   - Charter schema: defaults, per-field varied parses, out-of-vocab rejects,
 *     resolveCharter(null) → defaults, resolveCharter(row) mapping,
 *     tone_notes ≤500 cap
 *   - serializeCharter goldens: BYTE-IDENTICAL for identical input (serialize
 *     twice + input-key-order independence); each field varies the bytes;
 *     tone_notes present vs absent; the version-stamp constant
 *   - charterSnapshot round-trip: snapshot → resolveCharter-shaped read is stable
 *   - Migration drift guards (regex over the migration file):
 *       • unique (user_id, course_id) on tutor_threads
 *       • tutor_turns immutability trigger raises on UPDATE, is NOT on DELETE
 *       • tutor_turns INSERT policy restricted to role='learner'
 *       • assistant/instructor turns unrepresentable by any client policy
 *       • ZERO author policy on threads / turns / candidates (no author predicate)
 *       • charter CHECK vocabularies EXACTLY as specified
 *       • tutor_charter_versions append-only (immutability trigger + author RLS)
 *       • escalation candidates' status-only trigger + legal transitions
 *       • content cap (1..20000) + tone_notes cap (≤500) + question/answer caps
 *
 * Run: `npx tsx scripts/verify-tutor-threads.ts`
 */

import { readFileSync } from "node:fs";
import {
  ASSESSMENT_HELP_MODES,
  CHARTER_DEFAULTS,
  CHARTER_PROMPT_VERSION,
  COURSE_CANONS,
  ESCALATION_SENSITIVITIES,
  GUIDANCE_STYLES,
  TUTOR_SCOPES,
  TutorCharterSchema,
  charterSnapshot,
  resolveCharter,
  serializeCharter,
  type TutorCharter,
} from "@/lib/tutor/runtime/charter";

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

const MIGRATION = readFileSync(
  new URL("../supabase/migrations/20260804100000_tutor_threads_charter.sql", import.meta.url),
  "utf8"
);

/** A settings-row shape (only the fields resolveCharter reads matter here). */
function settingsRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    course_id: crypto.randomUUID(),
    enabled: true,
    budget_limit_usd: null,
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    guidance_style: "guided_default",
    course_canon: "strict",
    scope: "course_only",
    tone_notes: null,
    assessment_help: "concept_review_only",
    escalation_sensitivity: "default",
    current_charter_version_id: null,
    ...overrides,
  } as never;
}

const DEFAULT_CHARTER: TutorCharter = TutorCharterSchema.parse({});

function main() {
  /* ─────────────────────────── charter schema ───────────────────────────── */
  console.log("\n# charter schema — defaults + vocabularies");
  check("empty parse yields the defaults", JSON.stringify(DEFAULT_CHARTER) === JSON.stringify({
    guidanceStyle: "guided_default",
    courseCanon: "strict",
    scope: "course_only",
    toneNotes: null,
    assessmentHelp: "concept_review_only",
    escalationSensitivity: "default",
  }));
  check("CHARTER_DEFAULTS matches the schema defaults", DEFAULT_CHARTER.guidanceStyle === CHARTER_DEFAULTS.guidanceStyle && DEFAULT_CHARTER.assessmentHelp === CHARTER_DEFAULTS.assessmentHelp && DEFAULT_CHARTER.toneNotes === CHARTER_DEFAULTS.toneNotes);
  check("every guidance style parses", GUIDANCE_STYLES.every((g) => TutorCharterSchema.safeParse({ guidanceStyle: g }).success));
  check("every course canon parses", COURSE_CANONS.every((c) => TutorCharterSchema.safeParse({ courseCanon: c }).success));
  check("every scope parses", TUTOR_SCOPES.every((s) => TutorCharterSchema.safeParse({ scope: s }).success));
  check("every assessment-help mode parses", ASSESSMENT_HELP_MODES.every((a) => TutorCharterSchema.safeParse({ assessmentHelp: a }).success));
  check("every escalation sensitivity parses", ESCALATION_SENSITIVITIES.every((e) => TutorCharterSchema.safeParse({ escalationSensitivity: e }).success));
  check("an out-of-vocab guidance style is rejected", !TutorCharterSchema.safeParse({ guidanceStyle: "friendly" }).success);
  check("an out-of-vocab canon is rejected", !TutorCharterSchema.safeParse({ courseCanon: "loose" }).success);
  check("a tone note over 500 chars is rejected", !TutorCharterSchema.safeParse({ toneNotes: "x".repeat(501) }).success);
  check("a tone note at exactly 500 chars parses", TutorCharterSchema.safeParse({ toneNotes: "x".repeat(500) }).success);
  check("tone note may be null", TutorCharterSchema.safeParse({ toneNotes: null }).success);

  /* ─────────────────────────── resolveCharter ───────────────────────────── */
  console.log("\n# resolveCharter");
  check("resolveCharter(null) → all defaults", JSON.stringify(resolveCharter(null)) === JSON.stringify(DEFAULT_CHARTER));
  check("resolveCharter(undefined) → all defaults", JSON.stringify(resolveCharter(undefined)) === JSON.stringify(DEFAULT_CHARTER));
  const resolved = resolveCharter(settingsRow({ guidance_style: "socratic_strict", scope: "course_plus_adjacent", tone_notes: "Warm and concise." }));
  check("resolveCharter maps the settings row's charter columns", resolved.guidanceStyle === "socratic_strict" && resolved.scope === "course_plus_adjacent" && resolved.toneNotes === "Warm and concise." && resolved.courseCanon === "strict");

  /* ─────────────────────── serializeCharter goldens ──────────────────────── */
  console.log("\n# serializeCharter — byte-stability");
  const s1 = serializeCharter(DEFAULT_CHARTER);
  const s2 = serializeCharter(DEFAULT_CHARTER);
  check("serialize is deterministic — twice on the same charter is byte-identical", s1 === s2);
  // Input KEY ORDER must not change the bytes (fixed field order in the output).
  const reordered = TutorCharterSchema.parse({
    escalationSensitivity: "default",
    assessmentHelp: "concept_review_only",
    toneNotes: null,
    scope: "course_only",
    courseCanon: "strict",
    guidanceStyle: "guided_default",
  });
  check("input key order does not change the bytes", serializeCharter(reordered) === s1);
  check("serialized string begins with the TUTOR CHARTER header", s1.startsWith("TUTOR CHARTER\n"));
  check("default charter omits a Tone line (tone_notes null)", !s1.includes("Tone:"));

  // Each field varies the bytes.
  const varyGuidance = serializeCharter(TutorCharterSchema.parse({ guidanceStyle: "socratic_strict" }));
  const varyCanon = serializeCharter(TutorCharterSchema.parse({ courseCanon: "open" }));
  const varyScope = serializeCharter(TutorCharterSchema.parse({ scope: "course_plus_adjacent" }));
  const varyAssess = serializeCharter(TutorCharterSchema.parse({ assessmentHelp: "block" }));
  const varyEsc = serializeCharter(TutorCharterSchema.parse({ escalationSensitivity: "high" }));
  const varyTone = serializeCharter(TutorCharterSchema.parse({ toneNotes: "Encouraging, never condescending." }));
  check("changing guidance_style changes the bytes", varyGuidance !== s1);
  check("changing course_canon changes the bytes", varyCanon !== s1);
  check("changing scope changes the bytes", varyScope !== s1);
  check("changing assessment_help changes the bytes", varyAssess !== s1);
  check("changing escalation_sensitivity changes the bytes", varyEsc !== s1);
  check("adding a tone note changes the bytes + emits a Tone line", varyTone !== s1 && varyTone.includes("Tone: Encouraging, never condescending."));
  // Two charters differing ONLY by null vs "" tone MUST collide (empty tone omitted).
  check("null vs empty-string tone note serialize identically", serializeCharter(TutorCharterSchema.parse({ toneNotes: null })) === serializeCharter(TutorCharterSchema.parse({ toneNotes: "   " })));
  // All-distinct charters produce distinct bytes.
  const distinct = new Set([s1, varyGuidance, varyCanon, varyScope, varyAssess, varyEsc, varyTone]);
  check("seven distinct charters produce seven distinct strings", distinct.size === 7);
  check("CHARTER_PROMPT_VERSION is a stable string", CHARTER_PROMPT_VERSION === "charter-v1");

  /* ─────────────────────── charterSnapshot round-trip ────────────────────── */
  console.log("\n# charterSnapshot round-trip");
  const charter = TutorCharterSchema.parse({ guidanceStyle: "answer_forward", courseCanon: "open", toneNotes: "Direct." });
  const snap = charterSnapshot(charter) as Record<string, unknown>;
  check("snapshot carries the prompt-version stamp", snap.promptVersion === CHARTER_PROMPT_VERSION);
  check("snapshot carries every charter field", snap.guidanceStyle === "answer_forward" && snap.courseCanon === "open" && snap.scope === "course_only" && snap.toneNotes === "Direct." && snap.assessmentHelp === "concept_review_only" && snap.escalationSensitivity === "default");
  // Re-reading the snapshot's fields back into a charter reproduces the input.
  const roundTrip = TutorCharterSchema.parse({
    guidanceStyle: snap.guidanceStyle,
    courseCanon: snap.courseCanon,
    scope: snap.scope,
    toneNotes: snap.toneNotes,
    assessmentHelp: snap.assessmentHelp,
    escalationSensitivity: snap.escalationSensitivity,
  });
  check("snapshot → charter round-trips (byte-identical serialization)", serializeCharter(roundTrip) === serializeCharter(charter));

  /* ─────────────────────── migration drift guards ────────────────────────── */
  console.log("\n# migration drift guards");

  // All four tables created.
  for (const tbl of ["tutor_threads", "tutor_turns", "tutor_charter_versions", "tutor_escalation_candidates"]) {
    check(`table ${tbl} is created`, new RegExp(`create table public\\.${tbl}\\b`).test(MIGRATION));
  }
  // tutor_course_settings is EXTENDED, never re-created.
  check("tutor_course_settings is ALTERed, not re-created", /alter table public\.tutor_course_settings/.test(MIGRATION) && !/create table public\.tutor_course_settings/.test(MIGRATION));

  // RLS enabled on all four new tables.
  for (const tbl of ["tutor_threads", "tutor_turns", "tutor_charter_versions", "tutor_escalation_candidates"]) {
    check(`RLS enabled on ${tbl}`, new RegExp(`alter table public\\.${tbl}\\s+enable row level security`).test(MIGRATION));
  }

  // tutor_threads — one thread per (user, course).
  check("tutor_threads has unique (user_id, course_id)", /unique \(user_id, course_id\)/.test(MIGRATION));
  check("tutor_threads SELECT is own + enrolled", /create policy "tutor_threads_select"[\s\S]*?user_id = \(select auth\.uid\(\)\) and private\.is_enrolled\(course_id\)/.test(MIGRATION));
  check("tutor_threads INSERT is own + enrolled", /create policy "tutor_threads_insert"[\s\S]*?user_id = \(select auth\.uid\(\)\) and private\.is_enrolled\(course_id\)/.test(MIGRATION));
  check("tutor_threads has NO update policy", !/on public\.tutor_threads for update/.test(MIGRATION));
  check("tutor_threads has NO delete policy", !/on public\.tutor_threads for delete/.test(MIGRATION));

  // tutor_turns — append-only + role-restricted insert.
  check("tutor_turns has an immutability trigger", /create trigger tutor_turns_immutable before update on public\.tutor_turns/.test(MIGRATION));
  check("the immutability function raises 'tutor_turns are immutable'", /raise exception 'tutor_turns are immutable'/.test(MIGRATION));
  check("the immutability trigger is BEFORE UPDATE (not DELETE)", /tutor_turns_immutable before update/.test(MIGRATION) && !/tutor_turns_immutable before (update or )?delete/.test(MIGRATION) && !/tutor_turns[\s\S]{0,80}before delete/.test(MIGRATION));
  check("tutor_turns INSERT policy restricts role to 'learner'", /create policy "tutor_turns_insert"[\s\S]*?role = 'learner'/.test(MIGRATION));
  check("tutor_turns INSERT policy pins user_id + enrollment", /create policy "tutor_turns_insert"[\s\S]*?user_id = \(select auth\.uid\(\)\)[\s\S]*?private\.is_enrolled\(course_id\)/.test(MIGRATION));
  check("tutor_turns SELECT is own + enrolled", /create policy "tutor_turns_select"[\s\S]*?user_id = \(select auth\.uid\(\)\) and private\.is_enrolled\(course_id\)/.test(MIGRATION));
  check("tutor_turns has NO update policy (append-only)", !/on public\.tutor_turns for update/.test(MIGRATION));
  check("tutor_turns has NO delete policy", !/on public\.tutor_turns for delete/.test(MIGRATION));
  check("assistant/instructor turns are unrepresentable — no client policy names them", !/with check[\s\S]{0,200}role = 'assistant'/.test(MIGRATION) && !/with check[\s\S]{0,200}role = 'instructor'/.test(MIGRATION));
  check("tutor_turns role CHECK = learner/assistant/instructor", /role\s+text not null check \(role in \('learner','assistant','instructor'\)\)/.test(MIGRATION));
  check("tutor_turns content CHECK is 1..20000", /char_length\(content\) between 1 and 20000/.test(MIGRATION));
  check("tutor_turns rung CHECK is null or 0..4", /rung is null or rung between 0 and 4/.test(MIGRATION));
  check("tutor_turns grounding jsonb defaults to '{}'", /grounding\s+jsonb not null default '\{\}'::jsonb/.test(MIGRATION));
  check("tutor_turns has a response_id column (P-3 chaining seam)", /response_id\s+text/.test(MIGRATION));
  check("tutor_turns index on (thread_id, created_at)", /create index tutor_turns_thread_created_idx on public\.tutor_turns\(thread_id, created_at\)/.test(MIGRATION));

  // ZERO author policy on the strict-regime tables — no author/is_course_author
  // predicate anywhere near threads/turns/candidates.
  check("no is_course_author helper anywhere in the migration", !/private\.is_course_author/.test(MIGRATION));
  // Bound the scan to the policy STATEMENT (up to its terminating ';') — an
  // unbounded [\s\S]*? leaks into the unrelated charter_versions policy (which
  // legitimately names author_id) and false-positives.
  check("tutor_threads has no author-scoped policy", !/create policy "tutor_threads[^;]*?author_id/.test(MIGRATION));
  check("tutor_turns has no author-scoped policy", !/create policy "tutor_turns[^;]*?author_id/.test(MIGRATION));
  check("tutor_escalation_candidates has no author-scoped policy", !/create policy "tutor_escalation_candidates[^;]*?author_id/.test(MIGRATION));

  // Charter columns — exact CHECK vocabularies.
  check("guidance_style CHECK vocabulary", /guidance_style text not null default 'guided_default'[\s\S]*?check \(guidance_style in \('socratic_strict','guided_default','answer_forward'\)\)/.test(MIGRATION));
  check("course_canon CHECK vocabulary", /course_canon text not null default 'strict'[\s\S]*?check \(course_canon in \('strict','open'\)\)/.test(MIGRATION));
  check("scope CHECK vocabulary", /scope text not null default 'course_only'[\s\S]*?check \(scope in \('course_only','course_plus_adjacent'\)\)/.test(MIGRATION));
  check("tone_notes CHECK (null or ≤500)", /tone_notes text[\s\S]*?check \(tone_notes is null or char_length\(tone_notes\) <= 500\)/.test(MIGRATION));
  check("assessment_help CHECK vocabulary", /assessment_help text not null default 'concept_review_only'[\s\S]*?check \(assessment_help in \('block','concept_review_only'\)\)/.test(MIGRATION));
  check("escalation_sensitivity CHECK vocabulary", /escalation_sensitivity text not null default 'default'[\s\S]*?check \(escalation_sensitivity in \('low','default','high'\)\)/.test(MIGRATION));
  check("current_charter_version_id column added", /add column current_charter_version_id uuid/.test(MIGRATION));
  check("current_charter_version_id FK → tutor_charter_versions", /foreign key \(current_charter_version_id\)\s*references public\.tutor_charter_versions\(id\)/.test(MIGRATION));

  // tutor_charter_versions — append-only + author RLS.
  check("charter_versions has an immutability trigger", /create trigger tutor_charter_versions_immutable before update on public\.tutor_charter_versions/.test(MIGRATION));
  check("charter_versions raises 'tutor_charter_versions are immutable'", /raise exception 'tutor_charter_versions are immutable'/.test(MIGRATION));
  check("charter_versions has author SELECT via the semi-join idiom", /create policy "tutor_charter_versions_select"[\s\S]*?course_id in \(select c\.id from public\.courses c where c\.author_id = \(select auth\.uid\(\)\)\)/.test(MIGRATION));
  check("charter_versions has author INSERT via the semi-join idiom", /create policy "tutor_charter_versions_insert"[\s\S]*?course_id in \(select c\.id from public\.courses c where c\.author_id = \(select auth\.uid\(\)\)\)/.test(MIGRATION));
  check("charter_versions has NO update policy", !/on public\.tutor_charter_versions for update/.test(MIGRATION));
  check("charter_versions has NO delete policy", !/on public\.tutor_charter_versions for delete/.test(MIGRATION));
  check("charter_versions snapshot is jsonb NOT NULL", /snapshot\s+jsonb not null/.test(MIGRATION));

  // tutor_escalation_candidates — status-only trigger + legal transitions.
  check("candidates has a status-only trigger", /create trigger tutor_escalation_candidates_status_only\s+before update on public\.tutor_escalation_candidates/.test(MIGRATION));
  check("candidates trigger rejects non-status column changes", /raise exception 'tutor_escalation_candidates: only the status may change'/.test(MIGRATION));
  check("candidates trigger allows only consent_pending → {consented,withdrawn}", /old\.status = 'consent_pending' and new\.status in \('consented','withdrawn'\)/.test(MIGRATION));
  check("candidates trigger rejects illegal transitions", /raise exception 'tutor_escalation_candidates: illegal status transition/.test(MIGRATION));
  check("candidates status CHECK vocabulary", /check \(status in \('consent_pending','consented','withdrawn'\)\)/.test(MIGRATION));
  check("candidates default status is consent_pending", /status\s+text not null default 'consent_pending'/.test(MIGRATION));
  check("candidates SELECT is learner-own", /create policy "tutor_escalation_candidates_select"[\s\S]*?user_id = \(select auth\.uid\(\)\)/.test(MIGRATION));
  check("candidates UPDATE is learner-own (status-only enforced by the trigger)", /create policy "tutor_escalation_candidates_update"[\s\S]*?user_id = \(select auth\.uid\(\)\)/.test(MIGRATION));
  check("candidates has NO insert policy (service-role writes)", !/on public\.tutor_escalation_candidates for insert/.test(MIGRATION));
  check("candidates has NO delete policy", !/on public\.tutor_escalation_candidates for delete/.test(MIGRATION));
  check("candidates learner_question CHECK ≤4000", /char_length\(learner_question\) <= 4000/.test(MIGRATION));
  check("candidates tutor_proposed_answer CHECK (null or ≤8000)", /tutor_proposed_answer is null or char_length\(tutor_proposed_answer\) <= 8000/.test(MIGRATION));

  // House style: comments on every new table.
  for (const tbl of ["tutor_threads", "tutor_turns", "tutor_charter_versions", "tutor_escalation_candidates"]) {
    check(`comment on table ${tbl}`, new RegExp(`comment on table public\\.${tbl} is`).test(MIGRATION));
  }

  /* ─────────────────────────────── done ─────────────────────────────────── */
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
