# HANDOFF — WiseSel

> **Refreshed 2026-06-28.** (Replaces a stale 2026-06-16 checkpoint that predated
> the live persistence + AI agent.) For the exhaustive architecture reference,
> read **`CLAUDE.md`**; for the dated change log, **`CHANGELOG.md`**. This file is
> the fast orientation. Most recent workstreams: **Course Structure agent** —
> accurate lesson/module editing (create/rename/move/delete a lesson, recreate a
> module in place, delete empty lessons), routed + HARD-validated so the agent
> can't mistake a structural request for slide generation, with a migration-backed,
> reviewable + reject-able structural change-set (2026-07-01; `npm run
> verify:course-agent`, 63 checks); and **Imported decks** — PPT/PPTX/PDF upload +
> rail viewer (2026-06-29). See CHANGELOG.md for both.

---

## 1. What the product is

**WiseSel** (formerly "CourseGen Pro") — an AI co-pilot for educators. Creators turn expertise into
engaging, monetizable courses; learners buy and study them. The heart of the
product is a **Google-Slides-like, AI-native course Studio**: a creator authors a
course (modules → lessons → blocks), and a docked, Cursor-style **AI Content
Agent** writes slide decks, knowledge checks, homework, and lecture text by
calling tools that mutate the course through the same validated patch pipeline
the UI uses — streaming its work and staging every change for review
(highlight → Accept/Reject).

- **Audiences:** creators (educators, competition coaches, SMEs, trainers) and learners.
- **Pricing:** Hobbyist (free) / Pro ($29) / Expert ($79); marketplace commission 15–25%.
- **Live today:** Supabase auth + persistence; the AI Content Agent (OpenAI,
  server-side); the structured slide editor; the AI visual pipeline (programmatic
  diagrams + generated textbook images).
- **Not built yet:** Stripe/marketplace, the marketing/analytics suites,
  multi-agent orchestration. Those in-app pages are presentational placeholders
  backed by `lib/data.ts` mock data.

**Document model:** `CourseDocument` → modules → lessons → **blocks** (8 block
types; slides are absolutely-positioned `SlideElement`s on a 1280×720 canvas plus
renderer-owned "structured layouts". The 8th, `imported_deck`, is an asset-backed
PPT/PDF deck shown in a rail viewer — NOT native editable slides). **Every** change — human or AI — flows
through one Zod-validated `CoursePatch` pipeline (`applyCoursePatch`, pure).

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16** (App Router, Turbopack), **React 19**, **TypeScript** |
| Styling | **Tailwind CSS v4** (CSS-first `@theme` in `app/globals.css`; **no** `tailwind.config`). NOT a shadcn project — primitives in `components/ui/`, `cn` from `@/lib/cn`. |
| State | **Zustand** (`lib/course/store.ts` = editor doc + undo; `lib/editor/*Store.ts` = UI/drag/agent) |
| Validation | **Zod** (schemas mirror the doc model; patches are a discriminated union) |
| Animation / icons | `framer-motion`, `lucide-react`; `@dnd-kit` for reordering |
| Backend | **Supabase** — Postgres (RLS) + Auth + Storage, via `@supabase/ssr` + `@supabase/supabase-js` |
| AI | **OpenAI** Responses API, server-only, behind a provider-agnostic `ModelClient` seam; `shiki` for code highlighting |
| Pkg / deps | npm; **14 runtime deps** (see `CLAUDE.md`). `undici` is a **dev** dep (proxy shim for live OpenAI on proxy-only machines). |

**Dev:** `npm run dev` (localhost:3000) · `npm run build` · `npm run lint`.
**Env (`.env.local`):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`OPENAI_API_KEY` (server-only); optional `OPENAI_MODEL` / `OPENAI_PROXY_URL` /
`OPENAI_IMAGE_MODEL` / … (see CLAUDE.md "AI Content Agent").

---

## 3. Architecture you need to know

- **Supabase project** `mfqolkzocxssgogcmhzf` · `https://mfqolkzocxssgogcmhzf.supabase.co`.
  Schema in `supabase/migrations/*`: `profiles` (auto-created on signup) +
  `courses → modules → lessons → blocks`, **RLS on everywhere** (author full CRUD;
  public read only when `status='published' AND visibility='public'`); block
  payloads live in `blocks.content` jsonb; `course-assets` storage bucket.
  Regenerate `lib/database.types.ts` after any migration.
