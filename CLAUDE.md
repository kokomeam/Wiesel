# CLAUDE.md — WiseSel (handoff)

> **Naming (2026-07-02):** the product/brand was renamed **CourseGen Pro → WiseSel**
> (logo assets in `public/brand/`, placed via `components/brand/WiseSelLogo.tsx`).
> The GitHub repo slug (`kokomeam/coursegen-pro`) and the Obsidian vault folder
> (`Personal/Projects/CourseGen Pro/`) are unchanged infra/filesystem names — keep
> those literal where they appear. Everywhere else, the product is WiseSel.

> **Obsidian scoping note:** This is a **personal project**, separate from the
> internship. Its vault notes live under `Personal/Projects/WiseSel/`
> (`PRD.md` / `References/` / `Log.md`). NEVER write to `Work/`, `Work/Daily Logs/`,
> or the weekly reports, and don't let this project appear in them. Treat any
> auto-loaded `<obsidian-context>` (Ethereum / Speedrun / Oria intern work) as
> unrelated background.

## What this product is

**WiseSel** — an AI co-pilot for educators. Creators turn expertise into
engaging, monetizable courses (multi-agent studio: Curriculum Architect →
Content Producer → "Magic Wand" iterative editor), then market them (AI landing
pages / emails / social kits), analyze them (drop-off insights, feedback
summaries), export them (PPTX / PDF / SCORM), and sell them on a marketplace.
Learners buy and study those courses. Full PRD lives in the first user message
of the original session; key points:

- **Audiences:** creators (educators, competition coaches — USACO/FBLA, SMEs,
  trainers) and learners.
