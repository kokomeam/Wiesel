# AI Content Agent — request pipeline, calls, and data I/O

> How one chat message becomes model calls, what each call carries, and what the
> agent reads and writes. Written to make **token usage** legible: the last
> section, *Where the tokens actually go*, is the one to read first if you're
> chasing cost. Numbers come from a real auto-approve full-lesson run (2026-06-18,
> `gpt-5.5` / `gpt-5.4-mini`).
>
> Source of truth: `lib/ai/*`. Key files cited inline.

---

## 1. The request (entry point)

A creator's chat message hits **`POST /api/ai/agent`** (`app/api/ai/agent/route.ts`,
Node runtime, Server-Sent Events). The body:

```jsonc
{ "courseId": "...", "lessonId": "...", "message": "build a lesson on X",
  "conversationId": "...", "autoApprove": false }
```

The route authenticates (Supabase), opens an SSE stream, and calls
**`runContentAgentTurn`** (`lib/ai/phases.ts`). Everything below streams back as
events (`lib/ai/events.ts`): `assistant_delta`, `tool_start`, `tool_result`,
`phase`, `plan_outline`, `change_set`, `checkpoint`, `done`.

The OpenAI key is **server-only**; the browser never talks to OpenAI.

---

## 2. The router — one classify call picks the pipeline

`runContentAgentTurn` saves the user message, loads the course doc from Postgres,
then calls **`classifyIntent`** (`lib/ai/intent.ts`) → one of three modes:

| Mode | Trigger | Pipeline |
|---|---|---|
| `edit` | default — a targeted change, question, or single small add | single-turn loop |
| `generate_lesson` | "build a full lesson / deck for THIS lesson" | PLAN → GENERATE → CRITIQUE |
| `generate_module` | "build a module / course / several lessons" | PLAN → GENERATE ×N (no critique) |

Classification is cheap: two regex short-circuits skip the model entirely; only an
ambiguous message makes a **classifier call** (`gpt-5.4-mini`, effort `minimal`,
structured output, ~tiny). It defaults to `edit` on any error.

---

## 3. The pipelines (every model call)

Each phase runs the same primitive — **`runConversationLoop`** (`lib/ai/agentLoop.ts`):
stream a model turn → run each tool call (validate args → apply CoursePatches to
the in-memory doc → stream a `tool_result`) → feed outputs back → repeat until the
model returns no tool calls. Caps: **`AGENT_MAX_TURNS` (16)** per phase, and a
shared **`AGENT_MAX_TOTAL_CALLS` (64)** budget across the whole run. At the end the
doc is reconciled to Postgres **once** and the net block diff is staged as **one**
reviewable change-set.

### 3a. `edit` — the fast path
```
classify → runConversationLoop(layered, full AUTHORING tools)  → reconcile → 1 change-set
            └─ 1..N model calls (gpt-5.5* default, effort medium) until no tool calls
```
No plan gate, no critique. `*` model/effort here is the provider default
(`OPENAI_MODEL`), not a per-call override.

### 3b. `generate_lesson` — PLAN → GENERATE → CRITIQUE
```
PLAN      1 call   gpt-5.5      effort high     structured output (the outline), NO tools, 32k out-budget
  → (approval gate: pause for the creator, or auto-approve)
GENERATE  ~6-10    gpt-5.4-mini effort medium   GENERATE tools, layered teaching bar + the approved outline
CRITIQUE  ~2-4     gpt-5.5      effort high      GENERATE tools, fresh "tough editor" prompt + the deck AS DATA
  → reconcile once → 1 change-set spanning generate+critique
```
- **PLAN** (`runStructuredPlan`) emits a slide-by-slide outline as strict JSON
  (`LessonOutlineSchema`), validated with one repair re-ask. The outline is
  **transient** — round-trips through the client, never persisted.
- **GENERATE** (`generateLesson`) authors the deck through **structured** slide
  tools only (it cannot fall back to a flat deck). The approved outline rides in
  the context as the authoring spec.
- **CRITIQUE** (`runGenerateThenCritique`) is **one fresh-eyes pass** on the smart
  model with the generated deck serialized in as data; it applies the
  highest-impact fixes. Capped at 4 turns.

