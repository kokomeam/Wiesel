# DESIGN — Quiz & Homework Assessment Artifacts

> **Status (2026-06-14): IMPLEMENTED.** Phases 1–3 shipped & verified (build +
> lint green; 15/15 Playwright run on `/studio`, 0 console errors). Phase 4
> scaffolded but **not applied** — `supabase/drafts/assessment_runtime.sql`.
> Decisions D0–D5 below were approved as recommended. This doc is kept as the
> design record; the sections below describe what was built.
> **Date:** 2026-06-14 · Companion to `HANDOFF.md`.

---

## 0. Assessment of the existing code (what's already there)

I read `lib/course/types.ts`, `schemas.ts`, `patches.ts`, `store.ts`,
`commands.ts`, `factories.ts`, `manifest.ts`, `seed.ts`, and the block editors
(`QuizEditor`, `QuestionCard`, `HomeworkEditor`, `ExerciseCard`) plus the
slide-deck gold standard (`SlideDeckEditor`, `SlideThumbnailStrip`,
`LessonWorkspace`, `AddBlockMenu`, `InlineText`).

**The headline finding changes the framing of this task:**

> **`quiz` and `homework` are NOT new block types. They already exist end-to-end**
> — and there is live seed data using them.

| Layer | Current state for quiz / homework |
|---|---|
| `BlockType` (types.ts) | `slide_deck \| lecture_text \| quiz \| homework \| exercise \| example \| resource` — **7 types, quiz+homework present** |
| Block `type` is… | a **closed TS discriminated union**, mirrored by a Zod `discriminatedUnion("type")` (`LessonBlockSchema`), mirrored by the DB **`blocks.type` CHECK** constraint (all 7 values already listed) |
| Zod (schemas.ts) | `QuizQuestionSchema` (mc/true_false/short_answer), `HomeworkExerciseSchema`, `RubricCriterionSchema` already exist |
| Patches (patches.ts) | `ADD_QUIZ_QUESTION`, `UPDATE_QUIZ_QUESTION`, `CHANGE_DIFFICULTY`, `GENERATE_EXPLANATION`, `ADD_HOMEWORK_EXERCISE` exist; instructions/exercise fields edit via `UPDATE_TEXT` `block_field` |
| Manifest (manifest.ts) | `quiz`, `quiz_question`, `homework` entries with `allowedActions` |
| Factories | `createQuestion(kind)`, `createExercise()`, `createBlock("quiz"/"homework")` |
| UI | `QuizEditor` + `QuestionCard`, `HomeworkEditor` + `ExerciseCard` (read-only rubric summary) |
| Seed | `block-tp-quiz` (3 questions) and `block-tp-homework` (2 exercises + 3 flat-points rubric criteria) are **live data** |

**What's MISSING vs. the assessment-grade spec you described:**

- **Quiz:** no settings (time limit / attempts / shuffle / passing score /
  when-to-show-answers); no per-question `points`; no `multi_select` type; no
  delete-question or reorder-question patches; no objective link.
- **Homework:** no `deliverable_type`, `due_at`, `points`, `estimated_minutes`,
  objective link; rubric is **flat `points`** (no `levels[]`); no rubric
  edit/add/delete/reorder patches (rubric is read-only today); no
  delete/reorder-exercise patches.

So the work is **evolving two existing block types into richer, gradable
artifacts** — extending the shapes, filling the operations gaps, and rebuilding
the two editors to the slide editor's polish. This is lower-risk than net-new
types but introduces a few **backward-compat decisions** (below) because the
seed already contains quiz/homework data.

### The slide pattern we'll mirror (the established conventions)
- **One source of truth → two mirrors:** hand-written TS interface in
  `types.ts`, Zod mirror in `schemas.ts` pinned `satisfies z.ZodType<X>`. Patches
  are Zod-first (`CoursePatch = z.infer<…>`).
- **One mutation path:** every change (human or AI) is a `CoursePatch` →
  `store.apply` / `applyMany` → validate → pure `applyCoursePatch` → undo stack.
  `applyMany` = one undo step for a multi-patch gesture.
- **Producers generate ids** (`factories.ts`, event handlers only — never
  render). Patches carry ids so the reducer stays pure/deterministic.
- **Commands layer** (`commands.ts`) builds patches; the UI and (later) the AI
  both call it. **This is the "one operations layer."**
- **Inline edits** = `InlineText`/`InlineTextArea`, one commit (one patch) on
  blur/Enter.
- **Manifest** (`manifest.ts`) is the AI-readable registry of types +
  `allowedActions`; new patches must be added to the relevant entries.

---

## 1. Migration question: **No DB migration needed**

`blocks.type`'s CHECK already includes `'quiz'` and `'homework'`. We are **not
adding a new enum value** — we're enriching the **`blocks.content` jsonb**
payload, which is schemaless at the DB layer and validated in-app by Zod. So:

- ✅ **No `apply_migration` for the type enum.**
- ✅ No content backfill (persistence isn't wired yet — **0 block rows exist**;
  the only live instances are in the in-memory seed, which we update in code).
- The DB stays exactly as in `HANDOFF.md`. The Phase-4 **runtime** tables
  (§5) are the only new DDL, and they're scaffold-only pending approval.

(If, in Phase 1, we decide we want belt-and-suspenders validation of
`content` at the DB layer, that'd be an *optional* `CHECK`/`pg_jsonschema`
trigger — I recommend **against** it: it duplicates the Zod boundary and fights
schema evolution. Flagging as a non-default option only.)

---

## 2. Content schemas (proposed jsonb shapes)

These are the **in-memory** shapes (the Zod-validated `LessonBlock` variants).
The **persistence mapping** is mechanical and forward-looking: a block row's
columns are `id, lesson_id, course_id, type, title, order`; everything else
below lives in **`blocks.content` jsonb** (including the `ai` envelope). No rows
exist yet, so this just defines the target shape for when persistence lands.

### 2a. Quiz

```ts
// NEW — optional on QuizBlock; a resolver supplies defaults when absent
interface QuizSettings {
  timeLimitMinutes?: number | null;   // absent/null = untimed
  attemptsAllowed?: number | null;    // absent/null = unlimited
  shuffleQuestions?: boolean;         // default false
  shuffleOptions?: boolean;           // default false
  passingScore?: number;              // percent 0..100, default 70
  whenToShowAnswers?: "immediately" | "after_submit" | "after_due" | "never"; // default "after_submit"
}

// question base — adds `points` + optional objective link to today's shape
interface QuizQuestionBase {
  id: string;
  prompt: string;                     // (kept; see naming decision D1)
  explanation?: string;
  difficulty: "easy" | "medium" | "hard";  // kept (drives CHANGE_DIFFICULTY)
  points?: number;                    // NEW, default 1 via resolver
  objectiveId?: string;               // NEW, optional — links to lesson objective/tag
}

type QuizQuestion =
  | (QuizQuestionBase & { kind: "multiple_choice"; choices: {id:string;text:string}[]; correctChoiceId: string })
  | (QuizQuestionBase & { kind: "multi_select";    choices: {id:string;text:string}[]; correctChoiceIds: string[] })   // NEW
  | (QuizQuestionBase & { kind: "true_false";       correctAnswer: boolean })
  | (QuizQuestionBase & { kind: "short_answer";     expectedAnswer: string; acceptedAnswers?: string[] });             // acceptedAnswers NEW

interface QuizBlock extends BaseBlock {
  type: "quiz";
  settings?: QuizSettings;            // NEW (optional; resolver gives defaults)
  questions: QuizQuestion[];          // kept
}
```

**`blocks.content` jsonb for a quiz:** `{ ai, settings, questions }`.

### 2b. Homework

```ts
type DeliverableType = "text_response" | "file_upload" | "external_link";

// rubric EVOLVES from flat points → levels (see decision D2)
interface RubricLevel { id: string; label: string; description?: string; points: number; }  // NEW
interface RubricCriterion {
  id: string;
  name: string;
  description?: string;
  levels: RubricLevel[];              // CHANGED (was: flat `points: number`)
}

interface HomeworkExercise {          // kept as-is
  id: string; title: string; prompt: string; hint?: string; solution?: string;
}

interface HomeworkBlock extends BaseBlock {
  type: "homework";
  instructions: string;               // kept
  deliverableType: DeliverableType;   // NEW (factory default "text_response")
  dueAt?: string;                     // NEW, ISO-8601, optional
  points?: number;                    // NEW total (or derived = Σ max level)
  estimatedMinutes?: number;          // NEW, optional
  objectiveId?: string;               // NEW, optional
  exercises: HomeworkExercise[];      // kept
  rubric?: RubricCriterion[];         // optional; element shape changed
}
```

**`blocks.content` jsonb for homework:**
`{ ai, instructions, deliverableType, dueAt?, points?, estimatedMinutes?, objectiveId?, exercises, rubric? }`.

**Compatibility impact (because the seed has live data):**
- New **optional** fields (`settings`, `points`, `dueAt`, `estimatedMinutes`,
  `objectiveId`, `acceptedAnswers`) → seed stays valid untouched; defaults via a
  small `resolveQuizSettings()` / `questionPoints()` helper (mirrors the slide
  `styleResolver` "defaults under overrides").
- **`deliverableType`** is required → the **seed homework + `createBlock`
  factory** get `"text_response"` (one-line change each).
