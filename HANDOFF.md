# WiseSel — Handoff / Checkpoint

> **Snapshot date:** 2026-06-16
> A resume-from-here checkpoint. For the exhaustive front-end architecture, see
> `CLAUDE.md`. **Backend is LIVE:** Supabase auth + course persistence (since
> 2026-06-13), and as of 2026-06-15 the **first real AI** — a Cursor-style
> Content Agent docked beside the lesson editor, backed by the OpenAI Responses
> API server-side (`lib/ai/*`), with change-set review (highlight → Accept/Reject)
> and conversation persistence. Set `OPENAI_API_KEY` in `.env.local` to enable
> it. **2026-06-16:** the slide system gained a richer vocabulary — a sticker
> primitive library, tokenized font sizes (+ Fraunces `display` family), **seven**
> renderer-owned **structured layouts** (process / key-concept / metrics /
> code-walkthrough, plus section-break / concept→example / outline-list, all with
> STRICT length-enforced content schemas + a renderer-owned, AI-invisible `decor`
> flair knob), AI tools that use them, and an **atomic** Reject (see CHANGELOG).
> The content agent is now a **phased pipeline** (PLAN → GENERATE → CRITIQUE,
> one agent, per-call reasoning effort) auto-routed 3 ways by an intent classifier
> — `generate_module` (module plan → generate every lesson, no critique),
> `generate_lesson` (plan → generate → critique), and `edit` (fast single-turn,
> now layered). PLAN surfaces an approvable plan in a prominent modal and the
> sidebar shows the live phase (see CHANGELOG 2026-06-16). **2026-06-17:** fixed
> the PLAN structured-output path — for a reasoning + json_schema response
> `final.output_text` is empty, so the provider reads the message parts directly
> (`messageTextFromOutput`); plus a bigger PLAN token budget + a bounds-relaxed,
> clamping outline parse (strict mode strips min/max). **2026-06-17 (GENERATE
> quality):** model → gpt-5.5; PLAN decomposes into building sub-steps + a
> per-slide `keyPoints` content brief; GENERATE is bound to the planned STRUCTURED
> layout (structured-only toolset, no flat `write_slide_deck` → no tip-box
> downgrade) with a depth floor (ban skeletal slides); new first-class `prose`
> layout (8 structured total); CRITIQUE enforces it on single-lesson builds.
> **2026-06-17 (A/B/C):** model is per-call (PLAN/CRITIQUE gpt-5.5, GENERATE/
> classifier gpt-5.4-mini); the static system+tools prefix now caches (~98% —
> variable context moved to a leading `input` message); Reject suspends+aborts
> autosave (no race / "Failed to fetch") and autosave auto-retries transient
> failures. Personal-project
> status tracking also lives in the Obsidian vault at
> `Personal/Projects/WiseSel/` (`Supabase Backend.md`, `Log.md`, `PRD.md`).

---

## 1. What WiseSel is (one paragraph)
An AI co-pilot for educators: creators turn expertise into courses in a
Google-Slides-like AI-native studio, then market / analyze / export / sell them;
learners buy and study them. Audiences = creators + learners. Tiers = Hobbyist
(free) / Pro ($29) / Expert ($79); marketplace commission 15–25%.

## 2. Stack
Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS v4
(CSS-first via `@theme` in `app/globals.css`, no `tailwind.config.*`) ·
framer-motion · lucide-react · zustand · zod · @dnd-kit. **npm.**
Dev: `npm run dev` · `npm run build` · `npm run lint` (all green at checkpoint).
**Not a shadcn project** — primitives in `components/ui/`, `cn` from `@/lib/cn`.

---

## 3. Current state at a glance

| Area | State |
|---|---|
| Marketing intro (`/`), educator landing (`/educators`) | ✅ Built (mock) |
| In-app dashboard / analytics / marketplace / settings / exports | ✅ Built (mock data in `lib/data.ts`) |
| Creator Studio editor (`/studio`) — V3 slide editor | ✅ Built, functional, mock LLM |
| Quiz & homework assessment editors | ✅ **Built + verified 2026-06-14** (see `DESIGN_ASSESSMENTS.md`) |
| **Supabase backend (schema)** | ✅ **Provisioned 2026-06-13 (NEW)** |
| Supabase ↔ app wiring (client, auth, persistence) | ❌ **Not started** |
| Real LLM, Stripe, marketplace/learner tables | ❌ Deferred |

Everything user-facing is still front-end skeleton on **mock data**. The
database now exists but **nothing in the app talks to it yet** and there are
**0 users**.

---

## 4. The backend (provisioned this session)

