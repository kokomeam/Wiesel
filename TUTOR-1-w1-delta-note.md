# TUTOR-1 — W1.0 Post-Merge Delta Note

Date: 2026-08-03 · Tree: `main` @ `d2ea512` (pushed) · Governs: Wave 1 only.
Scope per the execution order: a delta pass against the Task 0 audit, not a second audit.

## 0. P-1 correction (recorded fact vs. observed state)

§0 of the execution order records P-1 COMPLETE ("the tree you are in is the reconciled
tree"). **On arrival it was not**: local `main` sat at `f1609e4` with the entire
learner-platform line (M7 comms delivery → PERF-1, 16 migrations, `.github/` CI, the
Task 0 audit) uncommitted, while origin/main was 17 commits ahead with the worktree's
clips/social-publishing/UI-1 line. No commit divergence existed (local was a strict
ancestor), so the reconciliation was completed as a W1.0 pre-step rather than stalling:

- `ec8e68f` — the learner-platform line committed (291 files);
- `20b44b4` — merge of origin/main; 15 conflicts resolved (semantic unions: UI-1
  tokens + local variant APIs kept; UI-1 hub page shape + PERF-1 streamed previews
  grafted; `PostEditor.tsx` un-binaried — a literal NUL byte in source became the six-char backslash-u0000 escape);
- `d2ea512` — integration fixes driven by the FULL verify chain + tsc + `next build`,
  all green end-to-end (incl. `verify:ui` 153, `verify:publish-path` 145 after
  AC-MD.5 fence compliance; ui-snapshots re-recorded with drift reviewed);
- `lib/database.types.ts` regenerated from the live project — safe here because the
  live DB (56 applied migrations) already contained BOTH lines; tree == DB now.
- Pushed: `071feab..d2ea512 main -> main`.

Marketing-side follow-up (out of TUTOR-1 scope, flagged for the marketing workstream):
the UI-1 hub page no longer calls `loadMarketingHub` / the `20260717100800` bundle
RPC (its feed needs `summary_fields` the RPC predates). The RPC stays applied +
unused until the hub is re-bundled.

## 1. Inngest verification → **D-1 Branch A CONFIRMED**

Inngest is fully wired (dep `inngest@^4.13.0`, package.json:95). Conventions TUTOR-1
extends:

- **Client** `lib/inngest/client.ts` — `new Inngest({ id: "wisesel" })`; env
  `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` (prod), `INNGEST_DEV=1` (dev);
  no middleware.
- **Serve route** `app/api/inngest/route.ts` — `runtime = "nodejs"`, exports
  GET/POST/PUT from `serve()`, all functions registered in its `functions` array.
- **Functions** `lib/inngest/functions/publish.ts` — id kebab-case
  (`social-publish-fire`, `social-publish-sweep`); event trigger + `cancelOn`
  with `match: "event.data.<key> == async.data.<key>"`; `step.sleepUntil` for
  precise timing; `step.run("<verb>-<n>", …)` naming; a 5-min cron sweep as the
  reconciliation backstop for lost events/crashed runs.
- **Events** `lib/inngest/publishEvents.ts` — names `"social/publish.requested"` /
  `"social/publish.released"` (`{domain}/{noun}.{verb}`); send helpers are
  best-effort (log + never throw; the sweep reconciles losses).
- **Dev**: `npx inngest-cli@latest dev` auto-discovers `/api/inngest`; a dev-only
  reachability probe (`/api/marketing/publish/dev-status` → `127.0.0.1:8288/health`)
  backs a dev banner. E2E scripts (`scripts/e2e-inngest-*.ts`) are tsconfig-excluded.
- **vercel.json** carries only the marketing tick cron — Inngest crons live in the
  function definitions, nothing Inngest-shaped belongs in vercel.json.

**TUTOR-1 adoption**: events `tutor/graph.extraction.requested` and
`tutor/graph.reconciliation.requested`; functions `tutor-graph-extract` /
`tutor-graph-reconcile` in `lib/inngest/functions/tutorGraph.ts`, registered in the
same serve route; publish-hook sends best-effort; idempotency keyed by run id in
event data. No pg_cron, no vercel.json entry (Branch B is dead).

## 2. Migration tail + types

- Repo tail: `20260802100000_marketing_action_summary_fields.sql` (remote line);
  latest local-line migration `20260718100100_perf_vitals.sql`.
- Live project: 56 migrations applied — the union of both lines, verified via the
  management API (`list_migrations`). Nothing in the tree is unapplied; nothing
  applied is missing from the tree.
- `database.types.ts` regenerated from live at `d2ea512` → current by construction.
- **TUTOR-1 timestamps are hereby frozen at `202608031000xx`** (after the tail).

## 3. Load-bearing citations (re-verified at symbol level, post-merge)

1. `learning_events` event_type CHECK — latest re-creation in
   `20260718100100_perf_vitals.sql:27-32` (16 types, `perf_vital` app-scoped);
   envelope CHECK :74-77 (`comms_email_%` OR `perf_vital` OR full course envelope);
   course CHECK :56-57. **No later migration touches it** → the tutor extension
   drops/re-adds from THESE bodies.
2. `ingest_learning_events` current body — same file :86-149; scope guards skip
   `perf_vital` only; the tutor extension adds `tutor_%` to the REJECT path
   (client batch must never carry server-only types).
3. `lib/ai/changeSet.ts` — `inversePatches` unknown-node_type error at :271 (chain
   block→lesson→module, :200 default "block"); `rejectChangeSet` unconditional
   `loadCourseDoc` at :338; revert is compute-first/all-or-nothing (:285-305,
   comment :342-343). §5.3 extension plan lands in W1.2 exactly here.
4. Publish seam — `lib/course/publish/service.ts:218` `PublishRpcResultSchema.parse`;
   hook inserts between :218 and the `getLatestPublication` refetch (:219).
5. `getCachedSnapshot(publicationId)` — `lib/learn/publicationCache.ts:163-177`,
   keyed `["publication-body", publicationId]`.
6. `withSemaphore` — **9 call sites now** (audit said 5; the social merge added
   clips/social/postingKit sites): maintenance.ts:375, clips/selection.ts:448,
   social/generate.ts:281, social/service.ts:78/491/533, clips/postingKit.ts:188,
   + 2 in verify-maintenance.ts. The W1.1 pool work stays additive (second-param
   seam already exists); the keyed-pool promotion remains tutor-scoped.
7. `stageStructureChangeSet` — `lib/ai/agentLoop.ts:361-368`; the ordering
   convention is `reconcileAndStage` (:433-440): persist rows FIRST, then stage.
8. `20260701000000_structural_change_set_items.sql` — node_type CHECK
   ('block','lesson','module') :23-24; identity constraint :38-41. Present
   post-merge; migrations touching `change_set_items` since: `20260703000000`
   (evidence column), `20260717100100` (RLS), `20260717100500` (studio bundle RPC
   reads it). The W1.2 rail extension must therefore also update the
   `studio_course_bundle` RPC's pending-item payload and the studioLoad enum in
   lockstep (as the order already requires).
9. `lib/ai/modelConfig.ts` — `AI_PHASE_MODELS` idiom confirmed (env-overridable
   `{model, effort}` via `effort()/bool()/int()` helpers, `satisfies PhaseModel`,
   `as const`). `TUTOR_MODELS` lands in this file, same idiom + timeoutMs/
   maxRetries/maxOutputTokens + the sol deny-list.
10. `serverEmit` — upsert `onConflict: "client_event_id", ignoreDuplicates: true`;
    `emitServerEvent` never throws; `emitCommsDeliveryEvent` reports
    inserted/duplicate/error. `tutor_model_call` emission follows the former
    (best-effort — telemetry must never break a pipeline step).

## 4. Conflict scan (merge deltas on Wave-1 surfaces)

- `change_set_items`, `learning_events`, `lib/ai/modelConfig.ts`, `lib/ai/subagent.ts`,
  `lib/ai/changeSet.ts`, `lib/course/publish/service.ts`: **no remote-side changes**
  — the social line never touched them. Line numbers in the Task 0 audit for these
  files remain valid.
- `.env.example`: gained `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` / `INNGEST_DEV`
  (~:197-202). The TUTOR-1 env banner appends after these.
- `vercel.json`: unchanged by the merge (marketing tick only).
- New adjacent code TUTOR-1 must respect: `lib/inngest/*` (extend, don't fork),
  the AC-MD.5 vocabulary fences on the social surface (tutor UI is elsewhere;
  no interaction), `verify:ui` raw-value fence (tutor UI in Waves 4-5 must use
  the token vocabulary).

## 5. Governing-document note

`TUTOR-1-checkpoint1-resolution-amendment-A1.md` and
`TUTOR-1-implementation-directive.md` are not files in this repo. The Wave 1
Execution Order (message form) restates every operative resolution it invokes
(R-5, R-9, R-10, R-11, R-13, R-21, R-23, D-1, D-3, AC-T1.7a/b split) and is
treated as the binding text; where it references un-restated amendment detail
(Wave-2 mastery redistribution semantics), Wave 1 records lineage sufficient for
it (AC-T1.7a) and defers interpretation to Wave 2.

**No deltas contradict the Amendment's resolutions. Wave 1 proceeds on Branch A.**
