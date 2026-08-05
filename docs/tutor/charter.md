# TUTOR-1 — The Course Charter (fields · defaults · effects)

> The creator's contract with the tutor: six knobs on
> `tutor_course_settings`, serialized byte-stably into prompt layer L1
> (`lib/tutor/runtime/charter.ts`), versioned append-only in
> `tutor_charter_versions` (every change writes a full snapshot with actor +
> timestamp; the settings row points at the current version). Schema shipped
> Wave 3; the creator UI arrives in Wave 5.

| Field | Values (default bold) | Effect |
| --- | --- | --- |
| `guidance_style` | `socratic_strict` · **`guided_default`** · `answer_forward` | The scaffolding ladder's climb rate and opening-rung cap (1/2/3). Every style honors an explicit "just show me" with immediate rung 4. |
| `course_canon` | **`strict`** · `open` | `strict` suppresses supplemental (`⟦s⟧`) content entirely — the tutor teaches THIS course; `open` allows clearly-marked outside material that never contradicts the course. |
| `scope` | **`course_only`** · `course_plus_adjacent` | Whether the tutor may engage adjacent topics the course doesn't cover (consumed by L0 phrasing; enforcement deepens in later waves). |
| `tone_notes` | free text ≤500 (default empty) | Creator voice guidance, serialized verbatim into L1. |
| `assessment_help` | `block` · **`concept_review_only`** | With a quiz active: `concept_review_only` scaffolds concepts but never answers the live question (rung ≤3 clamp); `block` refuses quiz-adjacent help entirely — zero model calls. |
| `escalation_sensitivity` | `low` · **`default`** · `high` | How readily the tutor proposes escalating to the instructor (consumed by L0 phrasing; the Wave-6 loop will weight it). |

Charter edits go through `applyCharterChange`: the version row is written
FIRST (full post-change snapshot), then the settings columns + the
`current_charter_version_id` pointer update — the next assembled prompt
reflects the change (AC-T5.2, schema half; the Wave-5 UI consumes this).
`resolveCharter(null)` yields all defaults, so a course with no settings
row still has a well-defined charter — but the tutor itself stays DISABLED
until `enabled = true`.

## The creator console (Wave 5 — the UI half of AC-T5.2)

The charter's creator UI is the **Enablement & charter** tab of the Creator
Tutor Console (`/studio/[courseId]/tutor?tab=charter`). It is pure UI over the
Wave-3 backend — no new charter mutation path:

- **Enablement** is a `role="switch"` toggle writing `tutor_course_settings.enabled`
  via a server action. Turning it ON is **gated on an accepted concept graph**
  (`active concept_nodes` exist AND no pending `concept_graph` change-set): with
  none, the toggle routes into the extraction flow (build → review → accept →
  enable) rather than failing. Turning it OFF removes the learner sidebar for
  every learner (the `resolveTutorAccess` gate reads `enabled`), returns the
  typed-disabled response on the tutor route, and skips scheduled tutor jobs.
- **The six charter fields** are edited with `SegmentedControl`s (guidance_style,
  course_canon, scope, assessment_help, escalation_sensitivity) + a `tone_notes`
  textarea (≤500), saved through `applyCharterChange` — so every save writes a
  full `tutor_charter_versions` snapshot (actor + timestamp) and moves the
  pointer, and the next assembled prompt reflects it. The server re-validates the
  enum values (never trusts the client).
- **Version history** renders the `tutor_charter_versions` rows (who changed it,
  when) — the author-readable audit of the charter over time.

All console reads ride author-gated, cohort-floored (`>= 5`) SECURITY DEFINER
RPCs (`tutor_console_bundle`); no creator number ever comes from a raw learner
table. See `analytics.md` for the analytics privacy contract and `architecture.md`
for the console's place in the system.
