/**
 * Tutor course charter — the serialization half of AC-T5.2 (TUTOR-1 Wave 3).
 *
 * The CHARTER is the six creator-owned knobs that shape how the tutor behaves in
 * a course (guidance style, canon, scope, tone, assessment-help policy,
 * escalation sensitivity). It lives on tutor_course_settings; every change is
 * versioned into tutor_charter_versions (append-only). THIS module owns:
 *
 *   • the Zod schema + defaults (the single source of truth for the six fields),
 *   • `resolveCharter(row | null)` — a settings row (or its absence) → a charter,
 *   • `serializeCharter(charter)` — the BYTE-STABLE prompt-layer-L1 string,
 *   • `charterSnapshot(charter)` — the tutor_charter_versions row payload,
 *   • `applyCharterChange(...)` — write the version row, then repoint settings.
 *
 * ── THE BYTE-STABILITY CONTRACT (load-bearing) ───────────────────────────────
 * `serializeCharter` IS prompt layer L1: the string it returns is spliced
 * verbatim into the assembled tutor prompt. Two IDENTICAL charters MUST produce
 * BYTE-IDENTICAL strings — so prompt caching holds and an unchanged charter never
 * perturbs the cached prefix. That requires: a FIXED field order (never object-
 * key iteration), FIXED phrasing per value, and no interpolation of anything
 * volatile (timestamps, ids, versions). If you change the phrasing or order here,
 * bump CHARTER_PROMPT_VERSION — the serialized bytes are a versioned artifact,
 * and downstream telemetry stamps the version alongside the assembled prompt.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/* ─────────────────────────────── vocabularies ───────────────────────────────
 * These enums mirror the migration CHECK constraints EXACTLY. The pure suite
 * asserts both directions (schema ↔ DDL) so a divergence trips CI. */
export const GUIDANCE_STYLES = ["socratic_strict", "guided_default", "answer_forward"] as const;
export const COURSE_CANONS = ["strict", "open"] as const;
export const TUTOR_SCOPES = ["course_only", "course_plus_adjacent"] as const;
export const ASSESSMENT_HELP_MODES = ["block", "concept_review_only"] as const;
export const ESCALATION_SENSITIVITIES = ["low", "default", "high"] as const;

export type GuidanceStyle = (typeof GUIDANCE_STYLES)[number];
export type CourseCanon = (typeof COURSE_CANONS)[number];
export type TutorScope = (typeof TUTOR_SCOPES)[number];
export type AssessmentHelpMode = (typeof ASSESSMENT_HELP_MODES)[number];
export type EscalationSensitivity = (typeof ESCALATION_SENSITIVITIES)[number];

/** The version of the SERIALIZED charter phrasing (prompt layer L1). Bump when
 *  the wording/order in `serializeCharter` changes — the bytes are a versioned
 *  artifact and telemetry records this alongside the assembled prompt. */
export const CHARTER_PROMPT_VERSION = "charter-v1";

/* ─────────────────────────────── defaults ───────────────────────────────────
 * The exact DEFAULTs from the migration. An absent settings row resolves to
 * these — a course with no charter behaves as `guided_default` (the safe middle
 * ground), course-canon strict, course-only scope, no tone notes, concept-review
 * assessment help, and default escalation sensitivity. */
export const CHARTER_DEFAULTS = {
  guidanceStyle: "guided_default",
  courseCanon: "strict",
  scope: "course_only",
  toneNotes: null,
  assessmentHelp: "concept_review_only",
  escalationSensitivity: "default",
} as const;

/* ─────────────────────────────── schema ─────────────────────────────────────
 * The six charter fields, each defaulted so `TutorCharterSchema.parse({})`
 * yields CHARTER_DEFAULTS. tone_notes is the only free text (≤500, matching the
 * DDL CHECK); null when unset. */