- **`RubricCriterion.levels[]`** replaces flat `points` → the **seed rubric**
  (3 criteria) is rewritten to a 2–3 level shape, and `HomeworkEditor`'s
  read-only summary (which sums `criterion.points`) is updated to
  `Σ max(level.points)`. Both happen **in Phase 1** so the build stays green.

---

## 3. Phase 1 — content schemas (Zod) · likely no migration

**Files:** `types.ts` (interfaces), `schemas.ts` (Zod mirrors + `satisfies`),
`factories.ts` (defaults), `seed.ts` (migrate the two live blocks), and the
minimal `HomeworkEditor` rubric-summary fix to keep `tsc`/lint green.

- Add `QuizSettings`, `multi_select`, `points`, `objectiveId`, `acceptedAnswers`
  to the quiz types + Zod.
- Add the homework meta fields + evolve `RubricCriterion`/`RubricLevel` in types
  + Zod.
- Resolver helpers for defaults (no DB, pure functions).
- **Authoring approach (decision D0):** stay **TS-first + Zod-mirror** to match
  the existing `QuizBlock`/`HomeworkBlock` (your instruction said "derive TS
  types from Zod"; I recommend keeping the repo's established direction instead
  so the new code is identical in style to the surrounding model — easy to flip
  if you'd rather go Zod-first).
- **No migration** (per §1). After this phase: `npm run build` + `npm run lint`
  green; seed renders in the existing editors unchanged in behavior.

---

## 4. Phase 2 — operations layer + AI tool surface

### 4a. New patches (added to `CoursePatchSchema` + reducer in `patches.ts`)
**Quiz** (adds to existing `ADD_/UPDATE_QUIZ_QUESTION`, `CHANGE_DIFFICULTY`, `GENERATE_EXPLANATION`):
- `UPDATE_QUIZ_SETTINGS { blockId, settings }`
- `DELETE_QUIZ_QUESTION { blockId, questionId }`  ← fills the HANDOFF "quiz question delete" gap
- `REORDER_QUIZ_QUESTION { blockId, questionId, toIndex }`

**Homework** (adds to existing `ADD_HOMEWORK_EXERCISE`):
- `UPDATE_HOMEWORK_META { blockId, meta: { deliverableType?, dueAt?, points?, estimatedMinutes?, objectiveId? } }`
- `DELETE_HOMEWORK_EXERCISE { blockId, exerciseId }`
- `REORDER_HOMEWORK_EXERCISE { blockId, exerciseId, toIndex }`
- `SET_RUBRIC { blockId, rubric }` · `ADD_RUBRIC_CRITERION { blockId, criterion, atIndex? }` ·
  `UPDATE_RUBRIC_CRITERION { blockId, criterionId, criterion }` ·
  `DELETE_RUBRIC_CRITERION { blockId, criterionId }` · `REORDER_RUBRIC_CRITERION { blockId, criterionId, toIndex }`

Each gets a `commands.ts` creator and a reducer case (same `findBlock` +
type-guard + `normalizeOrders` style already used for questions/exercises). Plus
`manifest.ts` updates: extend `quiz` / `quiz_question` / `homework`
`allowedActions`, note `multi_select`, add a `rubric_criterion` entry.

### 4b. AI tool signatures (defined now, **NOT wired to the model**)
Thin, pure wrappers over the commands layer (return `CoursePatch[]`), declared in
a new `lib/course/ai/assessmentTools.ts` with a descriptor table ready to plug
into `mockClient.ts` later:
- `create_quiz_block(lessonId, opts)` · `add_question(blockId, kind, draft?)` ·
  `update_question(blockId, questionId, q)` · `reorder_questions(blockId, orderedIds[])`
- `create_homework_block(lessonId, opts)` · `set_rubric(blockId, criteria[])` ·
  `add_rubric_criterion(blockId, criterion)`
- `get_course_context(lessonId)` → **read-only** summary of sibling blocks
  (slide headings, lecture key-ideas, example takeaway, lesson objective) so
  generated assessments align to what was taught. Pure read over the doc via
  `queries.ts`.

> They exist as typed functions + a tool manifest entry; `mockClient.ts` does
> **not** call them yet (wired in the later "real LLM" step from HANDOFF).

### 4c. Persistence note
Because every edit is already a validated patch, when the generic blocks
persistence lands (HANDOFF next-steps #3) these assessments serialize for free:
the whole `content` jsonb is the block minus its columns. Nothing assessment-
specific is needed in the persistence layer.

---

## 5. Phase 3 — builder UIs (rebuild to slide-editor polish)

Conventions: `components/ui/*` primitives, `cn` from `@/lib/cn`, Tailwind v4
warm/stone palette, `InlineText`/`InlineTextArea` commit-on-blur, `aiAttrs`/
`toolAttrs` data attributes, `AIActionButton` presets. **Reordering uses
`@dnd-kit/sortable`, mirroring `CourseOutlineSidebar`** (the slide filmstrip is
not sortable, so the outline is the reference implementation).

**Quiz builder** (rewrite `QuizEditor` + `QuestionCard`):
- Collapsible **settings bar**: time limit, attempts, shuffle toggles, passing
  score, when-to-show-answers select → `UPDATE_QUIZ_SETTINGS`.
- **Sortable question list** (dnd-kit) → `REORDER_QUIZ_QUESTION`; drag handle +
  delete (`DELETE_QUIZ_QUESTION`).
- Per-question: type badge, prompt, **points** input, difficulty toggle (exists),
  per-type answer editors incl. **`multi_select`** (checkbox set) and
  short-answer **accepted answers**, explanation, optional objective link.
- Add-question controls (mc / multi_select / true_false / short_answer) + AI
  presets (existing).

**Assignment editor** (rewrite `HomeworkEditor`, reuse `ExerciseCard`, new
`RubricEditor`):
- **Meta row**: deliverable-type segmented control, due-date picker, points,
  estimated minutes → `UPDATE_HOMEWORK_META`.
- Instructions (`InlineTextArea`, exists).
- **Sortable exercises** (dnd-kit) → `REORDER_HOMEWORK_EXERCISE` + delete.
- **`RubricEditor`** (new): criteria cards, each with name/description + a
  **levels** row (label/description/points), add/delete/reorder criteria & levels
  (dnd-kit), auto-summed total → rubric patches.
- AI presets.

All run against the in-memory `CourseDocument`/Zustand on mock data and persist
automatically once generic blocks wiring lands. Verified the slide way:
`npm run build` + `npm run lint`, then the temporary-Playwright `data-ai-*`
driven check (add/edit/reorder/delete a question, edit settings, build a rubric).

---

## 6. Phase 4 — runtime tables (SCAFFOLD ONLY; build on explicit approval)

For learners *taking* and creators *grading* assessments. **DDL written and
shown for approval; NOT applied** until you say so. **Depends on** (a) the
generic blocks persistence and (b) `enrollments` (deferred to the Phase-2
backend in HANDOFF) for the "is enrolled" read gate.

Proposed tables (all RLS-on, reusing the `is_course_author` / `can_read_course`
helpers + a new `is_enrolled(course_id)`):
- **`quiz_attempts`** — `id, quiz_block_id, course_id, learner_id, attempt_number,
  started_at, submitted_at, score, max_score, passed`. RLS: learner CRUD own
  attempts; author read-only for their course.
- **`quiz_responses`** — `id, attempt_id, question_id, response jsonb,
  is_correct, points_awarded`. **Auto-grade**: `multiple_choice` (id match),
  `multi_select` (set equality), `true_false` (bool); `short_answer` =
  normalized/accepted-answers match else flag for manual.
- **`homework_submissions`** — `id, homework_block_id, course_id, learner_id,
  submitted_at, deliverable jsonb (text / file path in `course-assets` / link),
  status`.
- **`homework_grades`** — `id, submission_id, grader_id, rubric_scores jsonb
  (criterionId → levelId/points), total, feedback, graded_at`.

Auto-grading runs client-side first (pure functions over the question schema,
reusable in Phase 3 previews), with an edge-function option later for
authority. This phase is intentionally deferred.

---

## 7. Decisions to confirm before I write code

| # | Decision | Recommendation |
|---|---|---|
| **D0** | Schema authoring: TS-first + Zod-mirror (repo convention) vs Zod-first `z.infer` (your literal phrasing) | **TS-first + Zod-mirror** — matches existing `QuizBlock`/`HomeworkBlock` exactly |
| **D1** | Question field names: keep `kind`/`prompt`/`choices`/`correctChoiceId` vs rename to your `type`/`stem`/`options`/`correct` | **Keep existing names**, just add `points`, `multi_select`, `objectiveId` — far less churn (UI, seed, patches, AI all keep working). Rename is doable but touches every quiz consumer |
| **D2** | Rubric: evolve flat `points` → `levels[]` (rewrites seed + `HomeworkEditor` summary in Phase 1) | **Evolve to `levels[]`** as you specified; I'll migrate the seed + summary in the same phase to keep the build green |
| **D3** | New-field strategy: optional + resolver defaults (`settings`, `points`) vs required + factory default (`deliverableType`) | **Mixed as noted** — optional for metadata, required-with-default for `deliverableType` |
| **D4** | Confirm **no DB migration** (quiz/homework already in the `blocks.type` CHECK; content is jsonb) | **No migration** |
| **D5** | Phase 4 = scaffold DDL only, not applied; deferred behind persistence + enrollments | **Scaffold only**, build on later approval |

If D0–D5 look right (or tell me what to change), I'll start **Phase 1** and stop
again after it for review.
