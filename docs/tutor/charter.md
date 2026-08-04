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