### 3c. `generate_module` — PLAN → GENERATE per lesson
```
PLAN      1 call   gpt-5.5      effort high     module outline (ordered lessons, each w/ its slide outline)
  → approval gate
for each lesson:  GENERATE  ~6-10  gpt-5.4-mini  medium   (layered, NO critique — deliberate cost trade-off)
  → reconcile once → 1 change-set spanning the whole module
```
All lessons share the **one** `AGENT_MAX_TOTAL_CALLS` budget; when it's spent the
run stops and emits a `checkpoint` instead of continuing.

---

## 4. Anatomy of a single model call (the cost structure)

Every call to `client.responses.stream` (`lib/ai/providers/openai.ts`) sends, in
this order:

```
┌─ instructions (system)  ── STATIC, byte-identical across a phase ──┐  ← caches
│   role + rules + 3 layout catalogs + sticker catalog + (teaching bar)│     hard
├─ tools (JSON schemas)   ── STATIC (filtered to the phase's set) ────┤
├─ input[0] developer msg ── VARIABLE per lesson, stable within a run │
│   COURSE CONTEXT + CURRENT LESSON summary [+ approved outline]       │
├─ input[1..] history     ── replayed conversation (grows per turn)   │
└─ input[..] tool I/O     ── this run's accumulated calls + outputs ──┘  ← uncached tail
```

Key properties (`lib/ai/context.ts`):
- **`buildSystemPrompt()` is static** — no course/lesson/outline in it. That keeps
  the system + tool schemas one cacheable prefix.
- **`buildContextMessage()`** is the variable course/lesson context, sent as a
  leading `developer` message. It's a **summary** (course metadata + one line per
  existing block via `summarizeBlock`), **not** the full deck — so it does not grow
  with deck size.
- The **uncached growth** within a phase is the appended tool calls + outputs: each
  turn re-sends all prior tool I/O. This is why later GENERATE turns cost more than
  early ones (see §7).

Per-call instrumentation: every call logs `{tag:"agent_call", label, turn, model,
inputTokens, cachedTokens, outputTokens, reasoningTokens}`; every phase logs an
`agent_phase` aggregate. Grep those tags in server logs.

---

## 5. What the agent READS (`lib/ai/tools/read.ts`, `slides.ts`)

All read tools are pure over the in-memory doc; they cost only the tokens of what
they return (which then accumulates in the input for the rest of the phase).

| Tool | Returns |
|---|---|
| `get_course_context` | course title/desc/audience/level/plan + the current lesson's block summaries |
| `list_modules` | modules + lesson counts |
| `list_lessons` | a module's lessons |
| `get_lesson` | one lesson's blocks (fuller than the context summary) |
| `get_block` | one block's full content |
| `get_deck` | a slide deck's slides (ids + layout + content) — **large** |
| `get_slide` | one slide's elements/template |

The course context summary is always in the developer message, so the agent
usually only needs `get_deck`/`get_slide` when **editing** an existing deck.

## 6. What the agent WRITES

Every write returns CoursePatches; the loop validates each against
`CoursePatchSchema` and applies it through the **same** reducer the studio UI uses
(`lib/course/patches.ts`). Nothing else mutates the doc.

**Structural** (`tools/structural.ts`) — *excluded from GENERATE/CRITIQUE except `create_block`*:
`create_module`, `create_lesson`, `create_block`, `reorder_blocks`,
`delete_block`, and the destructive `delete_module` / `delete_lesson` (these
**pause** for a creator confirmation dialog before applying).

**Whole-block writers** (`tools/writers.ts`) → `ADD_BLOCK` / `SET_BLOCK_CONTENT`:
`write_slide_deck` (a fresh deck — excluded from GENERATE), `write_quiz`,
`write_homework`, `write_lecture_text`.

**Flat slide ops** (`tools/slides.ts`) → `ADD_SLIDE` / `SET_SLIDE_CONTENT` etc. —
*excluded from GENERATE*: `add_slide`, `update_slide`, `set_slide_layout`,
`reorder_slides`, `delete_slide`.

**Structured slide ops** (`tools/structuredSlides.ts`) → `ADD_SLIDE` / slide
updates — the GENERATE/CRITIQUE authoring surface: `add_structured_slide`,
`set_structured_slide`, `set_text_style`, `add_sticker`.

After the loop, **`reconcileCourseDoc`** snapshots the whole doc to Postgres
(upsert parents→children, delete orphans), and `diffBlocks` stages the net change
as a change-set (amber "pending" blocks → creator Accept/Reject).