- **Persistence = a whole-doc snapshot reconcile of normalized rows.** A
  module/lesson/block is a Postgres **row** (its id IS the primary key), never
  embedded JSONB. `lib/course/persistence.ts` maps doc ↔ rows (pure);
  `lib/course/persistenceSync.ts` `reconcileCourseDoc` upserts parents→children
  then deletes orphans children→parents. The browser autosave
  (`lib/editor/coursePersistence.ts`) and the server-side AI agent
  (`lib/ai/serverPersistence.ts`) share this one reconcile.
- **The AI agent** (`lib/ai/*`) is provider-agnostic: the OpenAI SDK lives in
  exactly one file (`lib/ai/providers/openai.ts`); `providers/mock.ts` is a
  deterministic client so the whole stack is testable **with no API key**.
  Pipeline: **PLAN → GENERATE → VALIDATE/REPAIR → (LIGHT REVIEW) → STAGE**, with
  per-phase model/effort config (`lib/ai/modelConfig.ts`). Tools are pure over
  `ctx.doc` → return `CoursePatch`es (`lib/ai/tools/*`). Changes stage as a
  reviewable **change-set** (`lib/ai/changeSet*.ts`); Reject replays inverse patches.
- **During an agent run**, the browser autosave is **paused** (`agentRunActive`),
  the agent persists server-side per batch, and the editor re-syncs live via
  `lib/editor/liveSync.ts` (`syncLiveDoc` replaces the in-memory doc) + a Supabase
  Realtime sub on `change_set_items`.
- **Verification convention:** no-key suites (`npm run verify:ai`, `verify:reject`,
  `verify:slides`, `verify:visuals`) use the mock provider; `npm run verify:ai:int`
  runs the full loop against **live Supabase** (still no OpenAI key — mock
  provider). Browser flows use temporary Playwright harnesses.

---

## 4. Most recent work — "deleted module resurrects during AI runs" (2026-06-28)

### Problem
After deleting a module and confirming, it **reappears a few seconds later**,
correlated with an AI agent run being (or recently having been) in flight.
Reject also "doesn't feel clean," and the UI showed two near-duplicate modules.

### Root cause (confirmed from code, not assumed)
`reconcileCourseDoc` is a **full-doc, last-write-wins, UNSCOPED** reconcile with
**no version guard** (no `revision` column). The agent loads its doc once at run
start and holds it across the whole run; its per-batch/terminal reconcile
**re-inserts and shields from deletion every module in that stale snapshot —
even ones it never touched**. `liveSync` then repaints the resurrected DB state.
Second timing: a delete made *during* a run can't persist (autosave paused) and
`liveSync` overwrites it. Separately, the block-only change-set diff means Reject
can't undo agent-created module/lesson scaffolds (the "not clean" + duplicate source).

### Decision (user)
Fix with a **scoped agent reconcile** (write only what the agent touched; never
orphan-delete modules). **No** version-column work now. **Defer** the Reject
structural defect and the duplicate cleanup.

### What changed
- **`lib/ai/changeSetDiff.ts`** — `agentTouchScope(baseline, current)` →
  `{ newModuleIds, touchedLessonIds, newLessonIds }`, derived by diffing the
  agent's run-start baseline vs its current doc (both in-memory → a concurrent
  human delete never appears, so "touched" is unambiguous).
- **`lib/course/persistenceSync.ts`** — new `reconcileCourseDocScoped(...)` beside
  the unchanged full reconcile. Upserts only the agent's created modules +
  authored lessons + their blocks; orphan-deletes only blocks within touched
  lessons and lessons within agent-created modules; **never** modules. Re-reads
  fresh DB for a **delete-wins** prune (a touched lesson whose module/itself the
  user deleted mid-run is skipped, not re-inserted), exempting agent-created new
  lessons. Skips the `courses` row.