export const TutorCharterSchema = z.object({
  guidanceStyle: z.enum(GUIDANCE_STYLES).default(CHARTER_DEFAULTS.guidanceStyle),
  courseCanon: z.enum(COURSE_CANONS).default(CHARTER_DEFAULTS.courseCanon),
  scope: z.enum(TUTOR_SCOPES).default(CHARTER_DEFAULTS.scope),
  toneNotes: z.string().max(500).nullable().default(CHARTER_DEFAULTS.toneNotes),
  assessmentHelp: z.enum(ASSESSMENT_HELP_MODES).default(CHARTER_DEFAULTS.assessmentHelp),
  escalationSensitivity: z
    .enum(ESCALATION_SENSITIVITIES)
    .default(CHARTER_DEFAULTS.escalationSensitivity),
});
export type TutorCharter = z.infer<typeof TutorCharterSchema>;

/** A patch to the charter — any subset of the six fields. */
export type TutorCharterPatch = Partial<TutorCharter>;

/* ─────────────────────────────── resolveCharter ─────────────────────────────
 * A tutor_course_settings row (snake-case, as read from the DB) → a domain
 * charter. A null/absent row → all defaults (the course has no charter yet).
 * Only the six charter columns are read; the rest of the settings row is
 * ignored here (that's the tutor-config concern, not the charter). */
type SettingsRow = Database["public"]["Tables"]["tutor_course_settings"]["Row"];

export function resolveCharter(row: SettingsRow | null | undefined): TutorCharter {
  if (!row) return TutorCharterSchema.parse({});
  return TutorCharterSchema.parse({
    guidanceStyle: row.guidance_style,
    courseCanon: row.course_canon,
    scope: row.scope,
    toneNotes: row.tone_notes,
    assessmentHelp: row.assessment_help,
    escalationSensitivity: row.escalation_sensitivity,
  });
}

/* ─────────────────────────────── serializeCharter ───────────────────────────
 * The BYTE-STABLE prompt-layer-L1 string. FIXED order, FIXED phrasing, one line
 * per field, no volatile interpolation (see the byte-stability contract at the
 * top). tone_notes is quoted verbatim when present and OMITTED (no blank line)
 * when absent, so the string's shape reflects only the charter's content. */

const GUIDANCE_PHRASING: Record<GuidanceStyle, string> = {
  socratic_strict:
    "Never state the answer outright. Lead the learner to it with questions and hints only.",
  guided_default:
    "Guide the learner with hints and scaffolding first; give a direct answer only once they are close or ask plainly.",
  answer_forward:
    "Answer directly and concisely first, then briefly explain the reasoning behind it.",
};

const CANON_PHRASING: Record<CourseCanon, string> = {
  strict:
    "Ground every claim in this course's material. Do not introduce facts, methods, or framings the course does not teach.",
  open:
    "Prefer this course's material, but you may draw on well-established general knowledge to fill gaps.",
};

const SCOPE_PHRASING: Record<TutorScope, string> = {
  course_only: "Stay within the concepts this course covers.",
  course_plus_adjacent:
    "Stay within this course's concepts and directly adjacent prerequisites the course assumes.",
};

const ASSESSMENT_PHRASING: Record<AssessmentHelpMode, string> = {
  block:
    "Do not help with active assessments. If the learner asks about a graded quiz or homework in progress, decline and redirect to reviewing the underlying concepts afterward.",
  concept_review_only:
    "For active assessments, help only by reviewing the underlying concepts — never supply an answer to a graded item.",
};

const ESCALATION_PHRASING: Record<EscalationSensitivity, string> = {
  low: "Escalate to a human instructor sparingly — only when the learner is clearly and repeatedly stuck.",
  default:
    "Escalate to a human instructor when the learner remains stuck after reasonable guidance.",
  high: "Escalate to a human instructor readily — err toward offering a human hand-off when there is any doubt.",
};