---

## 7. Where the tokens actually go (measured)

One **auto-approve full lesson** (`generate_lesson`, plan→generate→critique), real
API, produced a 9-slide deck:

| Phase | Calls | Model | Input | Cached | Uncached in | Output (incl. reasoning) |
|---|---:|---|---:|---:|---:|---:|
| PLAN | 1 | gpt-5.5 (high) | 1,331 | 0 | 1,331 | 12,675 (9,322 reasoning) |
| GENERATE | 9 | gpt-5.4-mini (med) | 265,115 | 219,136 (83%) | ~46,000 | 20,607 (5,288) |
| CRITIQUE | 4 | gpt-5.5 (high) | 226,279 | 136,192 (60%) | ~90,000 | 11,360 (4,511) |
| **Total** | **14** | — | **492,725** | **355,328 (72%)** | **~137K** | **44,642** |

Within a phase, **consecutive calls cache 95–98%** once warm (the static prefix is
working). The aggregates look big because of two things, both expected:

1. **Each phase's first call is cold** (the static prefix isn't in the cache yet).
2. **The input grows every turn** — GENERATE call 0 = 16.4K input, call 8 = 43.6K,
   because every prior tool call + output is re-sent (the uncached tail).

### Cost ranking (what to attack, highest leverage first)

1. **CRITIQUE is the most expensive line.** It's a whole second pass on the
   **smart, high-effort** model (`gpt-5.5`), and it re-serializes the **full deck
   as data** in a fresh prompt that does **not** share GENERATE's cached prefix —
   so only ~60% caches and ~90K input is billed full, on the pricey model. Levers:
   run critique on `gpt-5.4-mini`; drop it to a single call (no 4-turn loop); gate
   it on the `agent_thin_slides` signal instead of running it always; or skip it
   for lessons too (modules already skip it).
2. **GENERATE's accumulating tool history** (~46K uncached, growing per turn). The
   deferred "context trim" lever is now justified by this data: keep only the last
   K tool outputs, or summarize big `get_deck`/`get_slide` reads after they've been
   used. The static prefix is already cached — this tail is the real growth.
3. **PLAN reasoning** — 9.3K reasoning tokens at effort `high` on the smart model.
   Dropping PLAN to `medium` would cut this materially.
4. **Round-trip count** — 9 GENERATE turns made 28 tool calls. Each extra turn
   re-sends the (growing) context. Encouraging fewer, fuller tool calls (batch
   authoring) cuts re-sent input.

### What's already optimized (don't re-do)
- Static-first prompt layout → 95–98% within-run cache hits (verified).
- Tool schemas are **filtered to each phase's allowed set** before sending, so
  GENERATE/CRITIQUE don't pay for the full ~25-tool catalog.
- The whole run reconciles **once** and stages **one** change-set.

### What recent hardening did and did NOT do
The 2026-06-18 changes added: SDK retries (`OPENAI_MAX_RETRIES=5`), per-call
`agent_call` logging, and the `AGENT_MAX_TURNS` / `AGENT_MAX_TOTAL_CALLS` runaway
guard. These improve **resilience and visibility**; they do **not** reduce
per-lesson token usage. The usage cuts are the levers in §7 above (critique scope,
GENERATE tail trim, PLAN effort) — each a separate, scoped change.

---

## 8. Tuning knobs (env, no code)

| Var | Default | Effect |
|---|---|---|
| `OPENAI_MODEL` | `gpt-5.5` | provider default (edit path + fallback) |
| `OPENAI_MAX_OUTPUT_TOKENS` | 16000 | output cap per call (PLAN overrides to 32000 in code) |
| `OPENAI_MAX_RETRIES` | 5 | 429/5xx retries (SDK backoff + Retry-After) |
| `OPENAI_TIMEOUT_MS` | 120000 | per-request timeout |
| `AGENT_MAX_TURNS` | 16 | per-phase step cap |
| `AGENT_MAX_TOTAL_CALLS` | 64 | whole-run model-call budget (module runaway guard) |

Per-phase **model + effort** are set in code (`lib/ai/phases.ts`:
`MODEL_SMART`/`MODEL_CHEAP`), not env — changing critique's model/effort or
skipping it is a code edit, and the single biggest usage lever.