- **`lib/ai/agentLoop.ts` + `serverPersistence.ts`** — `LoopContext.baselineDoc`
  (run-start anchor); `reconcileDoc` diffs against it → scoped reconcile (falls
  back to full reconcile only if unset, so persistence is never silently
  skipped). Set via `??=` in `runConversationLoop`.
- **`lib/ai/phases.ts`** — `runLessonPipeline` / `runGenerateModule` set
  `baselineDoc ??= startDoc`; the `{ ...c, lessonId }` spread propagates it, so all
  8 `reconcileDoc` call sites are covered with no signature changes.
- **`lib/editor/coursePersistence.ts` + `components/editor/deleteConfirm.tsx`** —
  companion for the during-run timing: `deleteModuleNow`/`deleteLessonNow` (direct
  scoped row delete, cascade), called from the confirm helpers **only when
  `agentRunActive`** so a delete reaches the DB before the next `liveSync`.
  In-memory delete + undo unchanged; best-effort (logs on failure).

### Verification
- `npx tsc --noEmit` clean · `npm run lint` clean for these changes (one
  pre-existing `validation.ts` unused-var **warning** from an earlier aux
  workstream, untouched).
- `npm run verify:ai` **green** — incl. new no-key **`scripts/verify-scoped-reconcile.ts`**
  (28 checks, in-memory Supabase fake): resurrection guard (out-of-scope deleted
  module never upserted nor orphan-deleted), new-module write, lesson-level
  delete-wins, scoped block prune.
- `npm run verify:reject` **green** (17; Reject path unchanged).
- **Not run** (per instruction — no live tests without asking): `verify:ai:int`.
  A type-checked `# Resurrection guard` scenario was **added** to
  `scripts/verify-agent-integration.ts`, ready to run.

### Git note
A checkpoint hook **auto-committed and pushed** this work as `84e8b75` on
`feat/assessments` mid-session (no manual `git commit`/`push` was run). That commit
also folded in the prior session's then-uncommitted aux/image-quality edits. Two
trailing files (`package.json`, the final `verify-agent-integration.ts` edits)
remain uncommitted locally. Published history was intentionally **not** rewritten.

---

## 5. Deferred / suggested next steps
1. **Reject structural revert** — extend the change-set/revert (or stage module &
   lesson creation into the change-set) so Reject fully undoes an agent run. This
   is the "Reject doesn't feel clean" defect and a duplicate-module source.
2. **Optimistic-concurrency guard** — a `revision` column + compare-and-set (needs
   an RPC/transaction since the reconcile is multi-statement) to close the general
   last-write-wins class across autosave/agent/reject. Pairs with the scoped
   reconcile already shipped.
3. **One-off cleanup** of the existing duplicate modules in the affected course.
4. Run `verify:ai:int` (incl. the new resurrection-guard scenario) against live Supabase.
5. Larger roadmap (from `CLAUDE.md`): real course list/picker on the dashboard
   (currently shows mock courses), image upload → storage, Stripe + marketplace,
   the marketing/analytics suites, PPTX export.

---

## 6. Gotchas (evergreen — keep)
- **Set `course_id` on lessons & blocks on insert** — it's denormalized for RLS
  and not derivable by the DB.
- `order` is a SQL reserved word — quoted as `"order"` in migrations; fine as
  `order` in TS.
- Money is integer **cents** everywhere (`price_cents`).
- RLS helper functions live in a non-exposed `private` schema — reference qualified.
- Persistence is whole-doc snapshot upsert + orphan-delete; ids ARE the row PKs,
  so there's no diffing — BUT it's last-write-wins with no version guard (see §4).
- No `Math.random()` / `Date.now()` in React render (hydration); none in workflow
  scripts either.

## 7. Quick reference
- **Run:** `npm run dev` → http://localhost:3000 (sign in at `/login`, Studio at `/studio`).
- **No-key tests:** `npm run verify:ai && npm run verify:reject && npm run verify:slides`.
- **Live tests (ask first):** `npm run verify:ai:int`.
- **Type/lint:** `npx tsc --noEmit` · `npm run lint`.
- **Deep docs:** `CLAUDE.md` (architecture, AI pipeline, design system, Supabase
  schema) · `CHANGELOG.md` (dated change log) · `DESIGN_ASSESSMENTS.md` (quiz/homework).