**Project:** `mfqolkzocxssgogcmhzf` ·
URL `https://mfqolkzocxssgogcmhzf.supabase.co` ·
[Dashboard](https://supabase.com/dashboard/project/mfqolkzocxssgogcmhzf)

**Applied as two migrations** (in repo at `supabase/migrations/`, also recorded
in Supabase's migration history):
- `20260613000000_core_authoring_schema.sql`
- `20260613000100_harden_rls_and_advisors.sql`

### Schema (`public`, all RLS-enabled)
- **profiles** — bridges `auth.users` (`id` FK); `display_name`, `avatar_url`,
  `plan` (hobbyist|pro|expert). Auto-created on signup by the `handle_new_user`
  trigger.
- **courses** — `author_id` → `auth.users`; title/description/audience/level,
  `status` (draft|published|archived), `visibility` (private|unlisted|public),
  `price_cents` (integer cents), `tags[]`, `theme` jsonb. Metadata denormalized
  so listings don't load content.
- **modules** — `course_id`, title, description, `order`.
- **lessons** — `module_id` + `course_id` (denormalized for RLS), title,
  objective, `order`, estimated_minutes.
- **blocks** — `lesson_id` + `course_id`, `type` (7 block types), title,
  `order`, **`content` jsonb** (slide decks / quizzes / lectures live here).

### Security / multi-tenancy model
- Auth = Supabase Auth (`auth.users`); we never store passwords.
- **RLS on every table, secure by default.** Author = full CRUD on own rows;
  public can read only `status='published' AND visibility='public'` courses
  (and their modules/lessons/blocks); all else denied at the DB.
- Two `SECURITY DEFINER` helpers — `is_course_author()` (write gate),
  `can_read_course()` (read gate) — live in a **non-exposed `private` schema**
  (not reachable via REST).
- **Advisors: security = 0 lints.** Performance = only "unused index" INFO
  (expected with no rows).

### Storage
- **course-assets** bucket — public read by URL; writes scoped to each user's
  own `{uid}/…` folder. Swap target for the editor's current objectURL uploads.

### Decisions locked this session
- Content storage = **normalized rows + blocks-as-jsonb** (not one big blob).
- First migration scope = **core authoring only**; learner/marketplace tables
  (`enrollments`, `reviews`, `purchases` + Stripe) **deferred to Phase 2** — the
  `courses.status/visibility/price_cents` columns already exist so they slot in
  without reshaping.

---

## 4b. Quiz & homework assessments (2026-06-14)

Enriched the (already-existing) `quiz`/`homework` block types into gradable
artifacts — **no DB migration needed** (both were already valid `blocks.type`
values; the richer data lives in `blocks.content` jsonb, validated by Zod).
Full design + decisions in `DESIGN_ASSESSMENTS.md`.

- **Model/schema** (`lib/course/types.ts`, `schemas.ts`): quiz `settings`,
  `multi_select` questions, per-question `points` + objective link, short-answer
  accepted answers; homework `deliverableType`/`dueAt`/`points`/`estimatedMinutes`;
  rubric evolved flat-points → leveled criteria. Helpers in
  `lib/course/assessments.ts`.
- **Operations** (`patches.ts`, `commands.ts`, `manifest.ts`): 11 new patches
  (quiz settings/delete/reorder; homework meta; full rubric CRUD+reorder) on the
  one validated `apply` path. AI tool surface in `lib/course/ai/assessmentTools.ts`
  (`create_quiz_block`, `set_rubric`, `get_course_context`, …) — **defined, not
  wired to the model yet.**
- **Builder UIs** (`components/editor/blocks/`): rewritten `QuizEditor` +
  `QuestionCard`, `HomeworkEditor` + `ExerciseCard`, new `RubricEditor`, shared
  `controls.tsx`; dnd-kit reordering throughout. Verified 15/15 via Playwright.
- **Runtime (Phase 4) — SCAFFOLD, NOT APPLIED:**
  `supabase/drafts/assessment_runtime.sql` (attempts/responses/submissions/grades
  + RLS + auto-grading design). Gated on block persistence + `enrollments`; kept
  out of `migrations/` on purpose.

## 5. Repo deltas at this checkpoint (all UNCOMMITTED / untracked)
- `supabase/migrations/20260613000000_core_authoring_schema.sql`
- `supabase/migrations/20260613000100_harden_rls_and_advisors.sql`
- `lib/database.types.ts` — generated DB types (regenerate after every migration)
- `HANDOFF.md` (this file)

> Nothing has been committed. Suggested commit when ready:
> `feat: supabase core authoring schema, RLS, storage + generated types`

---

## 6. How to operate the backend
- **Apply a migration:** Supabase MCP `apply_migration` (the MCP must be added
  with `read_only=false` — it's currently in write mode), **or**
  `supabase db push` against `supabase/migrations/`.
- **Regenerate types after a migration:** MCP `generate_typescript_types`, or
  `supabase gen types typescript --project-id mfqolkzocxssgogcmhzf > lib/database.types.ts`.
- **Re-check health after DDL:** MCP `get_advisors` (security + performance).
- ⚠️ The MCP is in **write mode** right now. Flip back to `read_only=true`
  (needs a `/mcp` re-auth) when you want the safety default.

---

## 7. Next steps to continue (in order)
1. **Install client:** `npm i @supabase/supabase-js`; add a typed client
   (`lib/supabase/client.ts` + server helper) using `lib/database.types.ts`;
   put URL + anon key in `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
2. **Auth UI:** login / signup / session + a route guard for the `(app)` group.
   First real user → exercises RLS end-to-end. Replace the `currentUser` mock in
   `lib/data.ts` with the signed-in profile.
3. **Persistence layer:** map the in-memory `CourseDocument`
   (`lib/course/types.ts`) ↔ courses/modules/lessons/blocks rows. The editor
   store (`lib/course/store.ts`) currently writes to Zustand/localStorage only.
   ⚠️ **Set `course_id` on lessons & blocks on insert** — it's denormalized for
   RLS and not derivable by the DB.
4. **Images:** switch editor uploads from objectURLs to the `course-assets`
   bucket (swap point is marked in the slide image code).
5. **Then:** real LLM behind `lib/course/ai/mockClient.ts`; later Phase 2
   (marketplace/learner tables + Stripe).

## 8. Gotchas to remember
- `level` is free text (studio uses beginner/intermediate/advanced; marketplace
  mock uses Silver/Gold) — decide on a strict enum later if needed.
- `order` is a reserved word — quoted as `"order"` in SQL; fine as `order` in TS.
- Money is integer **cents** everywhere (`price_cents`).
- RLS helpers are in schema `private`, not `public` — reference them qualified.
- `CLAUDE.md` still says "no backend" in places; update it (or rely on this doc +
  the Obsidian `Supabase Backend.md`) before the next session.
