# TUTOR-1 — Amendment A4 · Wave 0 read-only audit

> **Scope:** lesson-scoped tutor threads + course retrieval (see the A4 directive).
> **Status:** read-only audit — **no source file was modified** producing this
> document (this file is the one permitted artifact). **HARD STOP** follows §10.
> **Method:** live Supabase (project `WiseSel`, 75 migrations applied) + a
> code sweep across `lib/tutor/**`, `lib/learn/**`, `lib/course/publish/**`,
> `lib/ai/**`, `components/learn/tutor/**`, `supabase/migrations/**`. Every
> load-bearing claim carries a `file:line` or a live-query provenance. Facts
> that were *inferred* rather than read are marked **(inferred)**.
> **Filename note:** the directive names this `docs/audits/TUT-A4-audit.md`; the
> two prior audits use `TUTOR-1-A2/A3`. Honoring the directive's literal path.

---

## 0. Executive summary — the shape of the work

Two facts dominate the plan and both are **good news**:

1. **The embedding seam already exists end-to-end.** `ModelClient.embed()` is a
   real, tested method with an OpenAI implementation (batched
   `text-embedding-3-small`, proxied, order-preserving) and a deterministic mock;
   there is a `TUTOR_MODELS.embedding` config, `jobType:"embedding"` cost
   telemetry, cosine math in three call sites, a per-lesson content chunker
   (`extractionSource.ts`), and even a **`concept_nodes.embedding jsonb`** column
   described in its own migration as *"pgvector-shaped for a future extension."*
   **Wave 2 extends this seam; it does not build one.**

2. **pgvector is one statement away.** The `vector` extension (v0.8.0, ivfflat +
   hnsw) is *available but not installed* on the instance. Enabling it is
   `create extension vector`. No FTS (`tsvector`) or ANN index exists anywhere —
   the retrieval table is greenfield, so there is nothing to collide with.

The remaining work is exactly what the directive scopes: (a) re-scope threads
from `(user, course)` to `(user, lesson)` with backfill + archive + compaction +
chain-recovery (Wave 1); (b) persist per-chunk embeddings keyed to the immutable
snapshot and add hybrid vector+lexical retrieval filtered by eligible lessons
(Wave 2); (c) an eligibility + tiered-expansion scope policy over the *already
live* completion predicate and concept graph (Wave 3); (d) swap the whole-lesson
prompt dump for retrieved chunks and fix D-7/D-8/D-9 in the UI (Wave 4); (e)
calibrate τ, tests, docs (Wave 5).