- **Pricing tiers:** Hobbyist (free) / Pro ($29, current user's tier) /
  Expert ($79); marketplace takes 15–25% commission.
- **Roadmap phases:** 1 Core Studio → 2 Marketplace+Stripe → 3 Marketing suite
  → 4 Analytics engine → 5 Multi-modal (video/avatars).
- **Backend status (2026-06-15):** Supabase **auth + persistence are LIVE**
  (email/password login, RLS-secured `courses → modules → lessons → blocks`
  schema, course-assets storage bucket). The **first real AI is LIVE** too: a
  Cursor-style **Content Agent** docked beside the lesson editor, backed by the
  **OpenAI Responses API server-side** (`lib/ai/*`). Still NOT built: Stripe;
  the marketing/analytics/marketplace suites; multi-agent orchestration.

The **Studio is now a real, persisted authoring app**: it loads your course
from Postgres (or auto-creates an empty one), autosaves every edit, and is
gated behind sign-in. The **docked AI agent** authors slide decks, knowledge
checks, homework, and lecture text by calling tools that mutate the course
through the SAME validated CoursePatch pipeline the UI uses, streams its work,
and stages every change for review (highlight → Accept/Reject). **Publishing
(M1) and the student runtime + real marketplace (M2) are LIVE** — see their
sections below. The **remaining in-app pages** (dashboard, analytics, exports,
marketing, settings) are still **presentational placeholders backed by
`lib/data.ts` mock data**. The legacy inline command bar (`AICommandBar` →
`requestAIPatches` in `lib/course/ai/mockClient.ts`) remains a deterministic
mock and is secondary to the real agent panel; Export buttons remain
non-functional (Publish is real).

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · **Tailwind CSS v4**
(CSS-first config via `@theme` in `app/globals.css` — there is no
`tailwind.config.*`) · `framer-motion` · `lucide-react` · **`@supabase/ssr` +
`@supabase/supabase-js`** (auth + Postgres). npm. **Git repo on GitHub
(private, `kokomeam/coursegen-pro`, default branch `main`).** Dev:
`npm run dev` (localhost:3000) · `npm run build` · `npm run lint` (all
currently green/clean). Supabase creds live in `.env.local`
(`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`).

**This is NOT a shadcn project.** No `components.json`, no `@/lib/utils`, no
cva/radix Button. When asked to "integrate a shadcn component," adapt the
technique to the existing primitives instead of copy-pasting its scaffolding:
use `cn` from `@/lib/cn`, the existing `Button` in `components/ui/Button.tsx`,
and put reusable primitives in `components/ui/`.

## Route map

- `/` — **dual-audience product introduction** (2026-06-12, route group
  `app/(marketing)/`, components in `components/intro/`). Its OWN visual
  identity per user request (iterated twice): **warm paper `#FAF7F1` + stone
  ink + amber→orange gradient accent** — light-first (user rejected the
  earlier dark/"too technical" hero AND the original purple), **no sparkle-AI
  imagery**; Fraunces serif display (`components/intro/fonts.ts`,
  `--font-display`) + Geist Mono eyebrows; hand-drawn SVG annotation strokes
  (`Annotate.tsx`) as the brand motif; emerald only for success semantics.
  `WarmBackdrop.tsx` = the atmosphere: HalftoneDrift + SunriseGlow +
  DoodleField (`backgrounds.tsx`) + a **cursor-following warm glow**
  (fine-pointer + reduced-motion gated) + grain — NO BackgroundPaths here. Hero has a learn/teach toggle driving two
  looping primitive-built demos (`HeroDemo.tsx`, deterministic step timelines,
  inView + reduced-motion gated). "For educators" card/links route to
  `/educators`. Final CTA = big orange-gradient panel with RippleArcs.
- `/educators` — the original educator landing's **structure and elements
  preserved** (RotatingText word-swap hero, BackgroundPaths lines, HeroPreview
  self-assembling demo, full section lineup) but **re-skinned to the warm
  orange identity** (components/marketing/* recolored violet→orange, serif
  headings, mono eyebrows, the `WiseSel` logo (`components/brand/WiseSelLogo.tsx`)
  replacing the Sparkles tile, pill buttons; student-path accents sky→teal). Its nav links
  collapse to the hamburger below `lg` (the mono links don't fit at md).
  `components/ui/background-paths.tsx` default tint is now `text-orange-400`.
- `/dashboard` — creator dashboard (moved here from `/` when the landing took root)
- `/studio` — Creator Studio, the core. Rebuilt (June 2026) as a **fully
  functional AI-native course editor**, then upgraded (V2, 2026-06-12) into a
  **Google-Slides-like authoring surface**: slides are a 1280×720 logical
  canvas of absolutely positioned elements (9 types incl. image/shape/callout/
  divider/table) with drag/resize/keyboard interactions, a grouped slide
  toolbar (Insert · Text · Layout/Background/Theme · Arrange · AI), 14
  placeholder-based layouts + user-saved custom layouts, 5 themes (defaults
  that never clobber explicit styles), solid/gradient/image backgrounds,
  required-alt image upload (object URLs; Supabase swap point marked), a
  10-check quality linter with one-click fixes, collapsible panels everywhere
  (app sidebar → icon rail, outline/inspector → labeled rails, AI bar →
  sparkle FAB, filmstrip → pill; localStorage via `lib/editor/uiStore.ts`),
  focus mode, and shortcuts (⌘\\ panels, ⌘. inspector, ⌘K AI bar, ⌘Z/⇧⌘Z
  undo/redo, ⌘C/V slide copy-paste, arrows/Delete/⌘D on elements). Every
  change — human or AI — still flows through one Zod-validated patch pipeline.
  The mock LLM lives behind a single seam: `lib/course/ai/mockClient.ts`.
  **V3 "professional editor" upgrade (2026-06-12, Part A — see CHANGELOG.md,
  46-check browser suite):** text alignment fixed (toolbar sets
  `style.textAlign`/`verticalAlign` incl. justify; the BOX moves only via the
  Arrange menu); shape picker (rect/rounded/ellipse/triangle/line/arrow +
  stroke color/width/style); smart guides + snapping (6 *screen*-px threshold
  through the stage scale, ⌘/Alt bypass); Shift aspect-lock; element
  clipboard (⌘C/X/V, re-id + remap group ids); right-click context menu;
  marquee + shift-click multi-select with Google-Slides deferred collapse;
  **nested groups** (`groupPath: string[]` on elements, ⌘G/⇧⌘G,
  dblclick-descend / Esc-ascend scope ladder, `lib/course/slide/groups.ts`);
  multi-selection bbox transform (proportional member scaling, min floors);
  align-to-selection + distribute H/V on whole UNITS (`slide/arrange.ts`);
  drop-shadow presets over an expressive `style.shadow` model; text boxes
  **auto-grow on commit** (hidden-twin measurement, grow-only, one undo for
  text+height via `commitElementTextPatches`).
  **Part C (approved AUDIT.md items, 34-check suite — skipped: #1
  persistence [Supabase next], #5 multi-select styling, #8 canvas a11y):**
  right-click no longer collapses multi-selections (gesture starts gated to
  the primary button); multi z-order keeps internal stacking; marquee/⌘A
  respect the entered-group scope; GS paste placement (cross-slide in
  place, same-slide +24, context-menu paste at cursor via `canvasPoint`);
  rotation stripped from the element SCHEMA (axis-aligned chrome can't lie;
  TS field + render kept for legacy); thumbnails memoized via WeakMap-cached
  JSON (reducer deep-clones, identity memo can't work); undo cap 100
  (measured: seed 24 KB; inverse patches post-Supabase);
  **text reflow everywhere** — style/resize commits grow text boxes
  (grow-only, user policy: never shrink text) + `TEXT_CLIPPED` lint with
  grow fix (measurer = `renderToStaticMarkup` — flushSync is illegal during
  render — registered into lint by the shell; seed slide 3 trips 6 checks
  now); **zoom 50–300%** (⌘+/⌘−/⌘0, scroll-pan, center-stable; pointer math
  reads the scaled stage's own rect); **OS clipboard** (`lib/editor/
  clipboard.ts`: markered JSON mirror, paste survives reload/tabs, plain
  text pastes as a text element, ONE-thing clipboard exclusivity);
  **equal-gap snapping + px chips** (`snap.ts` lane detection,
  `GuideLine.label`); **2-point lines** (`points` frame-fractions +
  `SET_LINE_ENDPOINTS` padded-AABB reducer, endpoint handles, Shift=45°,
  marker arrowheads; AABB hit-test + connectors deferred); **rich text
  runs** (`runs: TextRun[]` with tri-state marks, invariant concat(runs)===
  text so lint/AI read plain text unchanged; contenteditable overlay +
  execCommand isolated in `elements/richText.ts`; toolbar/swatches
  preventDefault-on-pointerdown to preserve the live selection; bullets/
  links/selection-aware button states = known cuts).
  **DB persistence + authoring UX (2026-06-15, see CHANGELOG.md):** the
  studio is now a **server component** (`app/(app)/studio/page.tsx`) that
  loads the signed-in author's most-recent course from Postgres (or
  auto-creates an empty one), reconstructs the `CourseDocument`, and hands
  it to `StudioLoader` which hydrates the store (effect-gated skeleton →
  no SSR mismatch). **Autosave** (`lib/editor/coursePersistence.ts`) debounce-
  reconciles the whole doc to the DB on every edit (header shows live
  Saving/Saved). **No more seed** — a brand-new course is genuinely empty.
  **Module page** (`ModulePage.tsx`): clicking a module in the outline opens
  a clean overview — editable name, description, lesson list, prominent
  "Add lesson" (creates + opens the lesson). **"Module N:" convention**
  (`lib/course/moduleLabel.ts`): modules always display as `Module {n}:
  {name}` (n = 1-based position, auto-renumbers on reorder; only the name is
  stored/edited). **Pencil edit-affordance** (`EditableName.tsx`): a faint
  pencil sits next to editable names (course/lesson/module titles) on hover
  and hides while editing; the input auto-sizes to content so the pencil
  hugs the text. Module/lesson/block ids are now **real UUIDs** (= the DB
  primary keys); the AI-Credits widget and `currentUser.credits` mock were
  removed. **15-check browser suite** drove the whole flow against live
  Supabase (sign in → empty course → module page → add lesson → rename →
  persist across reload).
- `/api/ai/component-manifest` — JSON manifest of component types + allowed
  patch actions for AI agents.
- `/marketplace` — REAL since Milestone 2: live public publications + the
  caller's "My learning" (one tab); cards open `/learn/{slug}`.
- `/learn/[slug]` + `/learn/[slug]/[lessonId]` — the PUBLIC learner runtime
  (route group `app/(learn)/`, own minimal shell) — see the Student learning
  runtime section.
- `/marketing`, `/analytics`, `/exports`, `/settings` — in-app placeholder
  pages under `app/(app)/` sharing the Sidebar+Topbar shell in `app/(app)/layout.tsx`.
- `/login` — email/password auth (Supabase); honors `?redirectTo=`.
  `app/(app)/layout.tsx` + `lib/supabase/middleware.ts` redirect signed-out
  visitors here (`/learn/*` stays public).

## Supabase (auth + persistence)

- **Schema:** `supabase/migrations/*` — `profiles` (auto-created on signup) +
  `courses → modules → lessons → blocks`, RLS-on everywhere (author full CRUD;
  public read only when published+public), `course-assets` storage bucket.
  Block payloads (slides[], questions[], …) live in `blocks.content` jsonb;
  course `plan`/`theme` are jsonb columns. Applied to the live project; regen
  types into `lib/database.types.ts` after any migration.
- **Clients:** `lib/supabase/{client,server,middleware}.ts` (browser /
  server-component / middleware, `@supabase/ssr`, cookie-shared sessions).
- **Doc ↔ rows:** `lib/course/persistence.ts` (PURE `courseDocFromRows` /
  `courseDocToRows`; module/lesson/block ids ARE the row primary keys, so the
  map is 1:1, lossless — verified by an 11-check round-trip). Studio load is
  server-side; autosave (`lib/editor/coursePersistence.ts`) is a debounced
  full-snapshot reconcile via the browser client (upsert parents→children,
  delete orphans children→parents), surfaced through the store's `saveStatus`.
  Store init = `PLACEHOLDER_COURSE` (deterministic, hydration-safe) until
  `store.hydrate(doc, courseId)` installs the loaded course.
  **Reject-aware autosave (2026-06-17):** the flush carries an `AbortController`
  (`reconcileCourseDoc(…, signal)`); Reject calls `suspendAutosaveForReject()` to
  pause + abort the in-flight flush BEFORE its revert, and `hydrate` resumes +
  skips re-saving the reverted doc (so a stale flush can't clobber the revert /
  trip "Failed to fetch"). Autosave failures auto-retry (2× backoff) before
  `saveStatus("error")`.

## Publishing — immutable snapshots (Milestone 1, 2026-07-02)

Courses go live as **immutable, versioned snapshots**; the draft stays freely
editable and learners never see it. Everything lives in `lib/course/publish/*`
(Zod-first — types INFERRED from schemas, unlike lib/course/schemas.ts).

- **Tables (migration `20260702020000` + `20260702020100`):**
  `course_publications` (course_id + `version` unique; `slug` + `previous_slugs`
  [redirect-safe renames]; `snapshot` jsonb; `visibility` public|unlisted; `status`
  live|unpublished; `content_hash`; `linter_report`; partial unique indexes = ONE
  live row per course AND per slug) · `quiz_answer_keys` (PK publication_id+block_id;
  **RLS enabled, ZERO policies — server-only**, not even the author's client can
  read it; grading will use the service role) · `enrollments` (course-level, unique
  (course_id,user_id), status active|dropped|completed + `comms_opt_out`; student
  owns the row, owner reads; insert requires `private.has_live_publication`).
  **Immutability is enforced in the DB**: a BEFORE UPDATE trigger rejects any change
  to snapshot/version/hash/report/published_at/created_by (status/visibility/slug
  stay mutable). There is **NO insert policy** — the only writer is the SECURITY
  DEFINER **`publish_course` RPC** (the one transaction: verify author → lock course
  row → bump version → retire previous live → insert publication + keys → mirror
  `courses.status`). `courses.visibility` deliberately stays `private` so the OLD
  published+public draft-table read path never opens; students read snapshots only.
- **Snapshot invariants:** node ids (module/lesson/block/slide/question) are the
  draft row ids, preserved verbatim — progress/analytics/agent evidence stay
  joinable across versions. Quiz `correctChoiceId(s)`/`correctAnswer`/
  `expectedAnswer`/`acceptedAnswers`/`explanation` are STRIPPED into the keys table;
  the published-quiz Zod schema is **strict** (an unstripped question fails parse)
  and `findAnswerKeyLeaks` deep-scans before every publish. No volatile metadata in
  the snapshot; `content_hash` = WebCrypto sha256 over sorted-key
  {snapshot, answerKeys} (`hash.ts` is isomorphic — the studio computes the SAME
  hash client-side for the live "unpublished draft changes" chip).
- **Pre-flight (`preflight.ts`, pure):** ERRORS block (untitled, no content,
  ungradable quiz question); WARNINGS are overridable with an explicit
  acknowledgement (empty module/lesson/quiz, pending/failed AI images, unprocessed
  imported decks / videos, per-slide `lintSlide` findings as `SLIDE_*`). The report
  persists to `linter_report` at publish time.
- **Flow:** `/api/publish` (GET status+preflight+diff · POST publish · PATCH
  unpublish/restore/set_slug/set_visibility) on the user-scoped client; service
  layer = `service.ts` (shared with the integration test). Republish inherits the
  slug and bumps the version; an IDENTICAL republish (same hash) is a no-op, not a
  version bump. Slug: first publish slugifies the title + suffixes against live
  slugs ("one live publication per slug" — deliberately NOT a globally-unique
  column, so v2 can reuse v1's slug); renames append to `previous_slugs`. Studio UI
  = `PublishPanel` (real since M1) + the header Publish button opens it.
- **Tests:** `npm run verify:publish` (59 pure — slug/hash/snapshot-strip/preflight/
  diff) and `npm run verify:publish:int` (50 vs live Supabase — the full RLS matrix
  incl. answer-key invisibility for every client role, DB immutability, draft-edit
  independence [byte-for-byte], version retirement, unlisted link-possession,
  enrollment gating, slug collision/rename/redirect).
- **Not yet (later milestones):** analytics events (every event will carry
  publication_id + version), rollups, dashboards, maintenance agent. (The
  `/learn/*` runtime + server-side grading shipped in Milestone 2 — next
  section.)

## Student learning runtime — `/learn/*` (Milestone 2, 2026-07-02)

Learners consume LIVE snapshots only; everything server-trusted. Core =
`lib/learn/*` (Zod-first) + `app/(learn)/learn/[slug]{,/[lessonId]}` +
`app/api/learn/*`.

- **Tables (migrations `20260702030000` + `030100` + `040000`):** `learn_progress`
  (unique (user,course,lesson); server-computed `status`/`pct` + `progress_state`
  jsonb {viewedSlides, videoPct, viewedBlocks, markedComplete}; **RLS: select
  own-or-author, ZERO client write policies** — /api/learn/progress with the
  service role is the only writer, using **optimistic locking** (updated_at guard
  + retry-merge; a plain upsert lost concurrent slide reports) while the client
  serializes its POSTs) · `quiz_attempts`/`question_responses` (M3's exact column
  contract + denormalized course_id; `question_id` is TEXT — question ids are
  jsonb short ids, not row UUIDs; student reads own, author reads, **no client
  inserts**; attempt_number is per (user, block) ACROSS versions, unique-indexed,
  max+1 with one retry; only ANSWERED questions get response rows) ·
  `homework_submissions` (student INSERTs under RLS [own user_id +
  `private.is_enrolled` + publication∈course]; a BEFORE UPDATE trigger makes
  review `status` the only mutable column — author can't rewrite content, student
  can't self-review; files go to course-assets under the student's own
  `{uid}/homework/…` via the EXISTING per-user storage policies) · definer read
  RPCs `marketplace_listings()` + `my_learning()` (jsonb count aggregation,
  authenticated-only, card metadata never snapshots).
- **Grading** (`lib/learn/grading.ts`, pure; orchestrated by `quizService.ts`):
  the ONLY place responses meet `quiz_answer_keys` (admin client). mc = id equal;
  ms = exact SET equality; tf = boolean; sa = trim/lowercase/collapse-whitespace
  match vs expected+accepted. Kind mismatch = answered-but-wrong; unanswered =
  wrong; unknown ids ignored; maxScore = key count. Returns correctness +
  authored explanations, **never the correct answer**. Author submits = graded
  PREVIEW, nothing recorded. "Grade what they saw": the publication is fetched
  by id (admin) so a mid-session republish doesn't break submission; access is
  checked against the COURSE.
- **Completion rule** (`lib/learn/completion.ts`, pure, fixed + documented):
  complete = all slides of every deck viewed + every imported deck paged to the
  end + every video ≥90% + every quiz ≥1 attempt. Unready media (video/deck not
  "ready" in the snapshot) and empty decks/quizzes are NOT trackable — a broken
  asset can never strand a lesson. No trackables ⇒ explicit "Mark complete"
  (server rejects it for trackable lessons). Slide/viewed sets are INTERSECTED
  with the snapshot. Course complete = every lesson ⇒ enrollment flips to
  `completed` (upgrade-only; republish never downgrades). pct = mean of unit
  fractions, capped at 99 until truly complete.
- **Pages:** new PUBLIC route group `app/(learn)/` (own minimal shell; middleware
  leaves /learn open; unauth lesson access bounces to `/login?redirectTo=…`).
  Landing = outline + enroll CTA (`EnrollButton` → /api/learn/enroll, RLS does
  the gating) + progress/Continue (`lib/learn/summary.ts` — note: for enrolled
  users `summary.continueLessonId` is authoritative; null means DONE, don't
  fall back to lesson 1) + author-preview card; renamed slugs redirect via
  `previous_slugs`; unknown-vs-unlisted-anon share the 404 (indistinguishable by
  design). Player renders every block READ-ONLY (`components/learn/*`):
  **SlideStage `mode="thumbnail"`** (the existing read-only path — global
  zustand store, no provider needed), `VideoPreviewPlayer` (pure; captions
  overlay; new ADDITIVE `onProgressPct` prop reports window-relative position),
  a learner deck viewer over `/api/learn/deck/[id]` (admin-signed page URLs,
  gated on enrollment AND the deck being IN the live snapshot), `LearnQuiz`
  (unlimited attempts), `LearnHomework` (text + files to own storage folder +
  past submissions w/ review status), read-only lecture/example/exercise/
  resource. Learner media rides through `lib/learn/media.ts` (ADMIN client —
  video rows/deck pages are author-only under RLS; callers MUST gate first).
- **Marketplace** (`app/(app)/marketplace`) is REAL: live public publications
  (via the RPC) + a "My learning" section in the same tab; cards link to the
  /learn landing (which doubles as the enroll confirmation/preview screen). The
  old `lib/data.ts` listings survive ONLY for the marketing page's decorative
  peek. **Creator review:** `SubmissionsCard` on the Publish step +
  `/api/learn/submissions` (GET author-scoped w/ profile names + public file
  URLs · PATCH mark reviewed — the trigger backs it).
- **Tests:** `npm run verify:learn` (55 pure — grading/completion/merge/summary/
  clamps/contracts), `npm run verify:learn:int` (61 vs live Supabase — happy
  path incl. republish resilience + attempt-number continuity + enrollment
  flip, the full stranger/enrolled/owner RLS matrix incl. no-client-writes and
  the review-only trigger, RPCs, unlisted gating, storage paths, and the
  concurrent-slide-reports lost-update regression), `npm run verify:learn:browser`
  (15 — Playwright over the real UI: enroll → slides → graded quiz →
  homework → completion → My learning → submissions review; needs the dev
  server running).
- **Not yet (deliberate):** learner-facing video poll while an MP4 is still
  `preparing` (the card explains instead), deck viewer in the browser suite
  (needs the import worker). (Analytics events SHIPPED in M3 — next section.)

## Analytics — event pipeline + creator dashboard (Milestones 3+4, 2026-07-03)

Learner behaviour telemetry end-to-end: an append-only event stream, nightly
SQL rollups, and a per-course creator dashboard. Core = `lib/analytics/*`
(Zod-first, pure modules) + migration `20260702050000_analytics_events.sql`.

- **Contract** (`lib/analytics/events.ts`): 9-type discriminated union
  (lesson_started, slide_viewed{slideId,dwellMs}, video_progress{quartile},
  video_completed, quiz_started, quiz_submitted{attemptId},
  homework_submitted, lesson_completed, session_heartbeat) — every event
  carries publicationId/version/courseId/lessonId + a uuid `clientEventId`
  (idempotency) + clientTs. **camelCase on the wire** (matches /api/learn),
  `mapEventToColumns` → the snake row. Batch ≤100.
- **HYBRID emission (the trust split):** the browser emits ENGAGEMENT events
  only; the AUTHORITATIVE events are SERVER-emitted from the existing writers
  (`lib/analytics/serverEmit.ts`, admin client, never throws): quiz_submitted
  in quizService keyed by the ATTEMPT id, homework_submitted in the homework
  route keyed by the submission id, lesson_completed in progressService on the
  completed FLIP keyed by the learn_progress row id — stable-uuid keys make
  re-emits no-ops, and tab-close can't lose them. `ProgressContext` carries
  `version` now. No dashboard number depends solely on a client event (funnel
  completion cross-checks learn_progress; quiz stats read quiz_attempts).
- **Client SDK**: `lib/analytics/client.ts` (`createAnalyticsQueue` —
  injectable fetch/timers; 10s interval flush; `keepalive:true` POSTs; failed
  batch re-queued w/ exponential backoff; 4xx = dropped [poisoned batch];
  ≤100-event chunks; 500-event offline cap) + `lib/analytics/dwell.ts`
  (`SlideDwellTracker` — injectable clock/visibility, accrues VISIBLE time
  only) + `components/learn/AnalyticsProvider.tsx` (owns DOM wiring:
  interval + visibilitychange→hidden flush + pagehide flush + 60s
  visible-only heartbeat; `enabled=false` for author previews → track() is a
  no-op). Wired: LearnLessonView (lesson_started), LearnSlideDeck (per-slide
  dwell), LearnVideo (25/50/75 quartile crossings + completed at
  VIDEO_COMPLETE_PCT), LearnQuiz (quiz_started on mount).
- **Ingest** `POST /api/analytics/ingest` (Node): requireUser + Zod batch +
  best-effort per-instance rate limit → the SECURITY DEFINER
  **`ingest_learning_events(jsonb)` RPC**. ⚠ **Hard-won:** Postgres applies
  the SELECT policy to `INSERT … ON CONFLICT` rows (the conflict check must
  see the row) — students read NONE by design, so a client-side RLS upsert
  can NEVER be idempotent here. The RPC pins user_id to auth.uid() (forged
  ids are ignored, not trusted), enforces enrolled-or-author + every
  publication belongs to its claimed course, inserts
  `on conflict (client_event_id) do nothing`, returns the accepted count.
  The table's insert policy stays as defense-in-depth for direct inserts.
- **Tables/RLS**: `learning_events` (append-only; UNIQUE client_event_id;
  indexes (course,server_ts) / (user,course,server_ts) / (pub,lesson); insert
  policy as above; select = course author ONLY — students read none; no
  update/delete). Rollups (`rollup_lesson_funnel`, `rollup_question_stats`,
  `rollup_slide_dwell`, `rollup_video_retention`, `learner_flags`) keyed by
  (course_id, publication_id, version) — republishes never mix; author-select
  RLS, zero client writes (definer functions are the writers).
- **Rollup functions**: `private.recompute_course_analytics(cid)` per
  publication — funnel (started = ANY event ∪ learn_progress≠not_started
  [pre-instrumentation backfill, keeps completed ⊆ started]; completed =
  learn_progress='completed' OR lesson_completed event; `lag()` dropoff_pct),
  slide dwell (`percentile_cont(0.5|0.9)`; labels via `mode() within group` —
  **min()/max() don't exist for uuid**), question stats (one attempt = one
  respondent; total = # correct; **point-biserial in SQL**:
  `((m1−m0)/stddev_pop(total))·√(p(1−p))`; answer_distribution buckets =
  choiceId | text | 'true'/'false' | sorted choiceIds joined '+'; the KEY's
  bucket resolved from quiz_answer_keys AT ROLLUP TIME into `key_value` so
  the dashboard never touches the admin client; null for short_answer),
  video retention (distinct users per quartile; video_completed ⇒ q4),
  learner_flags (inactive: enrolled-active + coalesce(max(last_activity),
  enrolled_at) < now()−7d; repeated failure: ≥2 attempts <60% on one block —
  detail = {quizzes:[{blockId,failedAttempts,lastScorePct}]}).
  `public.refresh_course_analytics(cid)` = author-gated manual refresh (the
  dashboard's "Refresh data"); `private.refresh_all_course_analytics()` runs
  nightly via **pg_cron** (`0 3 * * *`, extension created in-migration).
- **Threshold single-source rule:** raw stats live ONLY in SQL (dashboard
  never recomputes); item-analysis flag thresholds live ONLY in
  `lib/analytics/flags.ts` (red: pct_correct<40 & n≥20 · distractor ≥2× key ·
  discrimination <0.1 · dwell skim/stall vs the publication's median-of-
  medians); the stuck-queue constants (7d/2/0.60) unavoidably exist in BOTH —
  `verify-analytics.ts` regex-asserts the migration still encodes the TS
  values, so drift trips CI. `lib/analytics/stats.ts` = pure percentile_cont
  + pointBiserial mirrors, golden-tested against the SQL.
- **Dashboard** `/studio/[courseId]/analytics` (+ `learners/[learnerId]`),
  server components; author-gated (explicit 404 + RLS backstop); reads
  rollups + `course_analytics_overview(cid)` / `course_roster(cid)` (definer
  RPCs — roster joins auth.users.email + profiles + flags; both author-gated
  + anon-revoked). Four `?tab=` tabs (server-rendered, deep-linkable):
  Overview / Content health / Learners / Stuck queue (disabled "Draft
  follow-up" + tooltip until the outreach milestone). Learner detail: progress
  map, native-`<details>` attempt history w/ per-question responses, PAGINATED
  raw-event timeline (the ONE raw-event read, on the (user,course,server_ts)
  index), heartbeat-derived time, flags. Empty states everywhere; chart
  callsites guard empty arrays (AreaChart/BarChart `Math.max(...[])`).
  Components in `components/studio/analytics/*`; data access in
  `lib/analytics/dashboard.ts` (incl. `buildSnapshotMaps` for id→title lookups
  + `bucketLabel` choice-text rendering).
- **Entry points**: `/analytics` = a real course picker now (was mock);
  CourseGallery card icon + editor top-bar "Analytics" link; flagged rows
  deep-link `/studio?course=&lesson=&block=` → `DeepLinkFocus` in
  `StudioLoader` (post-hydration: openLesson + select block +
  scrollIntoView via `[data-ai-id]`; stale ids degrade to a no-op).
- **Tests**: `npm run verify:analytics` (57 pure) + `npm run
  verify:analytics:int` (55 vs live Supabase) — see CHANGELOG for the full
  matrices. The learn suites re-ran green after the server-emit touches.
- **Not yet (deliberate):** wiring "Draft follow-up" (later milestone / M7
  triggers read `learner_flags`), Mux Data / video heatmaps beyond quartiles,
  a persistent-quota rate limiter (in-memory per-instance is documented as
  best-effort), event-driven rollup freshness (nightly + manual is the
  contract; the dashboard shows "refreshed X ago").

## Maintenance agent + learner comms (Milestones 5+6, 2026-07-03)

> Full design: **`docs/agent-architecture.md`** (orchestrator/subagents/budgets/
> triggers/safety rails) — read it before touching `lib/ai/maintenance.ts`,
> `lib/ai/subagent.ts`, or `lib/comms/*`. Companions: `docs/publishing.md`,
> `docs/analytics-events.md`.

- **Subagent primitive** (`lib/ai/subagent.ts`): `runSubagent` = the existing
  loop with `LoopOptions.allowedToolNames` (arbitrary allow-set) +
  `persist:false` (NOTHING in conversations/messages — replay lives in
  `agent_runs.report`) + a one-shot strict-JSON verdict (`runStructuredCall`,
  the intent.ts pattern — `runStructuredPlan` stays private to phases).
  **`withSemaphore(model)` caps concurrent model calls at 2 globally**
  (`MAINTENANCE_MAX_CONCURRENT_MODEL_CALLS`); ONE shared CallBudget
  (`MAINTENANCE_MAX_CALLS` 40) + token budget (`MAINTENANCE_MAX_TOKENS` 300k)
  per run; graceful truncation (last call → partial verdict; skipped findings
  stay open). Loop hooks are ADDITIVE — existing callers byte-identical.
- **`analyze` = the 5th intent** (regex checked FIRST; classifier bullet added).
  `parseAnalysisScope` narrows "module 3"/"lesson 2"/quoted titles to lesson
  ids. Routing: `runContentAgentTurn` → `runMaintenanceTurn` (maintenance.ts).
- **Analytics read tools ×6** (`lib/ai/tools/analytics.ts`) via
  **`ToolContext.analytics`** (capability injection, the `visuals` precedent):
  rollups + `SnapshotMaps` pre-loaded ONCE at run start + a memoized
  `loadLearnerProfile` closure — tools are pure lookups, compact capped JSON,
  **no learner emails in prompts**. Sets: `ANALYST_TOOL_NAMES` (analytics +
  content reads so evidence can quote question wording),
  `REMEDIATION_TOOL_NAMES` (= AUTHORING + 2 reads; NEVER the confirm-pausing
  deletes — unattended runs must not stall).
- **Orchestrator** (`lib/ai/maintenance.ts` + pure `maintenanceSchema.ts`):
  Analyst (loop) → `InsightReportSchema` → `dedupeAndPrioritize` (adopts OPEN
  threshold findings by dedupe key — Analyst wins but takes the filed row's id;
  severity desc; **fan-out cap 5**) → persist to `agent_findings` → dispatch
  **Remediation SEQUENTIALLY over the shared draft doc** (doc-race-free;
  concurrency lives in the semaphore) ∥ **Comms concurrently** (drafts
  `learner_messages` rows; deterministic template fallback; NEVER sends) →
  settle `agent_runs` (report + budget_used). Findings lifecycle
  open→proposed→accepted|dismissed — the change-set Accept/Reject route
  transitions them. ⚠ staging coalesces the subagents' placeholder `""`
  conversationId to null (uuid FK).
- **Evidence** (the core product moment): `stageChangeSetWithEvidence` stamps
  the finding's evidence on EVERY `change_set_items` row; it rides
  `getPendingBlocks` + the `change_set` event (live) + realtime; rendered by
  `components/editor/agent/EvidenceCard.tsx` in BlockFrame's pending chrome
  (above Accept/Reject) + the AgentPanel findings list.
- **Triggers**: chat (SSE, one additive `maintenance` AgentEvent member) ·
  scheduled (weekly pg_cron `0 4 * * 1` QUEUES `agent_runs` in-DB for courses
  w/ a publication + enrollment; **`POST /api/ai/maintenance/cron`** w/
  `Authorization: Bearer CRON_SECRET` drains ONE run per invocation, admin
  client + real OpenAI client — the `course_roster`/`course_analytics_overview`
  RPCs allow `service_role` for this) · threshold
  (`private.file_threshold_findings` after every rollup recompute — one OPEN
  finding per question, reasons aggregated, deduped by a partial unique index
  on `(course_id, dedupe_key) where status='open'`; studio header "N findings"
  badge via StudioLoader → agentStore.openFindings; AgentPanel "Review flagged
  issues" chip sends a canned analyze message that adopts them).
- **M6 `lib/comms/*`** — STANDALONE seam (the marketing branch's email suite is
  unmerged; these mirror its patterns at different paths — don't unify until
  the branches merge). **Resend via `fetch`, NO SDK (runtime deps stay 14)**;
  From-address pinned to RESEND_FROM ("<creator> via WiseSel <addr>");
  HMAC opt-out tokens purpose-prefixed `wisesel.comms-optout.v1` over
  `MARKETING_TOKEN_SECRET` (never cross-usable with marketing's tokens);
  EmailBody block renderer w/ compliant footer; templates ×3.
  **`service.approveAndSend` is the ONLY caller of `provider.send` in the
  repo** (grep-able invariant) — it re-checks `enrollments.comms_opt_out` AT
  SEND TIME (opted-out → `{ok:false, reason:"opted_out"}`, row STAYS draft;
  `failed` is for provider errors only) and resolves the recipient server-side
  (auth.admin). `learner_messages` = draft|approved|sent|failed, author-only
  RLS. `/api/comms/opt-out`: GET renders a CONFIRM page (never flips on GET —
  link prefetchers), POST verifies the token + flips. **No auto-send path
  exists — not even behind a flag**; the orchestrator/cron never import the
  seam. UI: MessageComposer + DraftList (AgentPanel "Messages to review"),
  StuckQueueTab's "Draft follow-up" WIRED (deterministic template prefill, no
  model call; disabled+tooltip when opted out), learner-detail audit list.
- **Tables** (migration `20260703000000`): `agent_runs` (course_id, quoted
  `"trigger"` chat|scheduled|threshold — reserved word, quote it in raw SQL —
  status queued|running|completed|failed, scope/budget_used/report jsonb),
  `agent_findings` (run_id nullable = threshold-filed unadopted; dedupe_key;
  finding jsonb; change_set_id), `change_set_items.evidence jsonb` (nullable,
  additive), `learner_messages`. All author-only RLS; cron/opt-out use admin.
- **Tests**: `npm run verify:maintenance` (35 pure — the ≤2-in-flight semaphore
  assertion, truncation, dedupe/adoption/cap-5, analyze routing, scope, tool
  shapes) · `verify:maintenance:int` (25 vs live Supabase + the mock model —
  the FULL acceptance: `seedFixture` [deliberately-bad quiz: 36% correct @
  n=41, distractor 3× the key, discrimination .05] → scheduled run → ≥1
  evidence-annotated proposal → Accept applies to the draft → Reject restores
  BYTE-FOR-BYTE → budgets ≤ cap → rails: no publication writes, no enrollment
  mutation, ZERO sends) · `verify:comms` (27 pure) · `verify:comms:int` (20 —
  draft→edit→approve→send + **opt-out enforced at the seam** + the opt-out
  route token flow + RLS). `npm run seed:fixtures` seeds a demo fixture.
  **`npm test`** chains every pure suite (~900 checks). ⚠ PostgREST multi-row
  inserts unify columns across rows (missing keys → explicit nulls) — seed
  scripts must carry not-null columns on EVERY row.
- **Env**: `NEXT_PUBLIC_SITE_URL` + `CRON_SECRET` (new, in .env.local +
  .env.example), `RESEND_API_KEY`/`RESEND_FROM`/`MARKETING_TOKEN_SECRET`
  (already present), optional `COMMS_PROVIDER=mock` + `MAINTENANCE_*` budgets.

## AI Content Agent (OpenAI) — `lib/ai/*` (2026-06-15)

> **Prompt single-source-of-truth (2026-06-25):** diagram-vs-image routing is stated
> ONCE — `VISUAL_ROUTING_RULE` (`context.ts`, referenced by `ROLE_AND_RULES` +
> `GENERATE_TEACHING_BAR`) for the prose, and `renderVisualDirective(slide)`
> (`outline.ts`, exported) for the per-slide directive (used by BOTH
> `outlinePromptFragment` AND `phases.ts:renderSpecBrief`). This killed the stale
> 7-cut-kind `add_diagram` lists + the "no AI-generated images" contradiction that
> a prior visual change had left in the GENERATE/edit/repair prompts. Also: the
> GENERATE one-batch instruction now agrees across `GENERATE_TEACHING_BAR` +
> `outlinePromptFragment` (was "one segment per turn" vs "one batch" — a speed
> contradiction); and `SlideSpecSchema.notes` is nullable (coerce `null→""`).
> When changing visual routing, edit those TWO symbols — nothing else re-proses it.
>
> **Perf + correctness pass (2026-06-25):** (0) image model pinned to the dated
> snapshot `gpt-image-2-2026-04-21` (`DEFAULT_IMAGE_MODEL` + `.env.local`). (1)
> Lesson-plan cost cut: `LessonOutlineSchema` descriptions trimmed (global
> principles live once in `PLAN_SYSTEM_PROMPT`, not per field) — strict-JSON schema
> **9514→7430 chars**; per-slide `speakerNotesGoal` moved to a single **lesson-level**
> field (GENERATE derives per-slide notes); the **module-path** per-lesson plan
> (`runRichLessonPlan`) now runs **LOW** effort via `AI_PHASE_MODELS.moduleLessonPlan`
> (it doesn't re-ask on thin, so the medium guard is unneeded there) while the
> standalone single-lesson plan stays MEDIUM. (2) Plan calls log `agent_plan_usage`
> with `cachedTokens`; the plan request was confirmed already correctly ordered
> (static system prefix → course-then-lesson context) — `cachedTokens:0` is TTL
> eviction across the slow pipeline, mitigated by these speedups, NOT an ordering bug.
> (3) **Images off the critical path:** `add_image` is now **ENQUEUE-only** — it stages
> a PENDING image slide (`imageUrl:""` + a `pendingGen` spec on the content) and
> returns immediately; a new Node endpoint **`app/api/ai/visual/generate/route.ts`**
> (reusing `lib/ai/visuals/generateAndStore.ts` = the shared gen→verify→regen→store
> flow) produces the bytes on demand, driven by the client hook
> **`lib/editor/useVisualJobs.ts`** (idle-only, sequential, re-syncs via `liveSync`).
> `VISUAL_WEIGHT` now also pins `quality` (supporting `low` / reference `high`) +
> `thinking` (reference only; the gpt-image-2 `thinking` param is gated behind
> `AI_IMAGE_THINKING_ENABLED` pending field confirmation); `openai_image`/`_inspect`
> log `latencyMs`. (4) **Quiz/homework off the per-lesson hot path:** authored by a
> single CONCURRENT structured call (`authorAuxBlocks` + `lib/ai/auxContent.ts`,
> routed in the mock by `responseFormat` name so the deterministic test stays
> stable), merged before the one reconcile/stage; the slide loop drives
> **`coverageSlidesOnly`**. Verify: `verify:ai`/`verify:visuals`/`verify:slides`/
> `verify:ai:int` all green.

The first real AI: a Cursor-style chat docked beside the lesson editor. Built
**provider-agnostic** — the agent loop, tools, streaming, and change-tracking
never import a provider SDK.

- **Model seam:** `lib/ai/modelClient.ts` (the `ModelClient` interface +
  normalized event/tool types). The OpenAI SDK is imported in **exactly one
  file**, `lib/ai/providers/openai.ts` (Responses API via `client.responses.stream`;
  default model = `OPENAI_MODEL ?? "gpt-5.5"` (edit/fallback; phases override per-call — see below), `OPENAI_REASONING_EFFORT`,
  `OPENAI_MAX_OUTPUT_TOKENS`). `providers/mock.ts` is a deterministic client for
  tests / the no-key path (records each call's params via `getCalls()`).
  **MODEL + `reasoning.effort` are PER CALL** (2026-06-17): `ModelTurnParams.model`
  + `.effort` override the env default. Central config = `lib/ai/modelConfig.ts`:
  every phase defaults to `gpt-5.4-mini` — PLAN high · **GENERATE medium**
  (2026-06-26 — was high; the plan is a binding contract so generation is a structured
  fill, not open-ended creativity; `AI_GENERATE_MAX_OUTPUT_TOKENS` 24k) · REPAIR medium ·
  EDIT medium · LIGHT REVIEW medium (off by default) · CRITIQUE off by default (legacy) ·
  classifier **low** (NOT `minimal` — gpt-5.4-mini rejects it: accepts
  none/low/medium/high/xhigh); each env-overridable (`AI_PLAN_MODEL`/`AI_PLAN_EFFORT`/
  …/`AI_CLASSIFIER_EFFORT`). The correctness gate is its own config block:
  `AI_VALIDATION` (`AI_VALIDATE_GENERATION`/`AI_REPAIR_HARD_FAILURES`/`AI_MAX_REPAIR_PASSES`,
  default ON), `AI_LESSON_FLOORS` (`AI_MIN_NORMAL_/TECHNICAL_LESSON_SLIDES`),
  `AI_LIGHT_REVIEW` (`AI_LIGHT_REVIEW_ENABLED`/`_ON_LINT_THRESHOLD`/`_LINT_THRESHOLD`/
  `_MODEL`/`_EFFORT`). No premium `gpt-5.5` by default anywhere.
  `agent_phase` logs the per-call `{model, effort}`. `ModelTurnParams.responseFormat`
  forces a strict json_schema turn; `usage.{reasoningTokens,cachedTokens}` surfaced.
  **Prompt caching (2026-06-17):** the STABLE prefix must be byte-identical + FIRST.
  `buildSystemPrompt()` is STATIC only (role + catalogs + teaching bar); the
  variable course/lesson/outline rides in a leading `developer` `input` message
  (`buildContextMessage`) so the static system + tool schemas cache as one prefix
  (measured ~98% input cached on repeats). NEVER put course/lesson/outline back
  into the system string.
  **Structured-output gotchas (2026-06-17):** for a reasoning + json_schema
  response `final.output_text` is EMPTY though the JSON exists — read the
  `message` items' `output_text` parts (`messageTextFromOutput`); give the call a
  generous `maxOutputTokens` (PLAN uses 32000) so reasoning tokens don't starve
  it. Strict mode STRIPS `min/max/minItems/maxItems` (`schema.ts`), so never
  hard-reject the parse on them — `coerceOutline`/`coerceModuleSkeleton` clamp
  counts, limits stay as `.describe()`/prompt guidance.
  **Plan calls are NON-STREAMING (2026-06-19):** a plan needs reliability, not
  token streaming — `ModelTurnParams.stream:false` uses `responses.create`. Optional
  `background:true` (CREATE + POLL, no long-held idle connection) gated by
  `AI_USE_BACKGROUND_FOR_PLANS` / used automatically by the module fallback. Errors
  are CATEGORIZED (`ModelErrorKind` + `classifyError`): a transport **timeout** is
  NEVER parsed as "invalid JSON". Every plan call logs `agent_plan_request`
  (planType/model/effort/timeoutMs/input+schema chars/maxTokens/background); a
  failure logs `agent_plan_fail` with `errorType` = `transport_timeout` |
  `model_error` | `transport` | `schema_error`.
- **Phased content pipeline (2026-06-16; VALIDATE/REPAIR added 2026-06-18):**
  content generation runs ONE agent through **PLAN → GENERATE → VALIDATE/REPAIR →
  (optional LIGHT REVIEW) → STAGE** with **per-call effort**; small edits keep the
  single-turn loop. The plan is a **contract**; correctness is enforced by code,
  not a model critique (the heavy CRITIQUE pass is OFF by default — see below).
  **3-way auto-routing** (`lib/ai/intent.ts` `classifyIntent`: regex short-circuits
  + low-effort 3-mode classifier):
  - **`generate_module`** (REDESIGNED 2026-06-19 — the old whole-module plan timed
    out) → a COMPACT **module SKELETON** (`ModuleSkeletonSchema`: a lesson MAP —
    title/objective/rationale/skills/slide-range/blocks per lesson, **NO per-slide
    content**; low effort, ~2.8 KB schema → returns in seconds) → ONE approval card
    → create module + lessons → **for EACH lesson: a LAZY RICH lesson plan**
    (`runRichLessonPlan`, full `LessonOutlineSchema`, high effort, one small lesson)
    → GENERATE (medium) → **VALIDATE/REPAIR**. A lesson whose rich plan fails is
    SKIPPED + checkpointed (the rest still build). If the skeleton call
    transport-fails, an **ultra-lean FALLBACK** (`ModuleFallbackSchema`, background
    mode) retries once (`runModuleSkeletonPlan`). No light review (kept cheap; lint
    aggregated into one `quality_report`). Routing: a module build that NAMES its
    lessons routes here; only "add a lesson TO module X" (`LESSON_INTO_MODULE`)
    diverts to `generate_lesson`.
  - **`generate_lesson`** → lesson PLAN (`LessonOutlineSchema`) → approve → GENERATE
    (medium) → **VALIDATE/REPAIR** → optional **LIGHT REVIEW**.
  - **`edit`** → the single-turn loop, LAYERED (teaching bar + layout guide); no
    plan gate, no validate — stays fast. The delete-resume loop is layered too.
  **PLAN is the contract** (`lib/ai/outline.ts`): each slide spec carries a `role`
  (hook/worked_example/common_mistake/conceptual_check/…) + `kind` (core|enrichment);
  the lesson carries `microLesson`. **CONTENT-FIRST (Method 1, 2026-06-23):** the
  slide spec is ordered + prompted so the model FINALIZES the slide's `keyPoints` (its
  real content) BEFORE choosing the `layout` that fits them (and varies layout across
  the deck) — not layout-first. If a slide's points overflow one card it SPLITS at plan
  time (never truncates): a **continuation** (`continuationOf` links to the parent;
  `normalizeContinuations` stamps a " (cont.)" title + drops points repeated verbatim
  from the parent, preserving every unique point) or a **sub-topic split** (two distinct
  descriptive titles). A continuation is its own spec → counts toward coverage;
  `isContinuationSlide` + the "(cont.)" title are the cue. Slide-count guidance (micro 3–4 only on request ·
  normal 6–10 · technical 7–12 · complex 9–14) + a **depth floor**
  (`lessonDepthShortfall`, `AI_MIN_NORMAL_/TECHNICAL_LESSON_SLIDES`) that re-asks
  ONCE for a too-thin non-micro plan (via `runStructuredPlan`'s `postValidate` hook,
  reusing the single repair-call slot; a valid-but-thin plan is never lost). The
  outline is **transient** (round-trips client→server, never persisted). An
  **auto-approve** toggle (OFF by default) skips the pause.
  **GENERATE** runs the narrow **`generateTools`** (`GENERATE_TOOL_NAMES`: the slide-
  inspection reads + structured slide tools + create_block + write_quiz/homework/
  lecture — **no `write_slide_deck`/flat slide ops**, and as of 2026-06-22 **no
  `get_course_context`/`list_modules`/`list_lessons`/`get_lesson`** either: the
  course/lesson/plan/authored set already ride in the context + generation-state, so
  GENERATE/REPAIR can't burn turns re-reading them). It **pre-creates an EMPTY deck**
  and threads its `deckBlockId` into the context (`buildContextMessage`), so the model
  authors real slides into a known deck and **never seeds a placeholder**.
  `add_structured_slides_batch` takes a **nullable** `deckBlockId` resolving to the
  lesson's deck, and **CLAMPS-not-rejects** (2026-06-22): each slide's over-length
  slots are auto-shortened to their cap server-side (`clampStructuredTemplate`,
  schema-driven via Zod `too_big` issues) and the slide is SAVED with its specId — a
  formatting overflow never bounces back, so coverage closes; only a slide MISSING
  required content (unclampable) comes back. (The single-slide `add_structured_slide`/
  `set_structured_slide` tools stay strict.) The edit path runs `authoringOnly`
  (`AUTHORING_TOOL_NAMES`). The outline's per-slide `keyPoints` brief
  is expanded; the teaching bar frames the plan as a binding contract + bans skeletal
  slides (`agent_thin_slides` log).
  **VALIDATE/REPAIR** (`lib/ai/validation.ts` pure + `slideDiagnostics.ts` leaf):
  after GENERATE, check the doc vs the plan — every spec built, no placeholder/empty
  slide, no duplicate primary spec, required quiz/homework present, deck not short,
  budget not exhausted. Hard failures are repaired DETERMINISTICALLY first (strip
  placeholder/empty slides, drop junk/empty decks — no model) then a NARROW model
  pass handed ONLY the missing spec briefs + missing blocks (`buildRepairInstruction`,
  via `LoopOptions.extraInstruction`), re-validating up to `AI_MAX_REPAIR_PASSES`. If
  still unmet → **checkpoint** with exactly what remains (never staged as complete;
  `LoopResult.checkpointed` = budget vs done). `generationState` now also tracks
  remaining/duplicate/placeholder/no-spec/incomplete-segment/missing-block so bounded
  history can't forget the contract.
  **LINT + LIGHT REVIEW** (`lib/ai/lintGeneration.ts` pure, `lib/ai/lightReview.ts`):
  after hard validation passes, a no-model linter emits SOFT warnings; an OPTIONAL
  **one-call** review (no tool loop, no regen, gpt-5.4-mini/medium, OFF by default,
  fires only when lint ≥ `AI_LIGHT_REVIEW_LINT_THRESHOLD`) adds ≤3 suggestions.
  Neither blocks staging. The whole run stages ONE change-set, but now via
  **flush-on-exit** (2026-06-22): the pipeline reconciles the doc to the DB
  INCREMENTALLY (the driven loop persists each authored batch the turn it lands;
  each lesson persists as it completes; a module's scaffold persists the instant it's
  planned) and stages the change-set in a guarded `finalize()` that runs on EVERY
  termination — completion, token cap, turn cap, no-progress guard, **user Stop
  (abort)**, or a thrown error — so partial work is NEVER discarded (the "module
  spun 10 min, persisted nothing" fix). `reconcileAndStage` is split into a
  repeatable `reconcileDoc` + a one-shot `stageChangeSet`.
  **Autosave coordination (the former hazard, now fixed):** the editor store's
  `agentRunActive` flag PAUSES the browser autosave for a run's duration (so the
  agent's server reconcile and a browser full-snapshot can't race + orphan rows),
  and a debounced `scheduleLiveSync` (`lib/editor/liveSync.ts`) re-loads the doc via
  `syncLiveDoc` (no full re-hydrate) so the deck renders LIVE as it's built; a
  Supabase Realtime sub on `change_set_items` (`useChangeSetRealtime`, migration
  `20260622010000`) drives the same re-sync (degrades gracefully if unpublished).
  Orchestration in `lib/ai/phases.ts`
  (`runContentAgentTurn`/`runGenerateLessonTurn`/`runGenerateModuleTurn`/
  `runModuleSkeletonPlan`/`runRichLessonPlan`/`runLessonPipeline`/`validateAndRepairLesson`/
  `runGenerateModule`/`resumeGeneratePlan`; legacy `runLegacyCritique` gated by
  `AI_CRITIQUE_ENABLED`, off); approval resolved
  by `app/api/ai/agent/plan/route.ts`. The review is a **prominent modal**
  (`components/editor/agent/AgentPlanHost.tsx`) + a sidebar phase badge + a calm
  `validation` line + a `quality_report` "Quality suggestions" card
  (`agentStore.phase`/`validation`/`qualityReport`/`pendingOutline`/`autoApprovePlan`).
  Per-phase `console.log({tag:"agent_phase", layered, effort, tokens, latencyMs,…})`;
  per-lesson `agent_plan_coverage`.
- **Loop:** `lib/ai/agentLoop.ts` — per turn: persist user msg → load doc +
  replayed history → stream a model turn → execute each tool call (validate args
  → apply CoursePatches to the in-memory doc → stream `tool_result`) → feed
  output back → repeat (cap `AGENT_MAX_TURNS`, with a `checkpoint`). Then
  reconcile the doc to the DB ONCE and stage the net block diff as one
  change-set.
  **Coverage driver (2026-06-22):** GENERATE/REPAIR pass `driveToCoverage` — the
  loop no longer stops the instant the model returns a no-tool-call turn; while
  plan specs remain it injects a concrete "STILL TO BUILD …" nudge
  (`buildContinuationNudge`) and keeps building (turns scaled to the plan via
  `coverageMaxTurns`/`repairMaxTurns`), with a no-progress guard
  (`AGENT_NO_PROGRESS_LIMIT`) stopping a stalled run. Driven loops DON'T emit
  their own checkpoint (`stopShort` only records it) — the validate/repair
  pipeline owns the ONE final checkpoint. This is the fix for the "3-of-10 deck".
- **Tools = the ops layer:** `lib/ai/tools/*`. Read (get_course_context /
  list_modules / list_lessons / get_lesson / get_block), structural
  (create_module/lesson/block, delete_block, reorder_blocks), and content
  writers (write_slide_deck / write_quiz / write_homework / write_lecture_text).
  writers, PLUS a granular **slide tool surface** (`lib/ai/tools/slides.ts`:
  get_deck / get_slide / add_slide / update_slide / set_slide_layout /
  reorder_slides / delete_slide) — id-addressed + non-destructive, bound to the
  studio's OWN `SLIDE_LAYOUTS` registry (a strict layout enum + catalog;
  `lib/ai/tools/slideContent.ts`). Emphasis is rich-text **runs**
  (`lib/ai/richText.ts`, structured + markdown→runs safety net — no `**` leak).
  Tools are PURE over `ctx.doc` → return CoursePatches + a summary; the loop
  owns apply/persist/stream. Writers build full blocks (blockBuilders.ts) and
  commit via **`SET_BLOCK_CONTENT`**; the slide tools use **`SET_SLIDE_CONTENT`**
  (switch one slide's layout + content in place) / `ADD_SLIDE` /
  `UPDATE_SLIDE_ELEMENT` / `APPLY_SLIDE_LAYOUT`. `write_slide_deck` is now
  per-slide layout + rich content, reserved for a FRESH deck. Tool param schemas
  are Zod (single source of truth) → strict JSON Schema via `lib/ai/schema.ts`
  (`z.toJSONSchema` + a strict post-process: all keys required, optionals→
  nullable, oneOf→anyOf, unsupported keywords stripped).
- **Change-set staging:** `lib/ai/changeSetDiff.ts` (pure block diff) +
  `lib/ai/changeSet.ts` (create/accept/reject; Reject replays the inverse
  through the patch pipeline). Mutations apply + persist, but blocks are flagged
  pending so the editor highlights them (amber ring + inline Accept/Reject in
  `BlockFrame`, panel review bar). DB is authoritative.
- **Conversations:** `lib/ai/conversations.ts` — threads + messages in Postgres;
  history is REPLAYED each turn (no provider-side state). Tables added by
  `supabase/migrations/20260615010000_ai_agent_conversations_changesets.sql`
  (conversations, messages, change_sets, change_set_items; all RLS author-only).
- **Persistence:** server reconcile is the SHARED `lib/course/persistenceSync.ts`
  (the browser autosave now wraps it too). `lib/ai/serverPersistence.ts` re-exports
  `loadCourseDoc` / `reconcileCourseDoc`.
- **Routes (Node runtime, SSE):** `app/api/ai/agent/route.ts` (POST → streams
  the `lib/ai/events.ts` protocol) and `app/api/ai/change-set/[id]/route.ts`
  (accept/reject). **The OpenAI key is server-only.**
- **UI:** `lib/editor/agentStore.ts` (transient streaming + pending-highlight
  state), `components/editor/agent/{AgentPanel,useAgentStream}.tsx`, docked in
  `CourseEditorShell` (collapsible `agentPanel` PanelKey), studio server-loads
  pending blocks → `StudioLoader` → `agentStore.hydratePending`.
- **Env:** set `OPENAI_API_KEY` (required) in `.env.local`; optional
  `OPENAI_MODEL` / `OPENAI_REASONING_EFFORT` / `OPENAI_MAX_OUTPUT_TOKENS` /
  `OPENAI_TIMEOUT_MS` (client default 120s) / `OPENAI_MAX_RETRIES`.
- **Transport / proxy (2026-06-19):** the OpenAI SDK's bundled undici `fetch`
  **ignores `HTTPS_PROXY`**, so on a proxy-only machine (e.g. Clash `:7890`) it
  connects DIRECTLY, the socket never establishes, and it dies at the OS TCP-connect
  timeout (**~75s** on macOS = `net.inet.tcp.keepinit`) → a `transport_timeout` that
  was mis-blamed on "slow module planning". `createOpenAIModelClient` now reads
  `OPENAI_PROXY_URL` (else `HTTPS_PROXY`/`HTTP_PROXY`) and, when set, routes through a
  proxy **scoped to the OpenAI client** (`new OpenAI({ fetch, fetchOptions:{ dispatcher:
  new ProxyAgent(url) } })` — undici's fetch + dispatcher MUST be from the same undici;
  global dispatcher untouched so Supabase stays direct). **No proxy env ⇒ direct
  connection (production unchanged).** `undici` is a **devDependency** (runtime deps stay
  14), `require`d via a variable-specifier `createRequire` so the bundler never resolves
  it at build (prod never needs it). Logs `openai_client_config {proxy,transport,…}`.
  Diagnose with `npm run smoke:openai` (`scripts/smoke-openai.ts`): Phase A = no-proxy
  reproduction (~75s), Phase B/C = proxied success (1–3s, incl. structured + background);
  `SMOKE_SKIP_A=1` skips the slow part. Background mode (poll loop) is env-tunable via
  `AI_BACKGROUND_POLL_TIMEOUT_MS` / `AI_BACKGROUND_POLL_INTERVAL_MS`.
- **Tests:** `npm run verify:ai` (tools/schema/patch + the outline PLAN schema/parse/extraction guard `verify-outline.ts` + bounded-history `verify-bounded.ts` + the **VALIDATE/REPAIR/LINT** suite `verify-validation.ts` — placeholder detection, every hard-failure class, deterministic repair, the PLAN depth floor, lint + light-review trigger; all no-key) and
  `npm run verify:ai:int` (full loop vs live Supabase via the mock provider — **113**
  checks incl. the phased lesson pipeline, the **module SKELETON → approve →
  per-lesson rich-plan → generate → validate** flow, **skeleton-timeout →
  background fallback**, **both-timeout → clear-message** (not "invalid JSON"),
  per-call effort + layered system-prompt via the mock's `getCalls()`, the 3-way
  classifier routing, clean-validate · missing-spec repair · placeholder removal ·
  light-review-trigger paths, the **coverage driver** (a model that stops at
  1/3 is nudged to completion), the **no-progress guard** (one pipeline checkpoint),
  the **live AI-image path** (add_image → mock bytes → Supabase upload →
  `illustration` slide with a real public URL), **CLAMP-not-reject** (an over-length
  slot auto-shortens + saves → coverage closes, no repair), **flush-on-exit** (a
  stalled run AND a simulated user-Stop both STAGE + PERSIST their partial deck), and
  (the stretching/call-reduction pass) **diagram best-effort** (an off-slope
  add_diagram resolves in ONE shot — no error/retry — and renders a repaired valid
  diagram), **REPAIR at medium effort**, and the **course-level reads excluded** from
  GENERATE (loaded once, never re-fetched)). The mock can inject a transport error
  (`MockTurn.error`), a deterministic `generateImage`, and (via a thin runTurn wrapper)
  an abort mid-run.
  Slide-vocabulary suites (no key): `npm run verify:slides` (stickers + font
  tokens + all 8 structured layouts incl. near-max overflow + the structured
  agent tools) and `npm run verify:reject` (atomic byte-for-byte revert, incl. a
  structured slide). Renderer near-max overflow is checked with a temporary
  `/zz-layout-preview` + Playwright harness (build it, drive it through every
  variant + both decor levels, assert no frame overflow / container clipping,
  then delete it + `npm uninstall playwright`).
- **Slide vocabulary (2026-06-16):** **stickers** = a pure id-keyed registry
  (`lib/course/slide/stickers.ts`) + a `sticker` element (icons stay in the
  renderer, `StickerElement.tsx`/`StickerGlyph`). **Font tokens** =
  `ElementStyle.fontScale` (display/title/heading/body/caption) → per-theme
  `typeScale`, wins over legacy px (toolbar/Design tab are token dropdowns now);
  `display` family = Fraunces. **Structured layouts** = renderer-owned
  `slide.template` (`structuredLayouts.ts` registry with STRICT length-enforcing
  Zod schemas; `components/editor/slide/structured/*`; Shiki via `highlight.ts`)
  — `SlideStage` branches on `template`, the `LayoutPicker` "Structured" section
  + `StructuredContentEditor` edit them. AI tools: `add_structured_slide` /
  `set_structured_slide` / `set_text_style` / `add_sticker`
  (`lib/ai/tools/structuredSlides.ts`); the strict schema's `.max()` no longer
  REJECTS — it CLAMPS (auto-shortens + saves; `clampStructuredTemplate`), so no slide
  is ever bounced for fit. **Reject is atomic** (`revertChangeSet`).
  **STRETCHING (Gamma-style, within the fixed 16:9 frame, 2026-06-22):** the clip-prone
  renderers (`concept_example`, `comparison_columns`/`_matrix`, `outline_list`, `prose`,
  `code_walkthrough`) were rebuilt from absolute boxes with `overflow:hidden` into FLOW
  layouts — a flex column (header → growing body → footer); columns grow independently +
  stretch to the taller; the matrix grid uses `auto` rows; `outline_list` flows; code
  font scales to line count. No text container clips (only the horizontal break-word
  guard remains). `SlideStage` is still a fixed 1280×720 canvas, so concise/capped
  content fits the frame — the canvas itself was deliberately NOT made variable-height.
  Runnable guard: `scripts/verify-stretch.ts` (SSR-renders heavy content, asserts
  nothing is dropped + the layout flows); pixel-level no-overflow is the temporary
  `/zz-layout-preview` + Playwright visual pass.
  **8 structured layouts:** the original four (process_steps,
  key_concept, metrics_overview, code_walkthrough_steps) PLUS **section_break**
  (chapter divider; variants standard/hero_numeral × titleStyle serif/sans;
  renderer-owned two-tone title + corner arcs), **concept_example** (rule/def
  left + worked example right whose body is a `steps`|`paragraphs` discriminated
  union; "in practice" connector + footnote callout), and **outline_list**
  (titled nested list — objectives / TOC — 2–5 items × 0–2 sub-points), and
  **prose** (2026-06-17 — a deliberate plain teaching slide: title + a substantive
  rich body + optional points; a FIRST-CLASS plan choice rendered structured, NOT
  a flat fallback). Each is the SAME pattern (registry entry + strict schema +
  component + union variant + dispatch case), auto-exposed to the AI catalog +
  picker. Decoration is
  renderer-owned and dial-able via a `decor` (`full`|`minimal`) knob that lives
  in storage + the inspector but is **ABSENT from the strict AI schema** (the AI
  can never request/position flair). `ITEM_BOUNDS` is now `Partial` — the three
  bespoke layouts use their own inspector panels (dispatcher in
  `StructuredContentEditor`); the original four share the generic item editor.
- **Low-stakes assessments enforced structurally:** quiz/homework schemas no
  longer contain scores/passing/time/attempts/difficulty/points/due-dates (the
  fields, patches, and UI were removed 2026-06-15).

## Visual pipeline — image-first overhaul (2026-06-25)

> **Supersedes the diagram-centric notes below where they conflict.** Most visuals
> are now **GPT Image generated images** (default model **`gpt-image-2`**, the latest;
> `OPENAI_IMAGE_MODEL` overrides) rendered as clean academic **textbook
> figures**; only **`supply_demand` + `coordinate_plot`** stay programmatic (they
> need exact axis values). The other 7 diagram kinds (bar_chart, array_diagram,
> tree_diagram, graph_diagram, flowchart, number_line, venn) were **retired from the
> AI surface** (AI-surface-only — storage schema + renderers + validate/repair/
> geometry KEPT so any already-saved diagram still loads/renders/reverts; the model
> just can't author them). Enforced by: the strict `DiagramSpecInputSchema` union =
> 2 kinds; `catalog.ts` filtered by kind (`AUTHORABLE_DIAGRAM_KINDS` in `repair.ts`);
> `coerceDiagramBestEffort` returns null for a retired kind → prose/image degrade;
> `router.ts` `ROLE_TO_KIND` keeps only `coordinate_plot` roles (the rest route to
> images); `accuracyCriticalKind` = the 2 kinds.
>
> - **Two new image layouts** (mirror the `illustration` precedent — authored ONLY by
>   `add_image`, an `imageUrl` only the tool supplies, so NOT in
>   `StructuredTemplateInputSchema`): **`image_reference`** (hero; image IS the
>   subject — eyebrow+title, 0–4 annotations, 0–3 numbered concept cards; 3:2
>   1536×1024) and **`image_supporting`** (image aids the text — eyebrow+title+lead,
>   0–4 bullets, optional caption; 1:1 1024×1024). Both: fixed-AR box + `object-fit:
>   cover` so the image can't bleed. Renderers in `components/editor/slide/structured/
>   {ImageReferenceLayout,ImageSupportingLayout}.tsx`; registered in
>   `STRUCTURED_LAYOUTS` (+ new `capacity` metadata), storage `SlideTemplateSchema`,
>   the `SlideTemplate` union, and `StructuredSlide` dispatch.
> - **Legacy `illustration` retired from the AI side** (`PLANNABLE_LAYOUT_IDS` +
>   `structuredLayoutCatalog()` exclude it; `add_image` never emits it). Kept only for
>   back-compat rendering of existing slides.
> - **`visualWeight: 'reference' | 'supporting'`** on the plan's `visualIntent` (plus a
>   structured **`imageSpec`** {subject, requiredLabels, axes, annotations} for
>   reference). Pinned in ONE place — **`VISUAL_WEIGHT`** in `lib/ai/visuals/config.ts`
>   (→ layoutId + gen `size` + `background` opaque/transparent + `promptMode`).
>   `ImageGenParams` gained `size`/`background`; `openai.ts` passes them to the GPT Image model.
> - **Content-first split is capacity-aware:** `StructuredLayoutDef.capacity.maxPoints`
>   + `layoutPointCapacity()` drive `splitOverflowingSpecs` (image_reference 7,
>   image_supporting 4) — an over-full image slide spills to a `(cont.)` slide.
> - **Prompt builder** = `lib/ai/visuals/imageIntent.ts` (PURE): a shared TEXTBOOK
>   style preamble + per-`promptMode` spec (reference = quoted required labels/axes;
>   supporting = looser-but-academic). `buildImagePrompt` + `imageIntentHash`.
> - **Reference verification** (reference only, `AI_IMAGE_VERIFY_ENABLED` default on):
>   new `ModelClient.inspectImage` (vision; `AI_VISION_MODEL` ?? gpt-5.4-mini, mock has
>   a deterministic verdict) checks the required labels appear → regenerate ONCE →
>   else `add_image` **prose-degrades** (coverage holds, no loop). Lives in
>   `makeVisualGenContext` (`agentLoop.ts`).
> - **Freeze-on-accept:** the image content carries `intentHash`; `add_image` reuses
>   the stored asset when an existing slide for the spec has the same hash (no regen),
>   and **`set_image_text`** edits an image slide's text WITHOUT regenerating.
> - Tests: `npm run verify:visuals` (94) + the image path in `verify:ai:int` (122) +
>   `verify:slides`. **Remaining manual step (deferred):** the Playwright pixel-overflow
>   pass for the two new layouts (`/zz-layout-preview`) — not yet run.

## Visual pipeline — programmatic diagrams (2026-06-20, see CHANGELOG.md)

A teaching visual is a **teaching object, not decoration**. The LIVE path renders
**programmatic diagrams**: typed deterministic data drawn as crisp SVG, so a graph
is **accurate by construction** (a supply curve slopes up; a Dijkstra graph weights
every edge), editable, accessible, exportable, and persisted in `blocks.content`
with **no blob URLs**. A diagram is just an **11th structured layout** (`SlideTemplate`
`layoutId: "diagram"`), so it reuses the SAME patch pipeline, validate→repair,
change-set staging/reject, and picker — **no new patch actions, no new storage**.

- **Model** = `lib/course/diagram/*` (pure): `types.ts` (`DiagramSpec` union of 9
  kinds: supply_demand [+ price ceiling/floor], coordinate_plot, bar_chart,
  array_diagram, tree_diagram, graph_diagram, flowchart, number_line, venn; plus
  `VisualSpec` [purpose + alt text + reason] and `DiagramContent`) · `schemas.ts`
  (STRICT AI Zod with caps + a `.superRefine` running `validateDiagram`; permissive
  STORAGE schema; AI tree node is FIXED-DEPTH so it inlines to OpenAI-strict JSON
  with no recursive `$ref`) · `validate.ts` (deterministic correctness — the spec's
  named failure cases) · `catalog.ts` (19 correct named templates; whole-WORD topic
  matching) · `geometry.ts` (tree/graph/flow layout, scales, equilibrium).
- **Renderers** = `components/editor/slide/diagram/*` (PURE → SSR/thumbnail/export
  safe): `svg.tsx` toolkit + `DiagramView` (9 renderers) + `structured/DiagramLayout`
  (`role="img"` + alt text + the `data-ai-component="slide-visual"` envelope). The
  diagram is registered in `STRUCTURED_LAYOUTS` + `StructuredTemplateInputSchema` +
  storage `SlideTemplateSchema` + the `SlideTemplate` union; auto-exposed to picker,
  plan catalog, and AI tools.
- **Planning** = `lib/ai/outline.ts` `visualIntent` is now a STRUCTURED object
  (required/role/reason/expectedVisualType/placement/priority/mustBeAccurate; tolerant
  of a legacy string). **AI tools** = `add_diagram` / `set_diagram` (templateId
  seeds an accurate canonical diagram). **BEST-EFFORT + REAL-DATA-ONLY, never reshape-
  and-retry (2026-06-22):** the diagram tools are `lenientArgs` — a custom diagram is
  parsed permissively then `coerceDiagramBestEffort` (`lib/course/diagram/repair.ts`)
  REPAIRS the invariants on the model's OWN data (re-slope/re-sort/drop-dangling-edge/
  drop-the-weighted-claim) and renders it iff it validates, ELSE returns `null`. It
  **never fabricates or seeds placeholder/demo data** (the old minimal-seed / topic-
  template fallback was a regression — a generic A/B/C chart on an econ lesson); an
  unusable diagram **degrades to a real-text PROSE slide** built from the model's
  title/caption (so coverage still holds, no retry). A templateId is reserved for the
  canonical STRUCTURAL diagrams. (`bestEffortVisualTemplate` is the shared builder; a
  `diagram` entry inside `add_structured_slides_batch` routes through it too.)
  **Validation (2026-06-22):** `REQUIRED_VISUAL_MISSING` is now SOFT —
  reported, but it does NOT block `ok` or trigger repair (KEEP COVERAGE, DROP FIT:
  repair only fills a genuinely missing slide/block). **Inspector** = `DiagramEditor`.
- **Pipeline architecture** = `lib/ai/visuals/*` — `config.ts` flags (defaults
  2026-06-22: programmatic ON, **image-gen ON**, web OFF, validation ON;
  `AI_VISUAL_MAX_PER_LESSON` 5), full `VisualSpec`/`VisualAsset`, the source
  `router.ts` (programmatic → AI-generated → web → manual, by priority),
  `imagePrompt.ts`, the `generate.ts` seam, and `storeImage.ts`. **Web sourcing
  stays Phase 5 (OFF).**
- **AI IMAGE GENERATION — LIVE (2026-06-22).** For a concept no programmatic
  diagram fits (a historical scene, a biological structure, an analogy) the
  **`add_image`** tool generates an educational illustration via
  `ModelClient.generateImage` (gpt-image-2 default, `OPENAI_IMAGE_MODEL`, through the SAME
  proxied OpenAI client — base64 out), **stores the bytes to the Supabase
  `course-assets` bucket** under `{ownerId}/ai-visuals/{courseId}/…`
  (`storeImage.ts`; public URL on the slide, NEVER a blob/data URL), and lands it
  as a first-class **`illustration` structured layout** (registry + strict schema +
  `IllustrationLayout.tsx` + `SlideTemplate` union + `SlideStage` dispatch). It's
  the ONE impure tool path: a `VisualGenContext` capability injected into the tool
  ctx by `loopContext` (present only when image-gen is on AND the client can make
  images; absent ⇒ `add_image` ToolErrors → the model falls back to a diagram/
  prose). `illustration` is authored ONLY by `add_image` — it's intentionally NOT
  in the hand-authored `StructuredTemplateInputSchema`. Accuracy-critical figures
  still go programmatic; capped per lesson (`AI_VISUAL_MAX_PER_LESSON`). The mock
  provider has a deterministic `generateImage` so the whole generate→store→slide
  path is tested with no key. Tests: `npm run verify:visuals` (84 checks) + the
  live image path in `npm run verify:ai:int`.

## Video lessons — educator recording/upload (Mux), 2026-07-01

A first-class **`video` block** (sibling of `slide_deck` / `imported_deck`) for
educator-recorded or uploaded lessons, hosted by **Mux**. Educator-side only (no
student player yet). The pattern mirrors imported decks: an external asset with a
status lifecycle, a source-of-truth row, and a denormalized snapshot on the block.

- **Env:** server-only `MUX_TOKEN_ID` + `MUX_TOKEN_SECRET` (required to record/upload);
  optional `MUX_WEBHOOK_SIGNING_SECRET` (enforces webhook signatures — without it the
  webhook route skips verification and logs it; polling covers status either way). The
  webhook reuses the existing privileged `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEY`
  (admin client). Optional client-safe `NEXT_PUBLIC_MUX_DATA_ENV_KEY` is a DEFERRED
  extension point (Mux Data analytics — not wired). Optional `MUX_MP4_RESOLUTION`
  (default **`highest`**; `720p`/…) sets the downloadable MP4 rendition the studio
  plays. **Mux gotchas (2026-07-01 — learned the hard way, verify against a LIVE
  asset, don't guess the shape):**
  (1) Request MP4 via `static_renditions: [{resolution}]`, NOT the deprecated
  `mp4_support: "standard"`. Default to **`highest`** — it renders at the source's
  own resolution, so it's never upscale-skipped and is a VALID resolution input on
  every tier. Do NOT use `capped-1080p` as a resolution input — it's a rendition
  *name* Mux can emit but Mux **rejects it as a resolution input with a 400**
  ("Invalid static rendition resolution"), which 502s create-upload. A fixed size
  (`720p`) is SKIPPED whenever the source is smaller than it → no MP4.
  (2) **`mp4_support` is a red herring:** the modern renditions API always reports
  `mp4_support: "none"` even for a healthy asset with a ready `highest.mp4`. NEVER
  gate playability on `mp4_support` — read `static_renditions.files` + each file's
  per-file `status`. Gating on `mp4_support === "none"` was the true cause of the
  "preview stuck on Preparing… forever" bug (a ready MP4 was being hidden).
  **No new runtime dep** (stays 14): recording is browser-native, and playback is a
  native `<video>` on a Mux MP4 static rendition — Mux Player / HLS are documented
  upgrade paths, not used.
- **Document model** (`lib/course/types.ts`): `VideoLessonBlock` = `asset`
  (`VideoAssetSnapshot`: provider + status `empty|uploading|processing|ready|failed` +
  Mux ids + duration/aspect/thumbnail — **never raw bytes**), `recording`
  (mode/layout/bubble/mic), `edit` (non-destructive `trimStartSeconds`/`trimEndSeconds`),
  `settings`. In the `BlockType` union, `LessonBlockSchema` (Zod), `factories`
  (`createVideoLessonBlock`), `commands` (`updateVideoLessonPatch`), `manifest`. The ONLY
  mutation path is the **`UPDATE_VIDEO_LESSON`** patch (schema + reducer in `patches.ts`;
  null clears an optional field, sub-objects merge shallowly).
- **Persistence:** free — the block payload rides in `blocks.content` jsonb, so
  autosave/load/reconcile handle it unchanged. Migration `20260701010000_video_lessons`
  only widens the `blocks.type` CHECK and adds the **`video_assets`** table (source of
  truth for Mux status; RLS author-only via `private.is_course_author`; soft
  `lesson_id`/`block_id`, like `deck_imports`). **No storage bucket** — Mux hosts the
  media; recordings upload DIRECTLY to a Mux direct-upload URL (never through our server).
- **Provider seam** (`lib/video/provider/*`): `types.ts` = the provider-agnostic
  `VideoProvider` interface + normalized shapes; `muxClient.ts` = the ONLY file with Mux
  HTTP (fetch + Basic auth + `node:crypto` webhook HMAC — **no Mux SDK**), normalizing
  uploads/assets and resolving the MP4 rendition URL from `static_renditions.files`
  (`resolveMp4` reads ONLY the files + each file's per-file `status`, NEVER
  `mp4_support`: a READY video file → play it; still-generating → keep polling; every
  rendition SKIPPED/errored → definitively `disabled`, never a forever-"preparing").
  It also flags `adaptiveMp4Present` (an existing `highest` rendition). `index.ts`
  selects the provider. Also `addMp4Rendition(assetId, resolution?)` — the self-heal
  that adds an adaptive rendition to an existing asset that ended up with no usable
  MP4 (only swallows an "already exists" 400; re-throws others). Server-only.
- **Service/status/access** (`lib/video/*`, mostly PURE): `videoService.ts` (CRUD +
  `syncVideoAssetFromMux` + row→`VideoAssetView` with derived public URLs;
  **self-heal:** a `ready` VIDEO asset with no usable MP4 AND no adaptive rendition
  yet re-requests a `highest` rendition once and reports `preparing` so the poll
  fills `mp4_url` in — recovers assets stranded by the old fixed-resolution bug;
  gated by `adaptiveMp4Present` so it can't loop),
  `videoStatus.ts` (state machine, `reconcileMuxState` — an asset goes `ready` as
  soon as it's playable; the MP4 rendition fills in via continued polling
  [`isActiveVideoStatus` keeps `ready`+mp4-`preparing` active] — and `validateTrim`),
  `videoAccess.ts`
  (auth+ownership guards), `playbackUrls.ts` (HLS/thumbnail builders), `videoTypes.ts`
  (row aliases + `snapshotFromView`), `recorderConfig.ts` (the 3 modes, bubble geometry,
  formatters, file validation).
- **Routes** (`app/api/video/*`, Node runtime, secrets server-only): `mux/create-upload`
  (POST → row + Mux direct upload, row id = Mux passthrough), `mux/asset-status` (POST →
  the client poll: sync from Mux + return the view), `mux/webhook` (POST → verify
  signature → admin client → re-FETCH the asset and reconcile, immune to event-name
  churn), `[id]` (DELETE → Mux asset + row cleanup).
- **UI** (`components/editor/lesson/video/*`): `useVideoRecorder` (device enumeration,
  `getUserMedia`/`getDisplayMedia`/`MediaRecorder`, **canvas compositing** of screen +
  webcam bubble, state machine idle→setup→countdown→recording→paused→recorded, timer,
  countdown, mic-level meter, pause/resume, and **deterministic teardown of every track**
  on unmount — closing the modal mid-recording releases the camera/mic), `useVideoUpload`
  (create → PUT to Mux with progress → status), `useVideoAsset` (poll while active +
  mirror to the block). `VideoStudioModal` orchestrates mode → setup → record → review →
  upload, plus a manage/edit screen for a ready video (trim, description, settings,
  replace, remove). `VideoBlock` is the block card (empty / processing / ready-with-inline-
  player / failed). Wired into `AddBlockMenu`, `BlockFrame` (icon+label), and
  `LessonWorkspace` (`BlockBody` case + Mux-cleanup on delete). The ready card
  distinguishes an MP4 still `preparing` (shows "Preparing high-quality preview…")
  from one genuinely `disabled` (an honest "Preview isn't available" — never a
  forever-loading spinner). **`VideoPreviewPlayer` presents a NON-DESTRUCTIVE trim
  as the actual clip:** instead of native controls (which show the full source
  timeline and just pause partway — making a trim look broken), it renders a branded
  control bar whose scrubber / elapsed / total are all window-relative and clamps
  playback to `[trimStart, trimEnd]`; the shown duration everywhere is the trimmed
  length (`trimmedDurationSeconds`). The `VideoTrimEditor` still uses a full-timeline
  native `<video>` (you WANT the whole timeline while picking start/end).
- **Captions & transcripts — Mux auto-generated (2026-07-02):** English captions are
  requested **by default at upload** — `new_asset_settings.inputs[0].generated_subtitles`
  (for a direct upload the first input **omits `url`**; verified against Mux docs, do NOT
  guess — see the video-captions memory). Generation is **asynchronous** and NEVER blocks
  playback (Mux transcribes after ingest; the text track lands in `preparing` then
  `ready`). Detected by BOTH the poll AND the **`video.asset.track.ready`** webhook (the
  route re-fetches the asset + reconciles, so it's event-name-agnostic). `parseWebhookEvent`
  routes a **track** event by `data.asset_id` (its `data.id` is the TRACK id, not the
  asset). **On-demand path** = `POST /api/video/mux/generate-captions` → provider
  `requestGeneratedSubtitles(assetId, audioTrackId, …)` (`POST /video/v1/assets/{id}/tracks/
  {audioTrackId}/generate-subtitles`) for a video uploaded before captions-by-default or a
  retry. **Caption state** = `caption_status` (`none`|`generating`|`ready`|`failed`) +
  track id/name/language/source on `video_assets` (migration `20260702010000`); mirrored to
  the block as `VideoLessonBlock.captions` METADATA via `UPDATE_VIDEO_LESSON` (the heavy
  **transcript** text stays on the row + rides in the view — kept OFF the course doc to keep
  it lean). Once a track is `ready`, `syncVideoAssetFromMux` fetches the WebVTT
  (`https://stream.mux.com/{playbackId}/text/{trackId}.vtt`, public, no auth), derives a
  plain transcript (`lib/video/captions.ts` `parseVtt`/`plainTextFromVtt`), and stores both
  `transcript` + `transcript_vtt` (for future AI: summaries/chapters/quizzes/timestamped
  help). `isActiveVideoStatus` keeps polling while captions `generating`. **Display:** NO
  Mux Player (keeps the 14-dep invariant + the trim-aware player) — `VideoPreviewPlayer`
  renders a **synced caption overlay** from the parsed cues with a CC toggle (respects the
  trim window since playback time is clamped). The manage panel has a **Captions & transcript**
  section (status + Generate/retry + read-only transcript preview). **Extension points left
  clean:** manual correction, WebVTT export (`captionVttUrl`), re-uploaded/translated tracks
  (`caption_source: "uploaded"`), transcript-based editing, Mux Player.
- **Trim UI (2026-07-02):** the two start/end sliders were replaced by an Apple-Photos-style
  **filmstrip trimmer** (`VideoTrimEditor`) — a thumbnail strip with a **double-ended
  selection frame** whose handles you drag; dragging a handle **seeks the preview to that
  frame** so you see where you're cutting. Thumbnails come from the Mux image API
  (`thumbnailAt`) for a ready asset, or **canvas frame-capture** for a local pre-upload clip.
  Commits on release (one autosave/undo step). The "Done trimming" button is now a filled
  brand **"Save changes"** (was a ghost button that blended in). Handles use `role="slider"`
  + arrow-key nudge; refs are synced in an effect (React 19 forbids ref writes in render).
- **⚠ Compositor must NOT be rAF-driven (2026-07-15, found on a real frozen
  lesson):** `requestAnimationFrame` is fully suspended in a backgrounded tab,
  and screen-mode recording means the studio tab IS backgrounded — the canvas
  stopped repainting and MediaRecorder encoded one frozen frame + live audio
  for the whole take. The draw loop now runs on `lib/editor/
  backgroundTicker.ts` (a dedicated-Worker `setInterval` at 30fps — worker
  timers are visibility-throttle-exempt; rAF only as a degraded fallback).
  Never revert the compositor (or any recording-critical loop) to rAF.
- **Tests:** `npm run verify:video` (162 checks, no key/DB/browser — incl.
  `backgroundTicker.spec`: worker ticks/stop/fallback + the grep pinning the
  compositor to the ticker) — schema +
  persistence round-trip, the `UPDATE_VIDEO_LESSON` reducer, status machine +
  `reconcileMuxState`, trim validation + `trimmedDurationSeconds`/`hasTrim`, playback
  URLs, row→view mapping, recorder config/geometry, the Mux adapter (create/get/delete
  + webhook HMAC) via a mocked fetch, incl. **`highest` is requested**, the
  **mp4_support:none + ready highest.mp4 → ready** regression guard, a **skipped
  rendition → `disabled`** (not forever-preparing), a **per-file `preparing` → keep
  polling**, `addMp4Rendition` (POSTs highest, swallows "already exists" 400 but
  re-throws others), the **self-heal** (a ready video with no MP4 re-requests a
  rendition; audio-only and adaptive-already-present do not — no loop), AND the whole
  **captions surface**: `parseVtt`/`plainTextFromVtt`/`activeCaption`, `deriveCaptionFields`
  + caption reconcile, block-captions schema/patch/round-trip, `createDirectUpload` requests
  `generated_subtitles`, `getAsset` normalizes caption tracks + audio track id,
  `requestGeneratedSubtitles`/`fetchCaptionVtt`, the **track.ready webhook routes by
  `asset_id`**, and `syncVideoAssetFromMux` fetching + storing the transcript once (settled
  captions short-circuit). React 19 note: the studio avoids setState-in-effect (screen is
  derived; the recorder fires an `onRecordingComplete` event) and never writes refs during render.
- **Out of scope / extension points (left clean):** the student-facing player,
  chapters, AI summary/quiz-from-video (the stored transcript is the hook), progress
  tracking, and Mux Data analytics (the HLS URL + `NEXT_PUBLIC_MUX_DATA_ENV_KEY` are the
  hooks for a future Mux Player upgrade). The asset goes `ready` as soon as it's playable;
  the MP4 static rendition (used by the native `<video>`) fills in shortly after via
  continued polling, so the card shows the poster + "Preparing high-quality preview…" for
  a beat before the video appears. Captions fill in independently, never blocking playback.
## Marketing Assistant suite (`lib/marketing/*`) — 2026-06-19

The second half of the product: turn a finished course into a go-to-market
engine. Full engineering guide in `docs/marketing-suite.md`; PRD in
`docs/prd/Marketing-Assistant-Creator-Studio-Web.html`; per-phase detail in
CHANGELOG. Built on **three spines**: ONE typed tool layer
(`lib/marketing/tools/*`, `executeMarketingTool` behind the Generate-Kit button,
the hub cards, AND the agent), ONE event stream (`analytics_event`; subscriber
status is a pure reducer over it — `lib/marketing/stateMachine.ts`), ONE
**reversibility-graded governance gate** (`lib/marketing/gate.ts` +
`marketing_action` ledger: read executes; reversible executes + before-snapshot;
irreversible routed by the autonomy engine — see below).
Mock-first: `lib/marketing/services/*` (EmailProvider/Clock interfaces + mock +
env-gated factory; **Resend** swaps in via `RESEND_API_KEY`, zero contract
changes). The Marketing Agent (`lib/marketing/agent/*`) reuses the studio's
provider-agnostic `ModelClient`: observe (funnel injected as a developer msg) →
act (every tool call through the gate) → **pauses** whenever the gate blocks on
a human (approval OR clarifying question — ONE blocked shape).

**Autonomy redesign (2026-07-03, full detail `docs/marketing-autonomy.md`):**
grades (what CAN be undone) and **autonomy modes** (HOW approval is obtained)
are orthogonal. **Reversible tier, unconditional:** executes + lands as a QUIET
dismissible activity-log entry with a one-click Revert for a configurable
window (`revert_expires_at`, default 24h; `rejectAction` refuses past expiry —
fail closed; never a blocking Accept/Reject card, in any mode). **Irreversible
tier** routed by the PURE, deterministic policy engine
(`lib/marketing/autonomy.ts` + IO in `autonomyStore.ts`, per-course
`marketing_autonomy_settings`): `manual` = always one card · `assisted`
(default, = no settings row) = card, but ambiguous targeting raises a
**clarifying question** first (tool hook `clarifyTargeting`; today on
send_broadcast/enroll_segment_in_sequence when `status` is null over a mixed
audience — `"all"` is the EXPLICIT everyone value so answers never re-trigger)
and an owner-addressed `send_test_email` auto-logs (`ownerEmail` on ctx, gate
falls back to auth.getUser; foreign address stays carded) · `auto` =
auto-executes ONLY on a clean policy match (opt-in tool allowlist + recipient
cap + allowed hours + first-send-to-new-segment history in
`marketing_segment_send`; EVERY unset field fails closed — the empty policy is
inert; full guardrail audit persisted as `marketing_action.autonomy_decision`).
**Hard-deny list checked FIRST** (engine + gate, defense in depth):
`launch_campaign`/`cancel_campaign`/`send_consent_confirmations` never
auto-approve under any mode/policy. **`ask_creator`** = the model's own
clarifying-question tool (2–5 options; `interaction:"question"`, gate-resolved,
execute never runs); both question sources + approvals pause the loop through
one `agent_blocked {kind}` event and resume via `agent/resume.ts` (3 paths:
approve / deny / `resumeAgentAfterAnswer` — same conversation, one turn).
**One-card approval** (`components/marketing/ApprovalCard.tsx`, used by chat +
hub + builder + leads): inline preview (`effectLabel`/`bodyPreview` on tool
previews; hub/builder re-run the side-effect-free preview server-side via
`previewMarketingAction` so counts stay current), exactly Approve-&-effect /
Edit (`editableParams` + `editPendingAction`) / Reject; request buttons return
the pending payload so the card renders in place (no scroll-to-inbox);
`approveMarketingAction` claims `pending→'approved'` atomically (double-click
⇒ "already resolved"; failed execute releases back to pending). Settings UI =
`components/marketing/AutonomySettings.tsx` on the hub (hard-denied tools
render locked; server strips them again regardless).

**Audience + agent-surface QoL (2026-07-03, same-day follow-up):**
**Audience tools** — `build_audience_list` (create + fill a list from EXISTING
contacts in one step, filter = consent × funnel stage, suppressed always
excluded; a confirmed-only list is consent_confirmed at birth),
`add_leads_to_list` (filter OR explicit ids; already-members skipped),
`remove_leads_from_list` — all reversible, all send nothing. The `lead_list`
snapshotter is now **COMPOSITE (row + membership)** so reverting any
membership edit (incl. `import_leads` — previously a silent row-only revert)
restores membership byte-for-byte; legacy bare-row snapshots still restore.
`lead_list_member` was missing its UPDATE policy (restore's upsert hits
ON-CONFLICT-UPDATE → RLS) — fixed in migration
`20260703120000_lead_list_member_update_policy.sql`. The system prompt now
TEACHES the audience capability ("never claim you can't put existing contacts
on a list" — the exact observed failure). UI: `components/marketing/
ListBuilder.tsx` (live-counted consent×stage slicing, new-list or
add-to-existing) sits prominently on BOTH `/marketing/leads` and
`/marketing/audience`; `removeLeadFromListAction` now routes through the gate
(was the one direct-delete bypass). **Agent dock** — `app/(app)/marketing/
layout.tsx` mounts `components/marketing/agent/AgentDock.tsx` (floating "Ask
the agent" pill → right slide-over hosting the SAME AgentPanel; panel stays
mounted on close so the transcript survives; hidden on /marketing/agent + the
campaign builder which embed their own) + a prominent **ask-bar** with
suggestion chips at the top of the hub that seeds the dock
(`lib/marketing/agentDockStore.ts`, `AgentPanel` `seed`/`onSeedConsumed`
one-shot autosend). **Questions** — every QuestionCard now has a
"Something else…" free-text path (`value: "__other__"`); `answeredMessage`
hands the creator's words to the agent verbatim (may redirect the plan, never
coerced into an option); user-path gate questions skip the tool retry for
freeform answers.

**Autonomous Email Campaign layer (2026-07-02, PRD amendments 1–15 implemented in
code):** goal-driven sequence **blueprints** (6 goals, launch = 5 emails default,
4–7 range; `lib/marketing/blueprints.ts`) · mechanical **copy quality rubric**
(advisory-only; `quality.ts`) · **Campaign Brief** (`config.brief`) + creator
**voice profile** (`voice_profile` table) grounding an **LLM-backed
`generate_email_sequence`** (`email/llmGenerate.ts`, falls back to blueprint
templates without a key) · consent-first **lead lists + double opt-in** (import
requires the exact consent text; pending → confirmed via signed link or →
lapsed after 30d; `tools/leads.ts`, `consent.ts`; **contacts are COURSE-level
— `subscriber.campaign_id` is nullable (migration 20260702120000; the old NOT
NULL made every campaign-less import silently fail), dedupe is course-wide,
and `send_consent_confirmations` bulk-asks a whole list under ONE approval,
resolvable inline on the Leads page**) · **signed tokens** for
click/unsubscribe/consent links (`tokens.ts`, `MARKETING_TOKEN_SECRET`) ·
**click attribution + 7d last-click enrollment attribution** (`attribution.ts`)
· behavioral **segments + read-time engagement score + lead profile**
(`segments.ts`) · **hard/soft bounce taxonomy** (soft retries 3× w/ backoff →
escalates; mock bounces are ADDRESS-triggered: `hard-bounce`/`soft-bounce` in
the address) · **guardrail auto-pause** (hard-bounce >2%, complaint >0.1%,
unsub >1%, only at ≥50 sends) + **per-creator send ramp** (200/500/2000 per day;
held sends stay queued) (`guardrails.ts`) · **send windows** (default 9–11
creator-tz weekdays; scheduler holds outside) · **campaign lifecycle** draft→…→
completed with per-step approval, edit-after-approval → back to review (enforced
in `write_email_touch`), a launch-checklist predicate + approved-audience
snapshot (`campaignLifecycle.ts`), and the compliance+quality gate
(`tools/compliance.ts`; blocking: consent/sender+mailing-address/CTA-resolution/
merge-var-fallbacks/fake-urgency; quality never blocks) · **agent auto-resume**
after approve/deny (`agent/resume.ts`) · click-first, **MPP-honest analytics**
(clickRate per delivered is primary; openRate carries a caveat) · localized
compliant footers (8 locales, `language.ts`).

- **DB:** migrations `20260618000000_marketing_assistant.sql` (9 tables) +
  `20260622000000_marketing_account_tier.sql` (`audience_contact`; creator-wide
  unsubscribe) + `20260702000000_email_campaign_agent.sql` (campaign lifecycle
  columns, `email_touch` step fields, `scheduled_send` bounce counters,
  `subscriber.consent_status`, new event types, and `lead_list`/
  `lead_list_member`/`sender_identity`/`follow_up_rule`/`voice_profile`) +
  `20260703000000_marketing_autonomy.sql` (`marketing_action.revert_expires_at`
  + `autonomy_decision`; `marketing_autonomy_settings`/`marketing_question`/
  `marketing_segment_send`), all
  RLS via `private.is_course_author(course_id)` (voice_profile:
  `author_id = auth.uid()`). Public lead/analytics writes go through the
  **service-role** ingest route, not anon RLS.
- **Routes:** public `/p/[slug]`;
  `app/api/marketing/{ingest,agent,scheduler/tick,unsubscribe,click,consent-confirm,webhooks/resend}`.
  Creator UI: `app/(app)/marketing/{page,actions,campaignActions,MarketingHub,analytics,agent}`
  + **`email/` (campaign list · `new/` wizard · `[id]/` builder)** +
  **`leads/` (lists + consent-gated import · `[id]/` lead profile)** +
  `components/marketing/agent/AgentPanel`.
- **Env:** `SUPABASE_SERVICE_ROLE_KEY` (ingest/tick/click/unsub/confirm;
  server-only), `RESEND_API_KEY`/`RESEND_FROM` (real email; **RESEND_FROM MUST
  be an address on the Resend-verified domain** — a freemail address makes
  every send throw "domain is not verified"; sender identities only skin the
  From DISPLAY NAME + set Reply-To via `composeFromHeader` in
  `services/resend.ts`, they can never point sending at an unverified domain).
  **`composeFromHeader` cleans `envFrom` via `cleanEnvValue` (2026-07-07, from
  a live "Invalid \`from\` field" — worked locally, broke only on Vercel):** a
  `.env`-style `RESEND_FROM="Name <you@x.com>"` has dotenv strip its quotes
  locally, but Vercel's dashboard does NOT strip a pasted value's quotes — the
  literal `"..."` reached Resend and failed its parser. `cleanEnvValue` trims +
  strips one layer of wrapping matching quotes at the one call site (fixes it
  in code, no dashboard edit required); a still-malformed `from` gets a second
  error branch naming the exact composed header + raw env value. **The bug
  only reached prod via `send_broadcast`** because `scheduler.ts:sendBroadcast`
  never loaded the campaign's sender identity (unlike `runSchedulerTick`) — no
  `fromName` meant `composeFromHeader` fell straight to the raw quoted env
  value instead of reconstructing a clean header, AND every broadcast silently
  dropped the sender's display name/Reply-To/mailing-address footer and left
  any `{{ctaUrl}}`-style merge token unresolved. Fixed alongside: `sendBroadcast`
  now caches sender identity + CTA destination + locale PER CAMPAIGN
  (course-level contacts can span several) and builds the full merge-var
  context, matching `runSchedulerTick`.
  `RESEND_WEBHOOK_SECRET` (delivery webhooks), `MARKETING_TOKEN_SECRET` (link
  signing — required before real sends), `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`.
  All optional in dev — absent → the engine runs mock/author-scoped.
  Approval failures (e.g. a provider config error) return an error
  `ActionResult` and leave the action PENDING/retryable — they never crash to
  the error boundary; `create_sender_identity` is idempotent on identical
  fields (double-submit guard).
- **Creator UX (2026-07-03 overhaul):** the builder is a **guided stepper**
  (Audience → Sender → Review emails → Compliance → Launch) with interactive
  Audience/Sender cards (attach an existing list / create+attach a sender
  inline — previously only settable in the wizard), course analysis demoted to
  a collapsed left-column card, and a **Delivery card** when launched
  (queued/sent/failed + next-due + a "Process due sends now" button →
  `processDueSendsAction`, the same idempotent course-scoped tick cron runs).
  Approving a launch fires one immediate scoped tick (dev has no cron). The
  Leads page spells out the 3-step consent flow, resolves consent-send
  approvals inline, and each list card has an "Ask N contacts to confirm"
  bulk button; the import panel reuses a mid-submit-created list on retry
  (the old flow created duplicate lists and swallowed the error).
- **Delivery-timing honesty (2026-07-04, from live usage):** a creator
  launched at 23:41 local, saw "4 subscribers will begin receiving", and got
  no email — the sends were HELD by the default send window (9–11 **UTC**
  weekdays) with nothing saying so, and dev has no cron to deliver them when
  it opens. Fix: pure helpers in `scheduler.ts`
  (`sendWindowState`/`describeSendWindow`/`sendTimingSentence`,
  `withinSendWindow` now exported; `DEFAULT_WINDOW` = the types'
  `DEFAULT_SEND_WINDOW`); every summary that enqueues sends
  (launch_campaign preview + executed, activate_sequence,
  enroll_segment_in_sequence) appends the timing sentence ("HELD until the
  send window opens (09:00–11:00 UTC, weekdays); next opening …"), launch
  `data` carries `nextWindowOpensAt`; the builder Delivery card shows a
  server-computed held-now callout (`sendWindowInfo` prop — computed with the
  injected clock, NEVER `Date.now()` in render: react-hooks/purity flags it
  even in server components); the agent prompt gained an **END OF RUN**
  wrap-up contract ("Enqueued is NOT sent" — what happened / what's true /
  what happens next WITH timing / what awaits the creator) and the approve
  resume message demands that wrap-up.
- **Email CTA destinations + site-URL guard (2026-07-06, from a live 404):**
  `lib/marketing/ctaDestination.ts` — email CTA → the course preview
  **`/learn/{slug}`** when a LIVE publication exists, else the landing page
  `/p/{slug}` (list traffic goes to the CONVERSION surface, never back to the
  capture form); `{{freeLessonUrl}}` stays on the capture page. Resolved at
  SEND time (scheduler, cached per course+campaign) AND generation time, so
  publishing upgrades queued sends. `{{ctaUrl}}`/`{{freeLessonUrl}}` merge
  vars are REAL now (were hard-coded null — LLM-authored buttons leaked a
  literal `{{ctaUrl}}` into the click link); compliance validates hrefs AS
  RENDERED + `siteUrlFinding()` (unset/garbage/vercel.com = BLOCKING —
  vercel.com is the dashboard, never an app origin; localhost = warning).
  Click route resolves relative destinations against the request origin
  (NextResponse.redirect rejects bare relatives). **Send time is
  AUTHORITATIVE over baked hrefs (2026-07-07, from a second live incident —
  emails landed on the HOMEPAGE):** template bodies bake `ctaPath ?? "#"` at
  generation, so `resolveSendTimeButtonHref` (same file) rewrites every
  button href inside `prepareBodyForSend` — dead hrefs (`#`/``/`/`/
  unresolved token) rescue to the current ctaUrl, a baked landing path
  upgrades to `/learn` once published, `{{freeLessonUrl}}`-authored buttons
  stay on the capture page; compliance validates through the same function.
  **A fabricated internal path is ALSO rescued now (2026-07-07, third live
  incident — `send_broadcast` sent a real 404):** a DB query of
  `marketing_action` showed the agent hand-writing `/courses/{id}` and
  `/courses/{id}/preview` button hrefs — routes that don't exist anywhere in
  the app — while its `send_test_email` calls correctly used `{{ctaUrl}}` (its
  tool description happened to mention merge vars; `send_broadcast`'s didn't).
  `resolveSendTimeButtonHref` now rescues ANY relative href that isn't
  `/learn/*` or `/p/*` (the app's only two real public destinations) the same
  way it rescues a dead href — protects every send regardless of what
  authored the bad link. Root-cause prevention: the agent system prompt
  (`agent/prompt.ts`) gained a "LINKING TO THE COURSE" rule — never hand-write
  a course URL, always `{{ctaUrl}}`/`{{freeLessonUrl}}` — and
  `send_broadcast`/`send_test_email`/`write_email_touch` descriptions repeat
  it locally. **Approval-preview transparency**: `bodyPreviewText`
  (`tools/email.ts`) now shows a button as `[Label → href]`, not just
  `[Label]` — the creator can catch a wrong destination before approving (it
  was previously invisible, same class of gap as the earlier approve-flow
  fix). `verify:marketing:cta` (50) — incl. a full reproduction: `send_broadcast`
  with the incident's exact fabricated href, asserting the preview shows it
  and the mock-delivered email wraps the real `/learn/{slug}` link. ⚠ tsx does
  NOT auto-load .env.local — suites that run the compliance tool must set
  NEXT_PUBLIC_SITE_URL themselves (campaign suite does).
- **Approval sync + stop controls + hub redesign (2026-07-06, see CHANGELOG +
  docs/marketing-autonomy.md § Cross-surface sync):** the same approval used to
  render in chat AND hub with no invalidation — now `lib/marketing/
  approvalSync.ts` (zustand resolution store keyed by actionId/questionId +
  BroadcastChannel) collapses every copy on one resolution; stale clicks
  return `alreadyResolved` (no more approve-throws/deny-lies asymmetry);
  `marketing_action.conversation_id` (migration `20260706`)
  makes the resume land in the paused thread deterministically.
  **Fast-resolve + background follow-up (2026-07-07, from a live "approve
  button doesn't work"):** approve/deny/answer server actions return the
  MOMENT the effect is done (never await the resume — the old inline resume
  spun the button for the whole model run, indefinitely on a stalled
  transport since the marketing loop had no `timeoutMs`); the agent's wrap-up
  runs in `fetchAgentFollowUpAction` (fired by the card post-collapse,
  decision derived from the ROW, 180s ceiling) and lands via
  `attachActionFollowUp`/`attachQuestionFollowUp` on the sync store
  (`applyRemote` lets a follow-up-carrying copy fill a null — the ONE
  exception to first-writer-wins); AgentPanel replays through its existing
  subscription. The loop's `runTurn` now sets
  `MARKETING_AGENT_TURN_TIMEOUT_MS` (default 120s) — no marketing model call
  can hang unbounded. Approve/deny/answer FAILURES render INLINE in
  ApprovalCard/QuestionCard (rose alert w/ the provider's message — the agent
  chat has no toast, so errors used to be invisible: a prod misconfig read as
  a dead button). Stop controls:
  new reversible `pause_sequence`/`resume_sequence` (resume refused under a
  paused/cancelled campaign — scheduler keys off SEQUENCE status);
  pause/resume/cancel campaign are campaign-WIDE now (were primary-sequence-
  only) + resume clears `autoPauseReason`; `LifecycleControls.tsx` renders
  them on the hub `CampaignCard`, campaign list rows, sequences list/detail;
  prompt teaches "STOPPING THINGS" (pause for ambiguous "stop", cancel is
  permanent + carded). Hub: one "Needs your attention" zone → work column
  (CampaignCard + landing pages) + quiet rail (compact Explore nav; Recent
  changes + Autonomy in `CollapsibleCard`s persisted via
  `lib/marketing/hubUiStore.ts` skipHydration). New PURE suite
  `verify:marketing:sync` (50, in `npm test`).
- **Verify:** `verify:marketing` (gate 37), `:flow` (18 — ingest needs the
  service key), `:analytics` (13), `:email` (34), `:agent` (22, mock model —
  incl. the one-pause-shape `agent_blocked` for approvals AND questions),
  `:swap` (7), `:landing-edit` (11), `:account` (10), `:sequences` (10),
  **`:campaign` (112 — the whole amendment set end-to-end, incl. campaign-less
  import + course-wide dedupe + bulk consent + From-composition/Reply-To
  threading + sender idempotency + owner test-send auto-log)**,
  **`:autonomy` (93 — every redesign invariant: unknown-tool fail-closed +
  registry drift guard, hard-deny × mode × policy, deny-never-executes,
  each guardrail failing alone blocks, reversible never pends, revert window,
  governance language, question pause/resume parity, approve race, segment
  history)**, **`:lists` (31 — audience filters, byte-for-byte membership
  revert incl. the import-revert regression, legacy snapshot back-compat,
  agent-driven list build, "__other__" answer messages)**, **`:sync` (50,
  PURE no-key — followUpFromEvents fold, approvalSync store/broadcast incl.
  the late-attach + remote fill-in matrix, lifecycle registry +
  prompt-teaching invariants; in the `npm test` chain)**. All others
  self-provision a throwaway live-Supabase user.
  **440 checks green (2026-07-06).** NOTE for suites on a `fixedClock`: pass
  `{ nowIso: services.clock.now() }` to `rejectMarketingAction` when reverting
  staged rows — the gate stamps windows from the injected clock but reject
  defaults to wall-clock.
- **Status:** all phases + the campaign layer verified green, including
  anonymous ingest (the service key had been stored under a typo'd env-var name
  — `UPABASE_…` — since setup; fixed 2026-07-02).

## Social Post Generator (Marketing Phase 1) — `lib/marketing/social/*`, 2026-07-06

> Guide: **`docs/social-posts.md`** · PRD: `docs/prd/Social-Media-Post-Generator-Marketing-Web.html`.
> Phase 1 = the generation backbone: 1–5 grounded, voice-true, funnel-staged
> **LinkedIn/Facebook** drafts the creator posts MANUALLY. Hard fences (grep-
> tested in `verify:social`): no platform APIs/OAuth, no email imports, no
> scheduler (nothing fires from `planned_post_at` — it's a label the Phase 3
> scheduler will read under the same name), no AI images, **no approval cards**
> (every tool is read or reversible), no new runtime deps. Instagram is
> deliberately OUT until image/video gen ships (platform enum closed at 2).

- **Tables** (migrations `20260706120000` + `20260706120100`): `social_post`
  (SOFT delete only — zero delete policies; `version` int for optimistic
  writes), `social_post_batch` (grouping/audit/idempotency/daily-budget
  counting; unique partial (creator, idempotency_key)), `social_voice_profile`
  (derived+versioned jsonb; DISTINCT from the email `voice_profile` rules
  table, whose rules feed the derivation; alone has a delete policy — the
  gate's revert-of-create needs it). Transactional persist =
  `social_create_batch` SQL function, SECURITY **INVOKER** (RLS applies,
  atomicity + in-DB Idempotency-Key replay incl. the unique-race path).
  13 `social_*` event types on the single `analytics_event` stream (TS union
  in lib/marketing/types.ts + DB check extended TOGETHER).
- **Pipeline** (`generate.ts`): context (reuses `loadCourseMarketingContext` +
  module/lesson narrowing, `SOCIAL_CONTEXT_MAX_TOKENS` budget) → voice
  (`ensureSocialVoiceProfile`, derive-on-first-use) → byte-stable prompt
  prefix (`prompt.ts`, `PROMPT_VERSION` stamped in ai_metadata everywhere) →
  ONE structured call (withSemaphore, `SOCIAL_GENERATION_TIMEOUT_MS` 180s
  hard ceiling — quality-first, NOT a latency target) → Zod gate + exactly ONE
  repair (mock-testable via the `social_post_batch_repair` responseFormat
  name) → deterministic lint (`lint.ts`, creator context whitelists its own
  claims; flagged drafts repair-or-DROP w/ surfaced reason) → RPC persist →
  events → per-draft `onDraft` (SSE). No model ⇒ `templates.ts` grounded
  fallback (`model:"template-fallback"`). Slot plan (`buildBatchPlan`) wins
  over model-echoed goal/stage/tone; hashtags CLAMP to the platform max.
- **THE versioned-write rule**: all content updates go through ONE function
  (`repository.ts · versionedUpdateSocialPost` — `…set version=version+1
  where id=$1 and version=$2 and deleted_at is null`); 0 rows ⇒
  `SocialVersionConflictError` ⇒ 409 / an agent message teaching re-read +
  re-apply. Deliberately NOT a DB trigger (the gate's restore upserts
  before-snapshots verbatim, version included). Lifecycle/performance/image
  columns are non-versioned by design. `verify-social.ts` greps writes down
  to repository.ts + entities.ts.
- **19 tools** (`tools/socialPosts.ts`): 5 read (`list_social_posts`,
  `get_social_post`, `get_social_voice_profile`, `suggest_hashtags`,
  `draft_image_alt_text`) + 14 reversible writes (generate/revise/tone/
  regenerate/variant/create/update/delete[soft]/status/attach_image/
  remove_image/rewrite_for_platform/planned_time/performance). Composite
  `social_post_batch` snapshotter (batch+posts) restores sets byte-for-byte;
  revert-of-create ARCHIVES (soft-delete-only). Variants ALWAYS ride a batch
  (one is created for batch-less posts) so the set reverts as one unit.
  REST mutations also go through `executeMarketingTool` → revert-log entries
  for UI edits + the revision budget counts `marketing_action` (RLS scopes it
  per creator). Agent prompt: "SOCIAL POSTS" (Cursor loop: inspect →
  versioned edit → explain-why) + "MANUAL PUBLISHING" honesty sections.
- **Routes**: `/api/marketing/social-posts/{generate[SSE+Idempotency-Key],
  ,[id],[id]/(revise|tone|regenerate|variants|rewrite|status|performance|
  image|hashtags|alt-text|track)}` + `/api/marketing/social-voice-profile`
  (+`/regenerate`, 409 `needs_confirm` over creator edits). Typed errors:
  409/429/502(stage)/503. UI: `/marketing/social` (hub Explore entry) —
  collapsing generator, streaming skeletons, batch-grouped queue, editor
  (counters import `PLATFORM_LIMITS`, never copy), voice sheet, ONE
  `ManualPublishNotice` component (the language rules live in one place),
  error card retains parameters for Retry, 409 → refetch + re-apply once +
  toast. Image uploads: client → private `social-post-images` bucket
  (`{uid}/social/{postId}/…`) → finalize validates by MAGIC BYTES
  (`imageMeta.ts`, dependency-free PNG/JPEG/WebP dims) + soft norm warning.
- **Tests**: `npm run verify:social` (127 pure, in `npm test`) ·
  `verify:social:int` (59 vs live Supabase + mock model — full pipeline,
  reverts byte-for-byte, RLS matrix, agent turn zero-pause). ⚠ zod v4 THROWS
  at runtime on `.omit()/.extend()` over a refined schema (export the base
  object separately — TS won't catch it, the build's page-data collection
  does). ⚠ Node prefers supabase.co's broken-here IPv6 — int scripts pin
  `dns.setDefaultResultOrder("ipv4first")`.

## Lesson Clip Repurposing (Marketing Phase 1.5, M-A) — `lib/marketing/clips/*`, 2026-07-07

> Guide: **`docs/clips.md`** · Task 0 findings: `docs/reap-task0-findings.md`.
> M-A = transcripts + the moment selection engine + eval harness. **Task 0
> ran vs the LIVE Reap API (2026-07-08)**: contract is camelCase
> (`sourceUrl`/`uploadId` — the PRD guessed snake_case); explicit
> `selectedStart/End` exist BUT **Reap enforces a ≥60s window** (our spans
> are 20-90s — top M-B risk; pre-cut-and-upload recommended); NO webhooks in
> the API; NO brand-template API; (d)/(e)/(f) still need one real ≥90s video.
> Hard fences (grep-tested): no platform APIs, no posting/scheduling
> (`/publish-clip` + `/schedule-clips` never referenced), no cron, no
> synthetic media, Phase 1 language rules verbatim.
>
> **Format-aware amendment (2026-07-08, folded into M-A):** recording format
> (`camera_only|screen_camera|screen_only` — the literals ARE the platform's
> `VideoRecordingMode`) is a first-class input: read from the video BLOCK's
> `recording.mode` via the asset's block_id (metadata short-circuits,
> spy-tested); uploads never carry a mode → classifier over ≥8 Mux thumbnail
> frames judged through `ModelClient.inspectImage` (ffprobe NOT installed,
> no face-detection dep — the vision seam is the zero-dep frame source;
> degraded default camera_only/'classifier'); persisted on `lesson_transcript`
> (`recording_format`+`format_source`; `overrideTranscriptFormat` =
> creator_override, cache never re-classifies). `routing.ts ·
> resolveClipLayout` = the ONLY facts→decisions map: camera→face_track ·
> screen_camera→stacked_split · screen_only→ slide_short (sync covers span)
> ≻ screen_action_zoom (action-dense: `actionDensity.ts`, lexicon
> `CLIP_ACTION_CUES` ≥2 cues/min OR frame-diff ≥0.15; degraded = cues alone)
> ≻ audiogram. `layout` on every candidate row (migration `20260708100000`;
> the DB default 'face_track' exists ONLY for pre-amendment snapshot
> restores — code always writes explicitly). Prompt = **clips-v3**:
> ALL formats' visual_interest rules in the STATIC prefix (cache rule), the
> lesson's format in the request block; demo_payoff +1 visual_interest
> (screen_only + dense, applied pre-rubric-bar, capped 5, recorded as
> visualInterestBoosted); hook-slide-ref lint fires ONLY when sync data
> exists. ⚠ **Slide-sync has NO producer** (recorder captures no slide
> timings — exhaustively audited): the contract (`SlideSyncEntrySchema`,
> `loadLessonSlideSync` returns null) + eval fixtures are live, but real
> lessons can't route slide_short until the recorder captures `{slideId,
> atMs}` — an M-F prerequisite. ⚠ `screen_camera` recordings are ONE
> composited canvas track — separate streams never exist on this platform.
> 5 eval fixtures (screen_slides: ≥2 viable, ALL slide_short — binding;
> screen_action → screen_action_zoom on the lexicon alone); `eval:clips
> --live --control` = the FR-8 pre-amendment delta artifact. Milestones
> renumbered: **M-F = the Remotion slide-short provider (NEW), M-G =
> hardening.** The amendment's `*.spec.ts` names map to named verify-suite
> sections (repo has no jest).

- **Pipeline** (`selection.ts`): acquire transcript (cache → Mux caption VTT
  → `TranscriptionProvider` seam [M-B fills]) → context (Phase 1 assembler +
  **quiz-miss concepts** from `rollup_question_stats` — it has `lesson_id`
  directly; question wording joined from draft quiz blocks via the node-id
  invariant) → **`runSelectionCore`** (DB-free; shared VERBATIM with
  `scripts/eval-clips.ts`): ONE mid-tier structured call (sequential
  small-tier map→reduce over `CLIP_TRANSCRIPT_MAX_TOKENS` 24k) → Zod gate +
  exactly ONE repair (deterministic flags may claim it; rubric-only failures
  never do) → deterministic checks (`validate.ts`) → the ONE small-tier
  validation call (coherence ±8s adjust-or-drop, multi-segment NEVER
  adjusted; hook integrity w/ first-supported promotion) → persist
  `clip_moment_candidate` (+ 5 snake_case events on the single stream).
  Selection is model-REQUIRED (typed 503); failures persist NOTHING.
- **⚠ Sentence snapping is load-bearing** (`snapToSentenceBounds`,
  clips-v2): model span timestamps are interpolated guesses off 12s anchors —
  unsnapped spans start mid-sentence and the coherence validator (rightly)
  kills them. The first live eval scored 1 viable / 11 returned before this +
  the coherence calibration (judge reference debt OUTSIDE the clip's time
  window; the clip carries its own footage — "watch this" is fine).
- **Prompts are versioned artifacts** (§8): `CLIP_PROMPT_VERSION` (now
  `clips-v3`) stamped on every candidate; exemplars are repo fixtures
  (`fixtures/exemplars.ts`). ANY prompt change: bump the version → beat the
  baseline on `npm run eval:clips --live` → re-record CI stubs
  (`--live --record` → `fixtures/recordings/`).
- **Governance**: 3 tools in `tools/clips.ts`, ALL reversible (no approval
  cards). Gate entities: `clip_moment_set` (composite over `request_id`;
  revert removes the whole run's set, the transcript cache survives) +
  `clip_moment_candidate` (single-row). `clip_moment_candidate` has a DELETE
  policy for revert-of-create; `lesson_transcript` deliberately has none.
- **DB**: migration `20260707100000_lesson_clips.sql` (applied). ⚠ the live
  DB has unmerged-branch drift (`learning_events.feedback_comment`,
  `learner_messages.delivery_status`…) — after a migration here, SPLICE the
  new tables into `lib/database.types.ts` rather than full-regen, or this
  branch's analytics pages break on foreign nullability changes.
- **M-B render jobs (2026-07-08, see docs/clips.md § Render jobs):**
  `clip_render_job` (migration `20260708130000`; SINGLE write path =
  `transitionRenderJob`, optimistic on `from`; revert = CANCEL never delete —
  cost-ledger rows survive) advanced ONE edge per marketing scheduler tick
  (`processClipRenderTick` — reconciliation IS delivery; Reap has NO
  webhooks). Every job PRE-CUTS the exact span via a temp Mux clip asset
  (`createClipAsset`, zero-dep trim; Reap re-picks inside create-clips
  windows AND rejects stream.mux.com as sourceUrl → upload-only +
  `create-reframe`, whose output rides get-project-clips NOT urls.videoFile).
  D-5: face_track→Reap; stacked_split/zoom/audiogram→in-house ffmpeg
  (`ffmpegArgs.ts` pure builders, REAL renders in verify:clips:render;
  `ffmpeg-static` is a real dependency — ~75MB binary, serverless needs
  outputFileTracingIncludes); slide_short→M-F. stacked_split face band =
  the recorder's OWN `bubbleRect` when metadata exists (provenance
  'deterministic', D-3) else one vision call ('detected'). D-1:
  `lib/marketing/brand/tokens.ts` = the ONE brand-constant module
  (divergence-checked). Quotas server-side: 10 submits/min bucket
  (submitted_at), CLIP_JOBS_PER_DAY 20, CLIP_MINUTES_PER_MONTH 60 (ONE
  ledger: provider billedDuration verbatim + in-house minutes×rate).
  Tools: generate_lesson_clips (idempotency `gen:{cand}:{preset}`,
  "QUEUED IS NOT RENDERED") · cancel_clip_job · list_clip_jobs — all
  reversible/read. Burned captions on in-house layouts arrive with M-F's
  Remotion caption engine (deliberate; provider face_track ships captioned).
- **Tests**: `verify:clips` (199 pure, in `npm test` — incl. the amendment's
  named spec sections) · `verify:clips:render` (52 — provider contract vs
  the T0 findings, state machine, golden ffmpeg args, brand divergence,
  REAL ffmpeg renders of all 3 in-house layouts, D-3 provenance spies,
  fences) · `verify:clips:int` (64, live Supabase + mock model — incl.
  metadata-short-circuit spy, upload classification, override flip, layout
  round-trip, gate-staged render jobs + idempotent replay + revert-cancel +
  the full queued→precutting→submitted→completed lifecycle vs real
  DB/storage with fake provider/precut/ffmpeg + token-bucket hold + RLS) ·
  `eval:clips` (live/record/replay/control; the flat-affect ≥2-viable gate
  is the differentiator claim + the FR-8 layout gates). REST:
  `POST/GET /api/marketing/lessons/[lessonId]/clip-moments`.
- **ALL MILESTONES SHIPPED (2026-07-14)** — Task 0 (live: camelCase,
  ≥60s-window = Reap RE-PICKS → pre-cut + create-reframe only; sourceUrl
  rejects stream.mux.com → upload-only; billedDuration = selected minutes;
  faces-only tracker pan-crops PiP → in-house layouts) · M-C ingest
  (`social_post.post_type='clip'`, platform enum extended w/ a text-posts
  row gate, lineage `regenerated_from_post_id`, artifacts/
  m-c-in1-stacked-split.mp4 = the real cs61b lesson end-to-end) · **M-R
  recorder capture** (slideSync producer + minimized REC pill, pipGeometry
  D-3, dual-track flag D-4 — recording.slideSync/pipGeometry/
  dualCameraAssetRowId, all optional/back-compat; loadLessonSlideSync is
  REAL) · M-D posting kit (`postingKit.ts` — disclosure CODE-inserted,
  keyword suffix-walk + partial unique index, /l/{code} re-resolves at
  CLICK time + threads ?ref → recordClipEnrollment, /preview/{code} w/ the
  answer-key-invariant grep) · M-E `/marketing/clips` UI (FR-9 chips,
  audiogram caveat, signed-URL player, kit panel, usage meter) · **M-F
  Remotion slide-short provider** (`render/slideShort/*` — pure
  StructuredSlide-dispatch mirror + element-fallback card, kinetic captions,
  hook/end-card, app globals.css via @remotion/tailwind-v4 + @ alias;
  serverExternalPackages keeps the stack out of the Next bundle;
  CLIP_RENDER_WORKERS pool outside the LLM ceiling; license trigger = 4th
  hire; deps now 20) · M-G hardening (reconciliation chaos, wordErrorRate,
  seed:clips, full-chain green). Suites: verify:clips 199 ·
  verify:clips:render 114 · verify:clips:slideshort 14 (REAL renders, in
  npm test) · verify:clips:int 85 · eval replay PASS.
- **First-live-usage fix pass (2026-07-15, docs/clips.md § First-live-usage
  fixes):** (1) the ROOT bug was the RECORDER — the screen+camera compositor
  was rAF-driven and Chrome suspends rAF in backgrounded tabs (recording
  another window = tab always hidden) → 6 min of ONE frozen frame + live
  audio; fixed with `lib/editor/backgroundTicker.ts` (dedicated-Worker
  interval, visibility-immune; rAF only as fallback) — pre-fix recordings
  are unfixable, re-record. (2) dev delivery: jobs only advanced on manual
  clicks → `POST /api/marketing/clips/tick` (creator-scoped sweep) polled
  by the clips page every 5s while jobs are active (prod cron unchanged;
  user-triggered polling ≠ cron). (3) `static_video` guard at job creation
  (3 span thumbnails byte-identical on a camera-bearing format ⇒ refuse
  before billing; screen_only exempt — static slides are legit). (4)
  provider 4xx: ReapError stringifies structured detail (was "[object
  Object]") + carries `permanent` (not 408/429/upload-put); the step
  handler FAILS the job via seam-level `isPermanentProviderError`; failJob
  now cleans temp precut assets; the int suite creator-scopes its sweeps +
  a leak guard cancels its rows even on crash (a leaked fake-ref job had
  been 422-polling the real Reap API on every prod tick). (5) idempotency
  index made PARTIAL over live/completed (migration `20260715100000`) —
  failed/cancelled jobs no longer block "Render again" (UI shows the error
  + retry button). ALSO: clip ingest now inserts via the social REPOSITORY
  (`insertSocialPost`) — the M-C direct insert violated verify-social's
  single-write-module grep and the failure had been masked by piped exit
  codes; verify:social + verify:video 162 (backgroundTicker.spec). (6) the
  social queue crashed on the FIRST ingested clip post: clip rows carry
  instagram/tiktok/youtube_shorts but `PLATFORM_LIMITS` is the text contract
  (closed at 2) — every loaded-post path now uses **`platformLimitsFor()`**
  (total over `POST_PLATFORMS` = text ∪ `CLIP_POST_PLATFORMS`, backed by
  `CAPTION_LIMITS` edit-guards); `SocialPostSchema.platform` = the row union
  (`PostPlatformSchema`); direct `PLATFORM_LIMITS[x]` stays ONLY for
  request-validated text platforms (repo-wide grep bans
  `PLATFORM_LIMITS[post.platform]`); the text fence holds. (7)
  `/marketing/clips` "window is not defined": `kitFullText` read
  `window.location.origin` and Next SSRs client components — origin now
  rides `useSyncExternalStore` (SSR renders the relative /l/ link).
  verify:social 133 · verify:clips:render 115 (SSR check). (8, 2026-07-16)
  **a re-record was invisible**: the new take lands BESIDE the old one and
  transcript/render/labels were all longest-first → pinned to the dead
  take. Now **`pickCurrentVideoRow`** (transcripts.ts, pure) = THE shared
  lesson-video pick (dual excluded → captioned preferred → NEWEST first)
  used by acquisition + `findRenderSource` + the page labels;
  `lesson_transcript.video_asset_id` (migration `20260716100000`, types
  SPLICED) keys the cache to its asset — acquire REBUILDS on a changed take
  + retires the old take's open candidates (spans live on the old
  timeline); legacy null rows stamp in place on duration match (±2s) else
  rebuild; `createClipRenderJob` refuses stale candidates
  (`stale_candidates` — "run Find clip moments again"). currentTake.spec
  (verify:clips 203) + currentTake.rebuild.spec (verify:clips:int 88).

## Where things live

- `lib/course/` — the Studio's **structured course document model** (UI-free):
  `types.ts` (CourseDocument → modules → lessons → 7 block types; V2 slides =
  positioned `SlideElement` union + `ElementStyle` + `SlideStyle`
  background/theme snapshot) · `schemas.ts` (Zod mirrors, pinned with
  `satisfies z.ZodType<X>`) · `patches.ts` (Zod discriminated-union
  CoursePatch, ~35 actions incl. 18 slide/element ops + pure
  `applyCoursePatch`; **the only way the doc changes**; ids ride in payloads,
  custom-layout placeholders travel inline so the reducer never reads browser
  state) · `slide/` (geometry 1280×720 + clamping, layouts ×14 +
  `applyLayoutToSlide` role-matching, themes ×5, styleResolver
  theme-defaults-under-overrides, contrast, simplify, placeholderImages,
  migrate for V1 flow slides) · `store.ts` (Zustand; `apply` validates →
  applies → logs → pushes undo; redoStack) · `commands.ts` (human patch
  creators) · `factories.ts` (crypto.randomUUID ids — event handlers only,
  never render) · `seed.ts` (deterministic; slide 3 deliberately trips 5 lint
  checks) · `manifest.ts` (+ slide_element/image_element/callout_element) +
  `aiAttributes.ts` (`aiAttrs()` for document nodes, `toolAttrs()` for
  toolbar/tab/panel controls) · `lint.ts` (10 checks, lazy one-click `fix`
  patches) · `ai/` (templates → rules → mockClient, the LLM seam).
- `lib/editor/uiStore.ts` — panel collapse/focus-mode/inspector-tab/custom
  layouts/slide clipboard/image-dialog state (+ non-persisted element
  clipboard & context-menu state). zustand persist with `skipHydration` +
  `UIHydrator` in the (app) layout = no hydration mismatch.
- `lib/editor/dragStore.ts` — **separate non-persisted store** for
  pointermove-frequency transient state (drag/resize frames, snap guides,
  marquee rect). Deliberately NOT uiStore: its persist middleware would hit
  localStorage every frame. One `applyMany` per gesture = one undo step.
- `components/editor/` — the Studio UI: CourseEditorShell (+ shortcuts, rails,
  focus mode), CourseOutlineSidebar (dnd-kit), LessonWorkspace + BlockFrame +
  AddBlockMenu, `slide/` (SlideStage scaled canvas + ElementView +
  useElementDrag one-patch-per-gesture, SlideToolbar, Layout/Theme/Background
  pickers, ColorSwatchPicker, GlobalImageDialog), blocks/* editors,
  InspectorPanel with Design/Content/AI/Metadata tabs (inspector/*),
  AICommandBar (minimizes to FAB) + useAICommand (the one AI pipeline),
  InlineText (commit-one-patch-on-blur), QualityHintBadge (+Fix buttons,
  exports `useEscapeToClose`).
- `lib/data.ts` — remaining in-app mock data + types (courses, analytics,
  marketplace listings, pricing tiers; `curriculum` feeds the landing
  HeroPreview). Swap for Supabase later.
- `lib/marketing.ts` — landing-page content (nav, dual-path copy, features,
  steps, stats, footer columns).
- `lib/cn.ts` — classnames joiner. `lib/ease.ts` — shared `EASE` cubic-bezier
  `[0.22, 1, 0.36, 1]` for all framer-motion transitions.
- `components/ui/` — Card, Badge (+`statusTone`), Button, Stat, PageHeader,
  **RotatingText** (cycling hero keyword), **background-paths** (animated SVG
  flow lines).
- `components/charts/` — dependency-free AreaChart (SVG Catmull-Rom) and BarChart.
- `components/shell/` — in-app Sidebar (active-state nav from `lib/nav.ts`) + Topbar.
- `components/marketing/` — the whole landing: MarketingNav, Hero, HeroPreview
  (self-assembling CSS product mock), Cta, motion.tsx (Reveal/Stagger/StaggerItem
  scroll primitives), CountUp, TrustStrip, DualPath, HowItWorks, Features,
  StatsBand, MarketplacePeek, FinalCTA, MarketingFooter.

## Design system (follow strictly — re-themed 2026-06-12, "warm editorial")

- **Brand = warm orange on paper.** Tokens `--color-brand-50..950` are the
  orange ramp (#fff7ed→#431407) + `.brand-gradient` (135deg #f59e0b→#ea580c)
  in `app/globals.css`. Canvas `#faf7f1` (warm paper), line `#ece7de`, warm
  selection/scrollbar. **Grays are stone-* everywhere, never neutral-*.**
- Typography: Geist Sans UI, Geist Mono eyebrows/labels (uppercase tracked),
  **Fraunces** (`--font-display`, loaded globally in app/layout.tsx) for page
  titles & marketing headlines via `[font-family:var(--font-display)]
  font-light`. Brand mark = the **WiseSel** logo (real assets in `public/brand/`,
  placed via `components/brand/WiseSelLogo.tsx` — `horizontal`/`wordmark`/`mark`/
  `appIcon` variants) — no sparkle-icon logos.
- Buttons are **pills** (`rounded-full`; `components/ui/Button.tsx`: primary =
  brand-gradient). Cards: `rounded-2xl`, `border-stone-200/80`, warm whisper
  shadow `[0_1px_2px_rgba(68,48,28,0.05)]`. Emerald = success semantics only.
- **Gradient rationing:** the saturated gradient stays limited to CTAs/active/
  AI moments + one big FinalSeat panel. Ambient energy comes from warm light
  fields at ~10-20% opacity, never colored fills.
- **Background art is one-per-surface — do not reuse an animation on two
  surfaces** (user-requested): intro hero = HalftoneDrift + SunriseGlow +
  DoodleField + PointerGlow (`components/intro/backgrounds.tsx` +
  `WarmBackdrop.tsx`); FinalSeat = RippleArcs; /educators hero = the flowing
  `BackgroundPaths` (its only remaining home, default tint orange); marquee =
  its own scroll. Slide themes: "Editorial Warm" (default, id
  `editorial-warm`) — the violet theme was retired.
- Status dots: emerald=Published, amber=Draft, pulsing brand=Generating.
- Landing sections: `max-w-6xl px-6` column, `py-24` rhythm, mono eyebrow +
  serif h2 + muted paragraph, one shared reveal language via
  `components/marketing/motion.tsx`.

## Animation conventions (hard-won, keep them)

- **Reduced motion:** every entrance must collapse to final state (gate
  *opacity too*, not just y) and every loop must freeze. A global
  `prefers-reduced-motion` CSS guard in `globals.css` kills CSS
  animations/transitions; framer-motion is gated via `useReducedMotion()`.
- **Loops** (aurora breathe, etc.) are gated behind `useInView` so nothing
  animates off-screen.
- Animate only transform/opacity; progress bars animate `scaleX` (origin-left),
  never width.
- **No `Math.random()`/`Date.now()` in render** — causes Next.js hydration
  mismatches (the background-paths component had to be made deterministic).
- Above-the-fold entrances run on mount, not `useInView` (the hero cluster
  broke headless full-page screenshots until this was fixed).
- React 19 lint forbids setState-directly-in-effect: use
  `useSyncExternalStore` for matchMedia (see HeroPreview pointer check) or
  derived values (see CountUp reduced-motion path).
- CountUp exposes the final value in an `sr-only` span; the animating number is
  `aria-hidden`. The hero product mock is `role="img"` + decorative, with no
  focusable children.

## How this was built / verified (patterns to reuse)

- Sequence so far: scaffold skeleton → multi-agent design panel produced the
  landing brief ("Two Doors, One Living Studio") → implementation → 43-finding
  adversarial review → ~23 fixes applied (rest intentionally declined as
  conflicting with the brief).
- Verification loop: `npm run build` + `npm run lint`, then **temporarily**
  `npm i -D playwright` (chromium already cached at
  `~/Library/Caches/ms-playwright`), screenshot from a script in the project
  root (must scroll the page to trigger `whileInView` before full-page shots),
  assert no horizontal overflow at 320/390/768/1024/1440, then
  `npm uninstall playwright`. Keep runtime deps at exactly: framer-motion,
  lucide-react, next, react, react-dom, zustand, zod, @dnd-kit/core,
  @dnd-kit/sortable, @dnd-kit/utilities, **@supabase/ssr, @supabase/supabase-js**,
  **openai**, **shiki** (Shiki = code highlighting for the code-walkthrough
  structured layout; 14 runtime deps total).
- **Auth'd flows** (persistence, studio load) are browser-verified against
  live Supabase: email confirmation is OFF, so a test self-provisions a fresh
  throwaway user via `POST {URL}/auth/v1/signup` (anon key), signs in through
  the real `/login`, then drives the studio. Make the test create its OWN
  fresh user each run (idempotent) — reusing one leaves stale courses/modules
  that break "starts empty"-type assertions. These throwaway `*@example.com`
  users can't be deleted with the anon key; clean them in Supabase → Auth.
- The editor verification scripts drove the real UI through its own
  `data-ai-*`/`data-ai-tool` attributes (39-check V2 suite: toolbar inserts,
  mouse drag/resize, layout/theme/background application, alt-required image
  upload, lint one-click fixes, AI commands, all 5 panel collapses +
  persistence + focus mode + shortcuts; later 14-check bugfix suite for
  nested-button + layout semantics). Hard-won: dnd-kit needs
  `<DndContext id="...">` or hydration breaks; **BlockFrame's onClick selects
  the block, so interactive children must stopPropagation on click** (the
  slide stage and toolbar do); SE resize handles sit on the clipped canvas
  edge when an element touches it (tests grab SW); React 19 lint forbids ref
  writes in render (use the setState-during-render derived-reset pattern);
  stage scale comes from a ResizeObserver and the stage renders invisible
  until first measure; **element views must never render interactive elements
  when not editable** (thumbnails wrap SlideStage in a <button> — a nested
  <button> breaks HTML/hydration; ImageElementView's empty-src placeholder
  renders a div in preview); **applyLayoutToSlide preserve-mode REPLACES the
  arrangement** (best-match claims slots — exact type + authored-content
  scoring — unfilled slots seed, unmatched leftovers DROP; idempotent on
  re-apply, one undoable patch — earlier keep-leftovers behavior stacked
  duplicates when switching layouts).

## Sensible next steps (not started)

1. Real LLM behind `lib/course/ai/mockClient.ts` (file header documents the
   exact swap: POST /api/ai/command → validate with `z.array(CoursePatchSchema)`).
2. Course-creation wizard (topic/level/duration → generates syllabus draft).
3. ✅ Supabase auth + course persistence (DONE 2026-06-15 — see the Supabase
   section above). Remaining backend: a real **course list/picker** (dashboard
   still shows `lib/data.ts` mock courses, not the user's real ones; studio
   only loads "latest"), image upload → storage bucket (currently object
   URLs), profile/settings wired to real auth, then Stripe + marketplace.
   Persistence is whole-doc snapshot upsert — fine at current scale; revisit
   inverse-patch/partial sync if courses get huge (AUDIT.md #14).
4. Editor gaps deliberately deferred: cross-module lesson drag (patch supports
   it, UI doesn't), rubric/resource editing (read-only), quiz question delete,
   slide thumbnail drag-reorder; remaining cut list after the V3 Part-A
   upgrade (marquee/multi-select, snapping, aspect-lock, groups, shadows,
   distribute, auto-grow all landed — see CHANGELOG.md): table cell editing
   UI (render + patches only), image crop UI (model field exists), rotation
   UI (render-only; selection/snap math is AABB-approximated for rotated
   elements), nudge patch coalescing (each arrow press = one undo step),
   theme re-tint of explicitly styled elements.
5. Real client-side PPTX export (e.g. pptxgenjs) for the Exports page.
   **Export-fidelity ledger** (canvas features whose PPTX mappings are
   non-obvious — pay this list when export lands, and add a render-vs-export
   visual diff to the verification loop): `justify` text-align · drop-shadow
   (PPTX outer shadow ≠ CSS drop-shadow semantics) · dashed/dotted strokes ·
   triangle geometry · nested groups (`groupPath` → nested `<p:grpSp>`) ·
   grow-only auto-height text boxes · **sticker elements** (lucide glyph → an
   embedded image/path) · **renderer-owned structured layouts** (each
   `slide.template` component's arrangement must be re-derived as native PPTX
   shapes/text boxes — costs more than flat layouts) · **Shiki code** (token
   spans → run-level colored text) · **`diagram` slides** (`DiagramView` already
   emits pure deterministic SVG → the EASIEST export: embed the SVG, or rasterize
   to PNG; the alt text + caption carry over verbatim). The `metrics_overview`
   chart slot is deferred to the charts-as-data workstream — do NOT fake it in
   export.
6. `/pricing` marketing page — the landing nav currently points Pricing at
   `/settings`, which is a known wart.
