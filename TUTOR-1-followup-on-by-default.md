# TUTOR-1 follow-up — Tutor ON BY DEFAULT (2026-08-06)

**Trigger (creator, in session):** the tutor "seems inconsistent… not able to see
it on a local test… make sure it is as consistent as possible, aligning with the
goals of being accessible from most/all relevant screens on the student end."
Decision (creator): **"it should be set as on by default."**

## Root cause (confirmed against the live DB)

The tutor mounted only for an enrolled, non-author learner on a course that had
BOTH (a) an explicit `tutor_course_settings.enabled = true` AND (b) an accepted
concept graph. Reaching that state took a hidden 4-step, per-course, creator-
driven chain (publish → extraction Inngest event → Accept the staged graph →
toggle Enable), and in local dev the extraction event **no-ops without
`INNGEST_EVENT_KEY`**. So `cs61b` (course `10b26d36…`) had **0 settings rows** and
**0 concept nodes** → `resolveTutorAccess` returned `disabled` for everyone, while
seeded fixture courses (which had both) showed the tutor — exactly the reported
"works on one account/course, missing on another."

The runtime already tolerates an empty concept graph (it grounds answers in the
published SNAPSHOT's lesson content; the graph only adds mastery scaffolding), so
default-on is safe without a graph.

## The contract — "ON BY DEFAULT"

> A course's tutor is ENABLED unless the creator explicitly turned it OFF.
> `effectiveEnabled = (no tutor_course_settings row) OR (row.enabled !== false)`.
> Enabling no longer requires a concept graph — the graph is a QUALITY
> enhancement (still auto-extracted on publish + buildable in the console), never
> a gate. UNCHANGED: author_preview, evidence gating, enrollment, cohort floors,
> escalation consent — `enabled` only controls whether the tutor MOUNTS.

## Changes (11 files + 1 migration; no schema table change)

- **Migration `20260806170000_tutor_on_by_default.sql`** — re-creates
  `tutor_console_bundle` with ONE change: the no-settings-row enablement default
  flips `false → true` (`v_enabled boolean := true`), so the console reflects
  default-on. Rest byte-identical. Applied live.
- **`lib/tutor/runtime/service.ts`** — `resolveTutorAccess`: only an explicit
  `settings.enabled === false` returns `disabled`; a missing row falls through to
  author/enrollment (default on). Author (2)/enrollment (3)/not_enrolled (4)
  untouched.
- **`lib/learn/tutorHome.ts`** — the /home rail filter now excludes only
  explicitly-disabled courses (was `.eq("enabled", true)`), and **fails OPEN** to
  default-on if the settings read errors (was fail-closed to `[]`).
- **`app/(app)/studio/[courseId]/tutor/actions.ts`** — `setTutorEnabledAction`
  drops the accepted-graph enable gate; `SetEnabledResult` loses its `needsGraph`
  member (confirmed: no non-console importer).
- **`components/studio/tutor/EnablementCard.tsx`** — the amber "Build the concept
  graph first" blocker is gone; the toggle is an opt-OUT switch (default On), and
  the graph line is reframed as an optional "adds mastery-aware guidance"
  enhancement with the Extract button kept as a non-blocking action.
- **`lib/studio/tutorConsole.ts`** — `hasAcceptedGraph` re-documented as a STATUS
  signal, not an enable gate (logic unchanged).
- **Tests** — `verify-tutor-home` (36), `verify-tutor-console` (25),
  `verify-tutor-route-int`, `verify-tutor-console-int` updated to the default-on
  contract (no-row ⇒ on; explicit false ⇒ disabled; enable-without-graph
  succeeds). Consolidation caught one stale int assertion ("a fresh course is
  DISABLED") the isolated agents missed → flipped to "ON BY DEFAULT".
- **Docs** — `docs/tutor/runbook.md` + `docs/tutor/architecture.md` updated
  (enable = opt-OUT; graph = quality enhancement, not a prerequisite).

## Discovery across student screens

- The learner sidebar mounts on the WHOLE course runtime (`/learn/[slug]` landing
  + every lesson) for enrolled learners — now on by default, so it's present on
  every published course.
- `/home` shows the tutor rail for all non-disabled enrolled courses.
- `/my-courses` launcher was deliberately SKIPPED: its course card is shared with
  the public `/marketplace` + `/explore`, so a tutor link there would leak the
  affordance publicly and risk nested-anchor hydration. Discovery is already
  covered by the runtime sidebar + /home rail + one-click from each card. A
  purpose-built standalone entry is the clean way to add it later if wanted.

## cs61b — grounded live

Ran the extraction core directly (no Inngest daemon) against the live cs61b
publication: **60 concept nodes, 47 edges, change-set accepted, 0 pending
reviews, 0 settings rows (= on by default)**, cost ≈ **$0.25** (a full 38-lesson
course). `henry.lai@berkeley.edu` is an enrolled non-author, so the tutor now
mounts + answers grounded with mastery scaffolding. (`propose_failed`/`grain_zero`
flags are expected for a fresh course with no learner analytics yet — non-fatal.)

## Gates (bare exit codes)

`tsc` **0** · `lint` **0** (1 pre-existing baseline warning) · `npm test` **0** ·
`verify:tutor:int` **0** (13 suites / 343 checks) · `build` **0** ·
`verify:budgets` **6/6** (`/studio/[courseId]/tutor` 234.9 KB;
`/learn/[slug]/[lessonId]` 216.3 KB — learner route unchanged).

## Invariants held

The privacy + no-auto-send invariants never depended on `enabled`; the pure
no-send-site grep + the full tutor int RLS matrices re-ran green. Default-on only
changes whether the tutor MOUNTS, not what evidence/identity is reachable.
