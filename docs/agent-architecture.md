# Agent architecture — orchestrator, subagents, budgets, triggers, safety rails

How WiseSel's AI edits courses, and how the Milestone-5 maintenance agent
composes on top of it. Source of truth: `lib/ai/*` (esp. `agentLoop.ts`,
`subagent.ts`, `maintenance.ts`) + migration
`20260703000000_maintenance_agent_comms.sql`.

## The substrate (one loop, one write path)

- **One provider seam**: `ModelClient` (`modelClient.ts`); OpenAI Responses API
  in `providers/openai.ts` (the only file importing the SDK), a deterministic
  mock in `providers/mock.ts` (scripted turns + name-keyed structured outputs +
  `getCalls()`).
- **One loop**: `runConversationLoop` — stream a turn → execute tool calls →
  feed results back → repeat under caps. Tools are PURE over the in-memory
  `CourseDocument` and return `CoursePatch`es; the loop owns apply / persist /
  change-tracking / streaming. **Every mutation flows through the same
  Zod-validated patch pipeline the human editor uses** — the agent has no
  private write path.
- **One review surface**: change-sets. Mutations apply + persist immediately
  but stay flagged pending; the creator Accepts (flag clears) or Rejects (the
  inverse replays through the patch pipeline, atomically).
- **Five intents** (`intent.ts`, regex short-circuits + a cheap classifier):
  `edit` · `generate_lesson` · `generate_module` · `structure` · **`analyze`**
  (learner-analytics questions → the maintenance orchestrator; its regex runs
  FIRST so "why are students dropping off in module 3" never routes to a build).

## The subagent primitive (`lib/ai/subagent.ts`)

`runSubagent({ c, role, systemPrompt, context, userMessage, outputSchema,
outputName, tools?, doc?, lessonId?, maxTurns, tokenBudget })`:

- `tools` set → runs the EXISTING loop with `allowedToolNames` (an arbitrary
  allow-set) and `persist:false` (nothing written to the conversation tables —
  replay lives in `agent_runs.report`), then spends one structured call
  converting its closing analysis into the Zod-validated result. No `tools` →
  a pure one-shot structured call.
- **Concurrency**: `withSemaphore(model)` decorates the ModelClient so every
  downstream call — loop turns and one-shots, across concurrent subagents —
  shares ONE global semaphore capped at
  `MAINTENANCE_MAX_CONCURRENT_MODEL_CALLS` (default **2**).
- **Budgets**: one shared `CallBudget` (`MAINTENANCE_MAX_CALLS`, default 40)
  + one token budget (`MAINTENANCE_MAX_TOKENS`, default 300k) across the whole
  run. **Graceful truncation**: a loop that exhausts mid-flight spends its last
  call on the verdict over what it gathered (`{ok:true, truncated:true}`);
  orchestrator-level exhaustion skips remaining findings into `report.skipped`
  (they stay `open` for the next run).

## Tool-access matrix

| toolset | contents | used by |
|---|---|---|
| `ANALYST_TOOL_NAMES` | the 6 analytics reads (`get_course_health_summary`, `get_lesson_funnel`, `get_question_item_stats`, `get_slide_dwell_outliers`, `get_struggling_learners`, `get_learner_profile`) + content reads (so evidence can QUOTE question wording) | Analyst |
| `REMEDIATION_TOOL_NAMES` | `AUTHORING_TOOL_NAMES` (writers + slide ops; NO structural/destructive/confirm-pausing tools) + 2 analytics reads | Remediation |
| — (no tools) | pure structured call | Comms |

Analytics reads are a **capability injection** (`ToolContext.analytics`, the
`visuals` precedent): rollups + snapshot maps pre-loaded once at run start,
tools are pure lookups with compact, capped JSON output; NO learner emails ever
enter a prompt. Confirm-pausing tools (`delete_module`/`delete_lesson`) are in
no subagent set — an unattended run can never stall on a human dialog.

## The maintenance orchestrator (`lib/ai/maintenance.ts`)

```
run (agent_runs row: queued→running→completed|failed)
 ├─ load draft + live publication + analytics capability
 ├─ ANALYST (loop, read-only) ─→ InsightReport{summary, findings[]}
 ├─ dedupe/prioritize (adopt open threshold findings; severity-desc; CAP 5)
 ├─ persist findings (agent_findings, open→proposed lifecycle)
 ├─ dispatch:  REMEDIATION per content finding — SEQUENTIAL over the shared
 │             draft doc (no doc races; concurrency lives in the semaphore) —
 │             each staging ONE change-set whose EVERY item carries the
 │             finding's evidence (change_set_items.evidence → the evidence
 │             card above Accept/Reject — the core product moment)
 │        ∥    COMMS per learner-risk finding — drafts a learner_messages row
 │             (template-grounded, model-personalized, deterministic template
 │             fallback). NEVER sends.
 └─ settle: agent_runs.report = {insight, dispatched, skipped, transcripts},
            budget_used; chat runs also save one assistant summary.
```

Finding lifecycle: `open` (threshold-filed) → `proposed` (a change-set/draft
attached) → `accepted` | `dismissed` (the change-set route transitions them on
Accept/Reject; a recurring problem may re-file later).

## Triggers

1. **Chat** — the `analyze` intent; `parseAnalysisScope` narrows "module 3" /
   "lesson 2" / a quoted title to lesson ids; streams over the existing SSE
   protocol (one additive `maintenance` event member).
2. **Scheduled** — weekly pg_cron (`0 4 * * 1`) QUEUES `agent_runs` rows in-DB
   (courses with a publication + ≥1 enrollment, no queued/running run);
   `POST /api/ai/maintenance/cron` (guarded by `Authorization: Bearer
   CRON_SECRET`, admin client, one run per invocation) drains the queue. The
   creator opens the studio to a ready report + staged proposals.
3. **Threshold** — the nightly rollup files open `agent_findings`; the studio
   header shows an "N findings" badge and the agent panel offers "Review
   flagged issues", which runs a chat-triggered analysis that ADOPTS them.

## Safety rails (invariants — all test-asserted)

- **Draft only.** Nothing in the maintenance path can write
  `course_publications` (RPC-only inserts + no insert policy make it
  structural).
- **All writes through change-sets**, reviewable and atomically rejectable.
- **No sends, ever.** `CommsProvider.send` is reachable from exactly ONE
  function — `lib/comms/service.ts approveAndSend` — called only from the
  human-initiated authed route; the orchestrator and cron never import it
  (grep-able invariant). Opt-out (`enrollments.comms_opt_out`) is re-checked
  AT THE SEAM on every send.
- **No enrollment mutation** by any agent path.
- **Fully logged + replayable**: `agent_runs.report` carries the report,
  dispatch map, and per-subagent transcripts; `budget_used` the spend.

## Tests

`npm run verify:maintenance` (35 pure — incl. the ≤2-in-flight semaphore
assertion under 6 concurrent calls, budget truncation, dedupe/adoption/cap,
intent routing, scope parsing, tool shapes) · `verify:maintenance:int` (25 vs
live Supabase + the mock model — the full acceptance: seeded bad-quiz fixture →
scheduled run → evidence-annotated proposal → Accept applies → Reject restores
byte-for-byte → budgets + every rail asserted) · `verify:comms` (27) ·
`verify:comms:int` (20 — opt-out enforced at the seam). Seed:
`npm run seed:fixtures`.