export function serializeCharter(charter: TutorCharter): string {
  // Normalize through the schema so callers can't smuggle in undefined fields
  // and change the byte output; every field is resolved to a defaulted value.
  const c = TutorCharterSchema.parse(charter);
  const lines: string[] = [
    "TUTOR CHARTER",
    `Guidance style: ${GUIDANCE_PHRASING[c.guidanceStyle]}`,
    `Course canon: ${CANON_PHRASING[c.courseCanon]}`,
    `Scope: ${SCOPE_PHRASING[c.scope]}`,
    `Assessment help: ${ASSESSMENT_PHRASING[c.assessmentHelp]}`,
    `Escalation: ${ESCALATION_PHRASING[c.escalationSensitivity]}`,
  ];
  // tone_notes: quote verbatim only when present. Omitting it (rather than
  // emitting an empty line) keeps two charters that differ ONLY by a null vs
  // "" tone note from colliding, and keeps the bytes minimal.
  if (c.toneNotes && c.toneNotes.trim().length > 0) {
    lines.push(`Tone: ${c.toneNotes.trim()}`);
  }
  return lines.join("\n");
}

/* ─────────────────────────────── charterSnapshot ────────────────────────────
 * The tutor_charter_versions.snapshot payload: the full charter, plus the
 * prompt-version stamp so a historical version records which phrasing produced
 * its serialized bytes. Deterministic key order (the object is built literally),
 * so a snapshot round-trips through resolveCharter/JSON stably. */
export function charterSnapshot(charter: TutorCharter): Json {
  const c = TutorCharterSchema.parse(charter);
  return {
    promptVersion: CHARTER_PROMPT_VERSION,
    guidanceStyle: c.guidanceStyle,
    courseCanon: c.courseCanon,
    scope: c.scope,
    toneNotes: c.toneNotes,
    assessmentHelp: c.assessmentHelp,
    escalationSensitivity: c.escalationSensitivity,
  };
}

/* ─────────────────────────────── applyCharterChange ─────────────────────────
 * Apply a charter patch to a course: compute the post-change charter, write the
 * version row FIRST (full snapshot + actor + timestamp), THEN update the six
 * settings columns AND repoint current_charter_version_id in ONE update. Writing
 * the version row first means the settings pointer always references a row that
 * already exists (no dangling FK). Returns the new version id.
 *
 * The current charter is read from the settings row (absent → defaults), the
 * patch is layered on, and the merged charter is validated before it is written
 * — an out-of-vocabulary value fails here, never reaching the DB.
 *
 * The settings row is upserted (a course may not have a tutor_course_settings
 * row yet); the FK on current_charter_version_id is satisfied because the version
 * row is inserted first.
 */
export async function applyCharterChange(
  supabase: DB,
  courseId: string,
  actor: string,
  patch: TutorCharterPatch
): Promise<{ versionId: string }> {
  // Read the current settings row (may be absent → defaults).
  const { data: current, error: readErr } = await supabase
    .from("tutor_course_settings")
    .select("*")
    .eq("course_id", courseId)
    .maybeSingle();
  if (readErr) throw new Error(`applyCharterChange(read settings): ${readErr.message}`);

  const base = resolveCharter(current ?? null);
  const merged = TutorCharterSchema.parse({ ...base, ...patch });

  // (1) Write the version row FIRST (its id is what the pointer will reference).
  const versionInsert: Database["public"]["Tables"]["tutor_charter_versions"]["Insert"] = {
    course_id: courseId,
    actor,
    snapshot: charterSnapshot(merged),
  };
  const { data: version, error: versionErr } = await supabase
    .from("tutor_charter_versions")
    .insert(versionInsert)
    .select("id")
    .single();
  if (versionErr || !version) {
    throw new Error(`applyCharterChange(write version): ${versionErr?.message}`);
  }

  // (2) Upsert the settings row with the merged charter + the new pointer in one
  //     write. course_id is the PK, so onConflict repoints an existing row.
  const settingsUpsert: Database["public"]["Tables"]["tutor_course_settings"]["Insert"] = {
    course_id: courseId,
    guidance_style: merged.guidanceStyle,
    course_canon: merged.courseCanon,
    scope: merged.scope,
    tone_notes: merged.toneNotes,
    assessment_help: merged.assessmentHelp,
    escalation_sensitivity: merged.escalationSensitivity,
    current_charter_version_id: version.id,
  };
  const { error: settingsErr } = await supabase
    .from("tutor_course_settings")
    .upsert(settingsUpsert, { onConflict: "course_id" });
  if (settingsErr) throw new Error(`applyCharterChange(update settings): ${settingsErr.message}`);

  return { versionId: version.id };
}