**11/11 audit questions answered with code+DB grounding.** Three directive
schema/text items need correcting before Wave 1 (§8 Deviations): the proposed
`lesson_id` **FK to `lessons(id)`** contradicts the tutor tables' deliberate
no-FK-to-draft convention; the Wave-1 schema block **omits the DROP** of the
existing `UNIQUE(user_id, course_id)` (which will otherwise block per-lesson
threads *and* break `ensureThread`'s `onConflict`); and it omits an **archive
marker** required by A4-7 (which then forces the new partial unique to exclude
archived rows). And the §2 "two-concurrent ceiling / query-embedding is exempt"
reading is **factually wrong for the tutor today** (§2 confirmation below).

---

## 1. A0-1 — `tutor_threads` schema and lifecycle

**Full current schema** (base `supabase/migrations/20260804100000_tutor_threads_charter.sql:40-50`; A2 columns `20260806180000_tutor_active_stream.sql:30-32`; verified live + against `lib/database.types.ts:4500-4527`):

| column | type | null | notes |
|---|---|---|---|
| `id` | uuid | no | PK `gen_random_uuid()` |
| `user_id` | uuid | no | learner owner — **no FK** to `auth.users` |
| `course_id` | uuid | no | **FK → `courses(id) ON DELETE CASCADE`** |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()`; `moddatetime` trigger `tutor_threads_set_updated_at` |
| `active_stream_id` | text | yes | A2 resume-buffer key of in-flight turn (null=idle); no FK |
| `active_response_id` | text | yes | A2 provider response id captured at `response.created` (null=idle) |

Constraints/indexes (verified live via `pg_constraint`/`pg_indexes`):
`tutor_threads_pkey(id)`; **`tutor_threads_user_id_course_id_key` UNIQUE(user_id, course_id)**; FK `tutor_threads_course_id_fkey`; index `tutor_threads_user_course_idx(user_id, course_id)`. **No append-only/immutability trigger** (unlike `tutor_turns`) — the row is mutated in place for the A2 in-flight columns.

**RLS (`…charter.sql:210, 217-220`):** RLS on; exactly two policies, both `user_id = (select auth.uid()) AND private.is_enrolled(course_id)` — one `SELECT`, one `INSERT`. **No author policy, no UPDATE, no DELETE policy.** Consequence: every mutation (the A2 in-flight columns, and anything A4 adds — backfill, archive, compaction summary) **must run via the service/admin client**; there is no learner write path beyond insert.

**What key scopes a thread today — `(user_id, course_id)`, confirmed three ways:** the DDL `unique (user_id, course_id)` (`:46`); the get-or-create `onConflict:"user_id,course_id"` (`lib/tutor/runtime/service.ts:152-155`); and the absence of any `lesson_id` column. **One thread spans all lessons of a course.**

**Resolver:** `ensureThread` (`service.ts:144-166`) — admin `upsert({user_id, course_id}, {onConflict:"user_id,course_id", ignoreDuplicates:true})` then `select .single()`, race-safe. Called from `runTutorTurnForRequest` (`service.ts:621-625`) **only after `access.kind === "ok"`** (`:619`) — a thread is created lazily on the first *enrolled* turn. Read-only openers (`loadTutorHistory` `lib/learn/tutorHistory.ts:281`; `loadTutorHomeEntries` `lib/learn/tutorHome.ts:152`) never create.

**Lesson association today:**
- **On `tutor_threads`: none.** No column exists; a thread cannot be scoped/filtered by lesson.
- **On `tutor_turns`: yes, but only as denormalized, nullable, no-FK envelope metadata.** `tutor_turns.lesson_id uuid` (nullable, `…charter.sql:74`) is *"the lesson open when the learner sent that message"* — it varies turn-by-turn within one thread. Written from the wire envelope in `persistLearnerTurn`/`persistAssistantTurn` (`service.ts:210, 247`), sourced from `body.lessonId ?? null` (`app/api/learn/tutor/route.ts:196-203`). The migration comment is explicit that these node ids carry **no FK** *"because the draft row may be deleted while a turn lives"* (`…charter.sql:26-29`).

**Backfill feasibility (verified live — the real corpus is tiny):** 24 threads, 65 turns. Deriving each thread's lesson from its turns' `lesson_id`: **2** threads map to a single distinct lesson, **3** span multiple lessons (unbackfillable — no single lesson), **19** have zero lesson-bearing turns (landing-page conversations). So a backfill sets `lesson_id` on ~2 threads and leaves ~22 as **legacy null-lesson general threads** (readable, not extended — exactly the directive's rule). Low-risk. Must run service-role (no UPDATE RLS). **(inferred)** a thread with zero turns cannot exist today (`ensureThread` runs inside a turn that also persists the learner row, `service.ts:666`).

---

## 2. Concurrency ceiling — the §2 confirmation the directive demanded

The directive §2: *"MUST honour the existing two-concurrent-chat-model-call ceiling. Query embedding is a separate lightweight call and is exempt; confirm this reading in the Wave 0 report rather than assuming it."* **Confirmed — and the reading is wrong on both counts. State the corrected facts before building.**

**Fact 1 — the tutor's chat-model ceiling is 8, not 2.** Two per-instance counting semaphores exist (`lib/ai/subagent.ts:150-182`): the **creator pool** `modelCallSemaphore = Semaphore(AI_CREATOR_POOL_MAX ?? MAINTENANCE_MAX_CONCURRENT_MODEL_CALLS ?? 2)` and the **learner pool** `learnerPool = Semaphore(AI_LEARNER_POOL_MAX ?? 8)`. The tutor SSE route wraps its OpenAI client with `withPooledModel(createOpenAIModelClient(), { pool: poolFor("learner"), … })` at `route.ts:355` (turn) and `:603` (resume) — i.e. tutor turns run under the **learner pool = 8**. The "two" is the maintenance/creator pool, not the tutor. (Analogous to A2's audit correcting the directive's `tutor_sessions` → `tutor_threads`.)

**Fact 2 — `embed()` is NOT exempt; it is gated under the same pool as `runTurn`.** `withPooledModel` decorates **both** `runTurn` *and* `embed` (`subagent.ts:288-327`); the docstring is explicit: *"every `runTurn` AND `embed` (embed was previously UNGATED — gating it is the one deliberate behaviour change vs the old `withSemaphore`) holds the pool"* (`:215-222`). An `embed` call through the learner-pooled client therefore **acquires a learnerPool slot** and emits a `tutor_model_call` cost row under `jobType:"embedding"` (`:309-321`).

**Implication for Wave 2/4 (the design decision this forces):** a query-time embedding issued through the tutor's pooled client is **not free** — it competes for one of the 8 learner slots and shows in cost telemetry. The acquisitions are *per-call*, not held for the whole turn (the decorator acquires around each `base.runTurn`/`base.embed`), so a pre-turn query embed then the turn are **two sequential acquisitions — no reentrancy, no deadlock** on a counting semaphore, but under a burst the embed adds one pool round of latency and one slot of contention. **To make query embedding genuinely "exempt" as the directive intends, A4 must issue it through an *un-pooled* `createOpenAIModelClient()` (or a separate, larger embedding pool), not the learner-pooled client the route hands the loop.** Recommend: a dedicated un-pooled (or `AI_EMBED_POOL_MAX`-sized) embedding client for retrieval, so the interactive turn ceiling is untouched. This is a Wave-2 decision to record, not a blocker.

---

## 3. A0-2 — Lesson completion predicate

**Table `public.learn_progress`; the predicate is `status = 'completed'`.** This is the eligibility predicate Wave 3 reuses.

**DDL** (`supabase/migrations/20260702030000_learn_runtime.sql:34-57`, the sole creating migration; verified live):
`id, course_id (FK courses ON DELETE CASCADE), user_id (FK auth.users ON DELETE CASCADE), lesson_id uuid (draft id, no FK), status text default 'not_started' check in ('not_started','in_progress','completed'), pct numeric 0..100, progress_state jsonb, last_activity_at, created_at, updated_at`, **`unique (user_id, course_id, lesson_id)`**, indexes `learn_progress_course_idx(course_id)` + `learn_progress_user_course_idx(user_id, course_id)`, `moddatetime` trigger.

**Status is server-derived, never client-supplied:** `status = computed.completed ? "completed" : "in_progress"` (`lib/learn/progressService.ts:183-184`). RLS has **only a SELECT policy** (own row or course author, `…:158-162`); the service role is the only writer.

**The rule** — `computeLessonProgress` (`lib/learn/completion.ts:109-128`), two regimes:
- **Trackable lesson** (≥1 trackable unit): `completed = fractions.every(f => f >= 1)`. Units: native slide deck (all snapshot slide ids in `progress_state.viewedSlides[blockId]`), imported_deck (in `viewedBlocks`), video (`videoPct[blockId] >= VIDEO_COMPLETE_PCT=90`), quiz (≥1 submitted attempt, read from `quiz_attempts`, `progressService.ts:113-119`).
- **Untrackable lesson**: `completed = progress_state.markedComplete === true`; `mark_complete` is rejected for trackable lessons (`progressService.ts:96-101`).

**`pct` is NOT the predicate** — it is capped at 99 until truly complete (`completion.ts:121-126`). Do not key on pct. (Separately, `REVIEW_ELIGIBLE_PROGRESS_PCT=70` in `lib/learn/reviewsShared.ts:14` is course-*review* eligibility — do not conflate with lesson completion.)

**"visited"/"in_progress" vs "completed":** there is no distinct `visited` status. `not_started` = **no row** (derived at read, `summary.ts:49-54`); merely opening a lesson inserts an `in_progress` row (`lesson_opened` is a no-op merge that still recomputes, `progressService.ts:63-64`). Partial signals live in `progress_state` jsonb.

**No exported "completed lesson-id set" helper exists** (grep-negative). The reusable pattern is the inline set in `maybeCompleteEnrollment` (`progressService.ts:126-134`). Cleanest Wave-3 read (index-covered, RLS lets learner read own rows — no admin client needed):
```
supabase.from("learn_progress").select("lesson_id")
  .eq("user_id", uid).eq("course_id", cid).eq("status","completed")
```
Course-level "done" is a *separate* signal: `enrollments.status='completed'` (upgrade-only flip, `progressService.ts:122-144`).

---

## 4. A0-3 — pgvector status

**Available, not installed.** `list_extensions` (live): the `vector` extension is present at `default_version 0.8.0` (*"vector data type and ivfflat and hnsw access methods"*) with **`installed_version: null`**. Enabling is a one-liner in a Wave-2 migration:
```sql
create extension if not exists vector;   -- Supabase installs into the extensions schema
```
No superuser/support ticket is needed on Supabase (it is in the allow-listed extension set — evidenced by `default_version` being populated). No pgvector operator (`<=>`,`<->`,`<#>`), no ivfflat/hnsw index, and no `tsvector`/`to_tsvector`/GIN FTS appear in any migration (grep-negative). The retrieval index is **greenfield**.

---

## 5. A0-4 — Snapshot structure and the natural chunking unit

**Snapshot tree** (built by pure `buildPublicationSnapshot`, `lib/course/publish/snapshot.ts:108-151`; schema `lib/course/publish/schemas.ts`):
```
PublicationSnapshot { schemaVersion:1,
  course:{id,title,description?,audience?,level?,plan,theme},
  modules:[{id,type:"module",title,description?,order,
    lessons:[{id,type:"lesson",title,objective?,order,estimatedMinutes?,
      blocks:[ PublishedLessonBlock … ]}]}]}
```
**Verified live (cs61b):** a `slide_deck` block's top keys are exactly `["ai","id","type","order","title","slides"]` and a `quiz`'s are `["ai","id","type","order","title","questions"]` — i.e. **`slides[]`/`questions[]` sit at the block top level; there is no `.content` wrapper** in the snapshot (the `.content` jsonb exists only on the draft `blocks` row). Node ids are the draft row ids preserved verbatim (`snapshot.ts:7-8`) → durable across versions. Quiz answers are stripped into a server-only key table; `PublishedQuizQuestionSchema` is strict + `findAnswerKeyLeaks` guards (`snapshot.ts:30-105, 172-195`) — **a chunker sees stems + choice text only, never answers.**

**Text-bearing fields a chunker must harvest** (already implemented by `lib/tutor/graph/extractionSource.ts` — reuse it):
- **Slide, shape A (positioned `elements[]`, `types.ts:235-258`):** `text.text` (+`runs`), `heading.text`, `bullet_list.items[]`, `code_block.code`, `callout.text`, `table.rows[][]`, `image.{alt,caption,attribution}`; `sticker`/`divider`/`shape` = no prose. **Runs invariant** `concat(runs)===text` (`types.ts:117-126`) → read `.text`, never walk runs.
- **Slide, shape B (structured `template`, `types.ts:642-662`; wins when present):** every `RichText = {text, runs?}` leaf plus the plain `code.code` string, across 12 live layouts (`prose, key_concept, concept_example, comparison_columns/_matrix, outline_list, process_steps, metrics_overview, code_walkthrough_steps, section_break, image_reference, image_supporting`). `imageUrl/storagePath/intentHash/alt` are asset refs, not taught prose. A generic `{text}`-leaf walk with an ignore-key set covers all layouts + is future-proof (`extractionSource.ts:88-113`).
- **Non-deck blocks:** `quiz` (stems + choice text) — chunk; `lecture_text` (`paragraphs[].text`) — chunk (densest prose); `example` (context/explanation/steps/takeaway) — chunk; `homework`/`exercise` (instructions/prompt, **not** hint/solution) — optional; `resource` (link labels/notes) — low value. **`imported_deck`** (bytes off-doc) and **`video`** (transcript deliberately kept OFF the snapshot, on `video_assets`) **cannot be chunked from the snapshot** — a video-transcript chunker is a separate, keyed-by-`video_assets` source (out of A4 scope; note it).

**Recommended chunking unit: the SLIDE for `slide_deck`, the BLOCK for every other text block** (quiz question sub-chunk allowed but anchored to the block). Rationale: a slide is a coherent authored idea (content-first planning splits overflow into continuation slides), the grain fits (cs61b: **225 slides / 72 blocks / 38 lessons ≈ 5.9 slides/lesson**, max 13), and — decisively — the slide is **the finest unit the `/learn` player can deep-link to** (§ anchor below). Do **not** default to the existing whole-lesson chunk (`deriveLessonChunksWithCap`, capped 6000 chars, visibly truncates dense lessons). Practical shape:
`{ courseId, publicationId, version, lessonId, blockId, slideId?, moduleTitle, lessonTitle, text, anchor }`, reusing `LessonChunkAnchor {blockId, slideId?}` (`extractionSource.ts:36-39`).

**Display anchor (D-8's real destination) — live and durable.** Route `/learn/[slug]/[lessonId]?block=<blockId>&slide=<slideId>` (`app/(learn)/learn/[slug]/[lessonId]/page.tsx:150-155, 261`); `focusBlock(blockId, slideId)` scrolls to `data-block-id` and steers a deck to `slides.findIndex(id===slideId)` via a `deckNav` nonce (`components/learn/LearnLessonView.tsx:350-381, 469-473`). A stale anchor (node dropped on republish) degrades to a no-op (guarded by `lesson.blocks.some(...)`). So the anchor to store is `{lessonId, blockId, slideId?}` — nothing finer is navigable.

---

## 6. A0-5 — Existing embedding / retrieval path (the biggest de-risk)

**A real embedding seam exists end-to-end; it is used only for in-process concept-graph clustering/reconciliation. There is NO stored-vector retrieval, NO ANN index, NO FTS, and embeddings are NOT persisted at extraction time.**

- **`ModelClient.embed?()`** — `lib/ai/modelClient.ts:236`; `EmbedParams{model,inputs[],signal?,timeoutMs?}` / `EmbedResult{vectors:number[][],usage:{inputTokens}}` (`:183-196`). **OpenAI impl** `lib/ai/providers/openai.ts:581-607` (batched `client.embeddings.create`, order-sorted, hard-deadline abort, throws on error). **Mock impl** `lib/ai/providers/mock.ts:128-134` (deterministic 32-dim unit vectors + `getEmbedCalls()`).
- **Config** `TUTOR_MODELS.embedding = { model:"text-embedding-3-small" (env TUTOR_EMBEDDING_MODEL), timeoutMs 60000, maxRetries 2 }` (`lib/ai/modelConfig.ts:309-315`); price `text-embedding-3-small: $0.02 / 1M input tok` (`:415`); `jobType:"embedding"` is already a DB-checked cost job type.
- **Live embed call-sites (real cosine, not prose):** extraction canonicalization clustering (`lib/tutor/graph/extraction.ts:306-334`, threshold 0.85); reconcile matching (`lib/tutor/graph/reconcile.ts:721-770`, threshold 0.8); escalation question clustering reuses `cosineSimilarity` (`lib/tutor/escalation/clustering.ts:21`).
- **Not persisted at extraction:** `stageNodes` hard-codes `embedding: null` (`extraction.ts:734`) — extraction-created `concept_nodes` carry no vector; only the reconcile path persists one (`reconcile.ts:858`). Live: **44 of 574** `concept_nodes` have a non-null `embedding` jsonb. **`concept_nodes.embedding jsonb`** = *"float array, pgvector-shaped for a future extension"* (`supabase/migrations/20260803100100_concept_graph.sql:44`). (These 44 are concept-*node* vectors at a different grain than A4's chunk vectors and do not interfere with a new chunk table.)
- **Chunker precedent:** `extractionSource.ts` mines readable text per block and emits **one chunk per lesson** today (`deriveLessonChunksWithCap`, 6000-char cap). A4's per-slide/per-block refinement is a small change on proven code.

**Wave-2 delta:** persist per-chunk vectors (new table), add a stored-vector nearest-neighbor **search** (none exists — all cosine today is in-process over freshly computed vectors), enable pgvector + index, and add the `tsvector` lexical half. The seam, provider, config, cost telemetry, and math are all reused.

---

## 7. A0-6 / A0-7 — How the tutor gets lesson context today, and compaction

**A0-6 — context mechanism + "before" token number.** The tutor injects the **entire active lesson's readable text as a flat text block (prompt layer L2)** into the `developer` message every turn — not structured, not tool-fetched, not retrieved. Source is the **immutable published snapshot** via `getCachedSnapshot(publicationId)` (`lib/tutor/runtime/loop.ts:299-302`; `lib/learn/publicationCache.ts:163`), never draft tables. Assembly: `assembleLessonContext` (`lib/tutor/runtime/lessonContext.ts:329`) mines block text (`mineBlockLines:153`, quiz **stems only** `:204-208`) + anchored concept nodes, clamped to **`LAYER_BUDGETS.l2Chars = 10,000` chars ≈ 2,500 tokens** (`promptLayers.ts:26`; blocks 75% / concepts 25%), spliced as `developer = charter(L1) + "\n\n" + lessonContext(L2)` (`promptLayers.ts:122`).

Prompt layers: **L0** static system (`TUTOR_L0`, `tutor-v5`, ~9,297 chars ≈ 2,324 tok — cache prefix), **L1** serialized charter (~140 tok for cs61b defaults), **L2** the lesson dump (this section), **L3** learner-state + synopsis (≤800 tok, per-turn/per-learner), **L4** conversation replay (≤2,000 tok, per-turn). L0+L1+L2 are engineered as a byte-stable cache prefix (`store:true`, `loop.ts:570`) but are **re-sent every turn** (chaining OFF — see A0-7/A0-10).

**"Before" number (measured against live cs61b, 38 lessons):** per-lesson readable text median **12,614** / mean 11,483 / max **22,261** chars; **25/38 (66%) lessons exceed the 10k L2 budget** and are truncated to the cap. Effective L2 after clamp ≈ **8,015 chars ≈ ~2,000 tokens average**, pinned at the **~2,500-token cap** for a median+ lesson. So Wave 4's baseline: **L2 ≈ 2,000 tok avg / 2,500 tok (cap), re-billed every turn, truncating the tail of 2/3 of cs61b lessons.** Retrieved chunks (Tier-1 6 × ~one slide of plain text) both shrink this and — the real win — enable cross-lesson coverage a truncating single-lesson dump cannot give.

**A0-7 — compaction today.** There **is** a bound, applied every turn at assembly (no summarization, no rolling summary anywhere): (1) a DB read cap of the **newest 40** turns (`loadThreadHistory`, `service.ts:272-299`, `order desc limit 40` then reverse); (2) a replay window of the **newest 12 turns AND ≤8,000 chars, dropping oldest whole turns** (`HISTORY_MAX_TURNS=12`, `serializeHistory`, `lib/tutor/runtime/history.ts:41-69`). The model input per round is a single `[developer, user]` pair — prior turns are text *inside* the user input, not a growing role array (`loop.ts:503-505`). Context **grows one turn/exchange then plateaus** at the 12-turn/8k ceiling. **There is no LLM-summary compaction and no persisted summary column** — so A4's `compaction_summary` is genuinely new. (Note: `lib/tutor/runtime/session.ts` derives a 30-min-gap "session" window for once-per-session behaviors — unrelated to context bounding; a session is *not* a stored entity.)

---

## 8. A0-10 — Response-id chaining + retention expiry

**Retention (source-cited):** OpenAI Responses API stored responses are **retained 30 days by default**, after which `previous_response_id` becomes invalid — *"Response objects are saved for 30 days by default"* ([OpenAI · Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)); `store:true` is required to persist; items attached to a **Conversation** object are exempt from the TTL, **but the tutor uses bare `previous_response_id`, not Conversations**, so the 30-day TTL applies. The exact HTTP status on an expired/unknown id is **not authoritatively documented** — treat as a request-layer 4xx (community reports a 404-class "previous response not found").

**Chaining today is default-OFF and dormant.** `collapseToChaining` returns non-null only when `chainingEnabled()` (`process.env.TUTOR_ENABLE_CHAINING === "true"`, `history.ts:71-90`) — **absent from `.env.local`/`.env.example`** (grep-negative). The main call always sends `store:true` (so the seam is live) but adds `previous_response_id` only when chained (`loop.ts:570-571` → `openai.ts:360`). Two id chains, not to be conflated (`streamState.ts:10-15`): `tutor_threads.active_{stream,response}_id` = transient in-flight/resume handles (cleared on settle; `active_response_id` has **no read consumer** yet — a dormant crash-recovery hook); `tutor_turns.response_id` = the immutable completed-turn chain anchor (written `service.ts:252`, read into `HistoryTurn.responseId` `:291`, consumed only by `collapseToChaining`).

**What happens on a stale/expired id today — hard fail, no self-heal** (path is currently *dead* because chaining is off, but it is the pre-existing behavior A4 Wave 1 must fix): a rejected id → SDK throw → `classifyError` → `model_error` (`openai.ts:209-219`) → `runTurn` returns `finishReason:"error"` (`:476-488`) → the loop `if (result.finishReason === "error") return empty(...)` **with no retry-without-id and no textual fallback** (`loop.ts:579-580`) → service persists no assistant row (`service.ts:745`) → route emits a generic *"couldn't complete that turn. Please try again."* (`route.ts:647-654`). **A4 Wave-1's `tutor.chain.rebuilt` recovery** should hook exactly here: on `finishReason==="error" && errorKind==="model_error"` while a `previous_response_id` was sent, retry once with `previous_response_id:null` + the textual replay the tutor *already builds* (`serializeHistory`, `loop.ts:468-470`), and — per the directive — rebuild from `compaction_summary` + recent turns. The SDK's `maxRetries` cannot self-heal this (it never mutates the body).

---

## 9. A0-11 — Concept ↔ lesson mapping (for `prerequisite_gap` / `multi_concept_span`)

**The mapping is real, live-populated, and fully queryable; only a packaged resolver is missing (a data-assembly gap, not a data gap).**

- **Concept → lesson binding = `concept_nodes.anchors jsonb`** = `[{lessonId:uuid, blockId:uuid, slideId?:text}]` (`supabase/migrations/20260803100100_concept_graph.sql:43`; `ConceptAnchorSchema` `lib/tutor/graph/schemas.ts:33-37`). Many-to-many: a concept can anchor to several (lesson, block) pairs. **Live cs61b:** 60 active nodes, all 60 anchored (each anchor has lessonId+blockId). Caveat: 3 fixture courses have 4 anchor-less nodes → Wave 3 must tolerate a concept that resolves to no lesson.
- **Prerequisite edges = `concept_edges`** (`…:66-80`): `(source_node_id, target_node_id, kind in ('prerequisite','part_of','related'))`, DAG enforced at the write path (`tutor_upsert_concept_edge` definer RPC, `WITH RECURSIVE` cycle gate, `:255-366`). **Direction convention (authoritative, `lib/tutor/mastery/queries.ts:13-27`):** for `prerequisite` A→B, **A is a prerequisite OF B**; to find a concept's prerequisites, walk **reverse** (`target→source`). Live cs61b: 47 prerequisite edges.
- **Three-way queryability — verified live end-to-end** in one SQL statement on cs61b: lesson `deadfe06…` → its concept "BST operation cost … height" → prerequisite "BST ordering invariant" → covering lesson `2af4a1b9…` ("Tree Methods and BST Operations"). A working `prerequisite_gap` traversal against real data.
- **Mastery per concept:** `learner_mastery(user_id, course_id, node_id, p_learned, decayed_p, …)` (`…20260803110200_learner_mastery.sql:16-35`), strict own-rows RLS, service-role writer; threaded into the loop as `masteryByNode: Map<nodeId, decayedP>` (`lib/tutor/runtime/tools.ts:123-127`, *"conceptSlug IS the node uuid"*). Pure graph selectors already exist: `rootCause` (deepest below-threshold prerequisite ancestor, `queries.ts:160-200`) — essentially the concept-level `prerequisite_gap` selector, **minus lesson resolution** — plus `weakestNodes`, `prerequisiteAdjacency`.
- **The gap (Wave 3 work):** no packaged `conceptToLesson`/`lessonsForConcept`/`prereq→coveringLessons` accessor exists (grep-negative), and no `prerequisite_gap`/`multi_concept_span` expansion code exists. But `loadTutorContext` (`service.ts:504-536`) already loads active nodes **with anchors** + all edges into `TutorContext` in one admin wave, so Wave 3 builds these purely from data already in hand: a trivial `anchors.map(a=>a.lessonId)` resolver + `rootCause`/`weakestNodes` on top. **No schema change, no migration, no new RPC** for the concept-graph side of scope policy.

---

## 10. A0-8 / A0-9 — "Go there" affordance (D-8) and suggestion chips (D-9)

**D-8 — "Go there"/"Show me".** Rendered by `CitationChips` in `components/learn/tutor/TutorBody.tsx`; label is a bare constant `sameLesson ? "Show me" : "Go there"` (`:786`). Driven by the model's per-turn **`citations` output array** (`TurnOutputSchema.citations`, `outputContract.ts:135`), each citation `{lessonId, blockId, slideId?}` — **ids only, no title/label field** (`outputContract.ts:51-56`). Gate is `citations.length > 0` (`TutorBody.tsx:583`). Destinations **do** resolve (the grounding validator drops citations whose block isn't in the snapshot and null-downgrades bad slideIds, `grounding.ts:144-160`); `jump()` routes same-lesson via `requestCitation`→`focusBlock`, cross-lesson via `router.push('/learn/{slug}/{lessonId}?block=&slide=')` (`TutorBody.tsx:762-769`). **Root cause of "no visible destination on consecutive messages":** the chip shows only the generic label + arrow — the citation type carries no human title, so nothing names *where* it goes; and because most substantive turns ground (and thus cite), consecutive answer turns each render their own row of identical, unlabeled chips. The fix is **presentational**: derive a display title from the snapshot index (lesson/block/slide title) for the chip, and render **at most one nav affordance per message** (A4-24). **(inferred)** the "points nowhere" perception is the UX reading of these verified facts; the link itself works.

**D-9 — suggestion chips.** A **hardcoded static array of 4** (`TutorBody.tsx:83-90`): `explain / quiz / review / plan`, rendered as a fixed footer row (`:387-399`). The only dynamic input touches **only the `review` chip's outgoing message** (prefilled from `my_review_queue` RPC, `:182-204, 394`) — never a label, never chip selection; nothing reads lesson title, mastery, or conversation state to choose chips. No other suggestion generator exists in the tutor tree (grep-negative). **Consistency constraints Wave 4 must preserve:** (a) the exact string **"Quiz me on this lesson"** is hardcoded into `PRACTICE_REQUEST_RE`/`detectPracticeRequest` (`invocationPolicy.ts:135-146`) — a derived chip set must keep that literal so the practice classifier still fires; (b) A3's **dedup-by-action-identity** (`${lessonId}|${blockId}|${slideId??""}`, never by label — `lib/learn/tutorClientTypes.ts:302-320`, `grounding.ts:162-175`) — a redesigned chip/citation set must dedup by target, not label (A4 §4 / A3 §4).

---

## Migration surface (every DDL A4 needs)

**Wave 1 — `tutor_threads` re-scope (one migration; code-coupled):**
1. `alter table tutor_threads add column lesson_id uuid;` **Decision required (see Deviations):** the directive says `references lessons(id)`; the tutor tables deliberately carry **no FK to draft content** (turns' lesson_id has none *"because the draft row may be deleted while a turn lives"*). **Recommend: NO FK** (snapshot node id, matching `tutor_turns.lesson_id`) — or, if a FK is wanted, `on delete set null` to preserve the thread. Do **not** cascade-delete a thread when a draft lesson is deleted.
2. `add column compaction_summary text;` `add column compacted_through_turn int;` (both null until first compaction).
3. `add column archived_at timestamptz;` **[not in the directive's schema block — required by A4-7]** so "Start fresh" archives rather than deletes.
4. **DROP the existing scope key** — `alter table tutor_threads drop constraint tutor_threads_user_id_course_id_key;` and `drop index tutor_threads_user_course_idx;` **[omitted by the directive; mandatory]** — otherwise a second lesson's thread for the same (user, course) violates the old unique.
5. **New active-thread unique** — `create unique index tutor_threads_learner_lesson_active_uidx on tutor_threads (user_id, lesson_id) where lesson_id is not null and archived_at is null;` (the directive's index must gain `and archived_at is null`, else archive+reopen collides). Add a covering `(user_id, course_id)` btree back for the outline/history reads that still scope by course.
6. **Code-coupled change:** `ensureThread`'s `onConflict:"user_id,course_id"` (`service.ts:152-155`) **must be rewritten** to resolve by `(user_id, lesson_id)` (active, non-archived) — the upsert breaks the instant the old conflict target is dropped. All new-column writes (backfill, archive flip, compaction) run **service-role** (no learner UPDATE RLS). Legacy threads: backfill `lesson_id` from a single-lesson turn set (~2 rows), leave the rest null.
7. Backfill migration/step: derive per-thread lesson from `tutor_turns.lesson_id` where exactly one distinct non-null value exists; else leave null.

**Wave 2 — retrieval index (one migration):**
1. `create extension if not exists vector;`
2. New table (recommend a fresh table, not overloading `concept_nodes.embedding`), e.g. `tutor_chunks(id, course_id, publication_id, version, content_hash, lesson_id, block_id, slide_id text, chunk_ordinal int, text text, embedding vector(1536), tsv tsvector, source_tier text not null default 'canon' check (source_tier in ('canon')), display_anchor jsonb, created_at)`. **`source_tier`** is the directive's `[FWD]` seam — CHECK it to `'canon'` only (so `'adjacent'` is unreachable in A4).
3. Indexes: an ANN index on `embedding` (**hnsw** recommended for recall/latency at this corpus size: `using hnsw (embedding vector_cosine_ops)`; ivfflat needs a populated `lists` tune) + a `gin(tsv)` for lexical + a btree on `(publication_id)` / `(course_id, lesson_id)` for the in-query eligible-lesson filter. **No collision** — `concept_nodes`/`course_publications` have no vector/GIN index today.
4. Embedding key = **`publication_id`** (immutable snapshot) with `content_hash` recorded for cross-publication dedup. Live: `course_publications.content_hash` is `NOT NULL` and 104/104 live pubs are distinct; per CLAUDE.md it is `sha256({snapshot, answerKeys})` so cover-metadata changes (not snapshotted) do **not** change it — a safe re-embed-avoidance key. Republishing an identical snapshot is an M1 no-op (no new row), so "zero embeddings on unchanged republish" (A4-9) is satisfied by keying on `publication_id`/`content_hash` and skipping when a row for that key exists.
5. RLS pattern to mirror: **service-role writer, learner+author SELECT** (the `learn_progress`/`tutor_turns` idiom). A chunk is enrollment-gated read (`private.is_enrolled(course_id)`) + author read.

**Publish hook:** compute+persist chunks+embeddings inside/after `publish_course` (idempotent on `publication_id`). Chunking reuses `extractionSource.mineBlock`; embedding reuses `ModelClient.embed` (batched) through an **un-pooled or dedicated-pool** client (§2).

---

## Risk register (with owning wave)

| # | Risk | Severity | Mitigation / where |
|---|---|---|---|
| R1 | **Dropping `UNIQUE(user_id,course_id)` breaks `ensureThread.onConflict`** (silent upsert failure). | High | Wave 1 — ship DDL + `ensureThread` rewrite in the same change; add an int test that opens two lessons → two rows. |
| R2 | **`lesson_id` FK-to-draft** contradicts the no-FK convention; a draft-lesson delete could cascade/orphan a thread. | Med | Wave 1 — no FK (or `on delete set null`); see Deviations. |
| R3 | **Archive vs partial-unique collision** — archive a thread, reopen same lesson → two live rows. | Med | Wave 1 — partial unique `where … and archived_at is null` (directive's index is insufficient). |
| R4 | **Query embedding is NOT exempt from the learner pool today** (`withPooledModel` gates `embed`); a per-turn embed steals a learnerPool slot (cap 8). | Med | Wave 2/4 — issue retrieval embeds through an un-pooled/dedicated embed client; §2. |
| R5 | **Chain-expiry (>30d) hard-fails the turn today** with no self-heal. | Med (High once chaining/threading lands) | Wave 1 — rebuild from `compaction_summary`+recent turns on `model_error`+id-sent; emit `tutor.chain.rebuilt`; fallback path already exists at `loop.ts:468-470`. |
| R6 | **Scope leak of incomplete lessons** — retrieving forward material. | High (a non-negotiable) | Wave 3 — eligible-lesson filter **inside the SQL** (A4-11), property test over partial-completion learners (A4-14); predicate = `learn_progress.status='completed'` ∪ active lesson. |
| R7 | **Re-embedding churn / cost** if not keyed to the immutable snapshot. | Low | Wave 2 — key on `publication_id`/`content_hash`; skip when present (A4-9). |
| R8 | **Anchor-less concepts** (live fixtures have them) break `prerequisite_gap` lesson resolution. | Low | Wave 3 — tolerate a prereq that resolves to no lesson (skip/degrade). |
| R9 | **Stale display anchors** after a republish drops a slide/block. | Low | Player already no-ops a missing block (`LearnLessonView`); store version, prefer the current live publication's anchors. |
| R10 | **Mixed legacy vectors** — 44/574 `concept_nodes` carry jsonb embeddings (possibly 32-dim mock in fixtures vs 1536-dim real). | Low | Wave 2 — use a NEW `tutor_chunks` table; do not reuse `concept_nodes.embedding`. |
| R11 | **Pre-apply advisor drift** — not run in this audit. | Low | Wave 1/2 — run `get_advisors` (security+performance) before applying each migration; mirror the enrollment-gated RLS idiom for the new table. |

---

## Embedding cost estimate (largest course = cs61b)

Model **`text-embedding-3-small` @ $0.02 / 1M input tokens** (`modelConfig.ts:415`); tokens ≈ chars ÷ 4; embed once per chunk at publish; query embed = one short string.

| Quantity | cs61b (largest) | All 104 live pubs |
|---|---|---|
| Snapshot chars (JSON, upper bound) | 769,703 | 7,758,121 |
| Harvestable readable text (measured/est.) | ~436,000 (mean 11,483 × 38 lessons) | ~4.4M (est. ~55% of JSON) |
| One-time embed tokens | ~109k (text) … ~192k (full JSON UB) | ~1.1M … ~1.94M |
| **One-time embed cost** | **≈ $0.0022 (text) … $0.0038 (UB)** | **≈ $0.022 … $0.039** |
| Per query (one ~30-tok string) | ~$0.0000006 | — |

**Conclusion: embedding is effectively free.** The single largest course in the database costs **well under half a cent** to embed once; the entire published library is **~2–4 cents**; a query embed is sub-microdollar. Even at `text-embedding-3-large` ($0.13/M) cs61b is ~$0.014. Storage is negligible (≈225 chunks × 1536 × 4 bytes ≈ 1.4 MB/course for cs61b). This confirms the directive's "storage/compute is negligible" premise with real numbers.

---

## Deviations from the directive (must be reconciled before Wave 1)

1. **`lesson_id … references lessons(id)`** (§4 schema) contradicts the tutor tables' deliberate **no-FK-to-draft-content** rule (`…charter.sql:26-29`). *Recommend:* no FK (snapshot node id), or `on delete set null`. **Never** let a draft-lesson delete cascade a thread away.
2. **Missing DROP of `UNIQUE(user_id, course_id)`** + its index (§4 schema shows only `add column`). Mandatory — and code-coupled to `ensureThread.onConflict` (R1).
3. **Missing archive marker** — A4-7 requires "archives rather than deletes; archived thread remains queryable," which needs an `archived_at` (or `status`) column, and the new partial unique must then exclude archived rows. The directive's `create unique index … (learner_id, lesson_id) where lesson_id is not null` is insufficient (and note `learner_id` is the directive's name for the actual column **`user_id`**; the `create unique index … tutor_threads (…)` in §4 is also missing the `on` keyword — treat as directive shorthand).
4. **§2 "two-concurrent ceiling / query embedding exempt"** — the tutor's chat ceiling is the **learner pool = 8** (env `AI_LEARNER_POOL_MAX`), not 2, and **`embed` is currently gated under that same pool** (§2). To honor the intended exemption, A4 must route retrieval embeds through an un-pooled/dedicated client.
5. **Minor:** the A2 columns are on **`tutor_threads`**, not a `tutor_sessions` table (the A2 audit already recorded this deviation); A4's references to "the thread row" are correct.

---

## §10 Checkpoint report — Wave 0

**Wave:** 0 (mandatory read-only audit).

**In-scope deliverables → status:**

| Audit item | Status | Grounding |
|---|---|---|
| A0-1 threads schema / lesson assoc | ✅ Answered | §1 (migration + live + `service.ts`) |
| A0-2 completion predicate | ✅ Answered | §3 (`completion.ts` / `progressService.ts` / DDL) |
| A0-3 pgvector | ✅ Answered | §4 (live `list_extensions`) |
| A0-4 snapshot / chunking unit | ✅ Answered | §5 (`snapshot.ts` / `types.ts` / live cs61b) |
| A0-5 existing embedding/retrieval | ✅ Answered | §6 (`modelClient.ts` / `extraction*` / grep-negative) |
| A0-6 lesson context + token cost | ✅ Answered | §7 (`lessonContext.ts` / `promptLayers.ts` / live measure) |
| A0-7 compaction | ✅ Answered | §7 (`history.ts` / `service.ts`) |
| A0-8 "Go there" (D-8) | ✅ Answered | §10 (`TutorBody.tsx` / `outputContract.ts`) |
| A0-9 suggestion chips (D-9) | ✅ Answered | §10 (`TutorBody.tsx` / `invocationPolicy.ts`) |
| A0-10 response retention | ✅ Answered | §8 (OpenAI docs + `history.ts`/`loop.ts`) |
| A0-11 concept→lesson mapping | ✅ Answered | §9 (`concept_graph.sql` / `queries.ts` / live cs61b) |
| §2 ceiling confirmation | ✅ Confirmed (reading corrected) | §2 (`subagent.ts`) |
| Migration surface | ✅ Delivered | "Migration surface" |
| Risk register | ✅ Delivered (R1–R11) | "Risk register" |
| Embedding cost estimate | ✅ Delivered | "Embedding cost estimate" |

**Files created:** `docs/audits/TUT-A4-audit.md` (this file). **Modified/deleted:** none.

**Deviations from the directive:** 5, itemized in "Deviations" (FK-to-draft; missing DROP of the old unique; missing archive column + partial-unique guard; §2 ceiling/embed-exemption correction; `tutor_sessions`→`tutor_threads` / `learner_id`→`user_id` naming).

**Risk changes for later waves:** the two highest-leverage discoveries lower Wave-2 risk (embedding seam + chunker already exist; pgvector one statement away) and raise one Wave-1 risk (R1: the old-unique DROP is code-coupled to `ensureThread`). R4 (embed not pool-exempt) is a new Wave-2/4 design constraint the directive did not anticipate. R6 (incomplete-lesson scope leak) remains the single most important correctness invariant and is well-supported by the live completion predicate + in-query filtering.

**Method note:** verified live against Supabase (schema, RLS, indexes, extension availability, the 24-thread/65-turn backfill census, the cs61b chunk census, the end-to-end prereq-gap chain, the 44/574 pre-existing node vectors, content_hash distinctness). Nine Opus subagents fanned across A0-1..A0-11 + a completeness critic; every load-bearing claim re-verified.

**Awaiting approval to proceed to Wave 1.**
