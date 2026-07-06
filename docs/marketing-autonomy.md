# Marketing Agent autonomy — modes, the revert window, and clarifying questions

How the governance gate routes irreversible actions after the 2026-07-03
redesign. Companion to `docs/marketing-suite.md` (the three spines); this doc
covers spine 3's autonomy layer in depth.

## Grades vs. modes — two orthogonal axes

**Reversibility grades** (declared per tool, unchanged): `read` / `reversible`
/ `irreversible`. They answer *"can this be undone?"* and are enforced in code
(`lib/marketing/gate.ts`), never left to model judgment.

**Autonomy modes** (chosen per course, new): `manual` / `assisted` (default) /
`auto`. They answer *"HOW is the creator's approval obtained for the
irreversible tier?"* — per-action card, or a policy authored in advance.
Modes never touch the read or reversible tiers.

| | read | reversible | irreversible |
|---|---|---|---|
| **manual** | executes | executes + logged, revertable | approval card, always |
| **assisted** | executes | executes + logged, revertable | approval card — but ambiguous targeting asks a clarifying question first, and an owner-addressed test email auto-logs |
| **auto** | executes | executes + logged, revertable | auto-executes ONLY on a clean policy match; anything else → question or card |

The reversible branch never consults the mode — `verify-marketing-autonomy`
pins "reversible is 'staged' under manual/assisted/auto".

## The routing ladder (`runThroughGate`, irreversible tier)

Order is load-bearing:

1. **`interaction: "question"`** (ask_creator) → record a `marketing_question`,
   return `needs_clarification`. Nothing executes.
2. read / reversible → routed before the ladder (see table above).
3. Load the course's autonomy settings (`marketing_autonomy_settings`; no row
   = assisted + EMPTY policy + 24h revert window).
4. **Hard-deny check FIRST** — `HARD_DENY_TOOLS` short-circuits everything.
5. Not hard-denied ∧ mode ≠ manual ∧ the tool's `clarifyTargeting(args, ctx)`
   returns a spec → record a gate-raised `marketing_question` (carrying
   `tool_name` + original args + `paramKey`) and return `needs_clarification`.
   **No pending row is created** — the creator never sees a half-specified card.
6. Run the side-effect-free preview (`approved: false`) — exactly as before;
   the preview also feeds the autonomy facts (audience size etc.).
7. Assemble `AutonomyFacts` (audience, budget, segment key + send history,
   injected clock, owner-email match) and call the PURE engine
   `evaluateAutonomy(mode, policy, facts)` (`lib/marketing/autonomy.ts`).
8. Route:
   - `pending_approval` → insert `status:'pending'` + the full
     `autonomy_decision` audit; return the card payload.
   - `auto_log` / `auto_execute` → execute for real (`approved: true`), insert
     `status:'executed'` + audit + `resolved_at`, record segment history,
     return `status:'executed'`.

`executeMarketingTool` still **throws on unknown tool names** before any of
this — an unregistered tool can never execute, and the engine additionally
refuses to auto-approve any name outside `KNOWN_IRREVERSIBLE_TOOLS`
(drift-guarded against the registry by the verify suite).

## The hard-deny list — never auto-approvable

Checked before mode, before policy, in both the gate and the engine
(defense in depth). Policy configuration cannot override it; the settings UI
renders these disabled.

| tool | why |
|---|---|
| `launch_campaign` | enrolls the whole approved audience into a multi-email sequence AND snapshots `approvedAudienceIds` — the highest blast radius in the suite |
| `cancel_campaign` | terminally kills an in-flight campaign (cancels queued sends) |
| `send_consent_confirmations` | bulk-emails an entire lead list under one action; consent asks are the most reputation-sensitive send |

## The auto-mode policy (`AutonomyPolicy`)

Stored as jsonb on `marketing_autonomy_settings.policy`; parsed tolerantly
(`parsePolicy` — a corrupt policy degrades to EMPTY, i.e. LESS autonomy).
**Every unconfigured field fails closed**: opting a tool in is not enough —
the caps and hours must be set before anything executes without a card. The
empty policy is inert by construction.

| field | semantics | unset ⇒ |
|---|---|---|
| `autoApproveTools` | explicit opt-in list | nothing auto-executes |
| `maxRecipients` | cap per auto-send | any send with recipients → card |
| `maxBudgetCents` | spend cap (no tool spends today; the cap exists so one can never sneak in un-capped) | any spend → card |
| `allowedHours` | `{startHour, endHour, timezone}` (IANA; null tz = UTC; overnight windows supported) | every candidate → card |
| `firstSendToNewSegmentManual` | first send to a segment this course never emailed → card | default **true** |

Guardrails only **narrow**: one failure routes to the card no matter how many
others pass, and the full evaluation (every guardrail, pass/fail/n-a, with
detail strings) is persisted on the ledger row as `autonomy_decision` and
rendered in the activity log.

Segment history (`marketing_segment_send`, unique per course + segment key)
is written whenever a segment send actually **executes** — auto-approved or
human-approved alike; a manual approval teaches the guardrail too.

## Clarifying questions — two sources, ONE pause shape

`marketing_question` rows come from:

- **`ask_creator`** (model-raised) — a narrow interaction tool: ONE specific
  multiple-choice question, 2–5 options, when the agent genuinely can't
  proceed (which list, which sender). The gate intercepts it before grade
  routing; its `execute` never runs.
- **`clarifyTargeting`** (gate-raised) — implemented on `send_broadcast` and
  `enroll_segment_in_sequence`: fires only when `status` is null AND the
  audience spans ≥2 subscriber statuses. The row stores the original args +
  `paramKey` so the answer can complete the call.

Both return the same `needs_clarification` GateOutcome, and the loop has ONE
blocked branch for `pending_approval | needs_clarification` — it emits
`agent_blocked {kind: 'approval' | 'question'}`, persists a short "Paused — …"
tool output, and stops. The loop never learned a second pause protocol.

**Answering in your own words.** Every question card also carries a
"Something else…" free-text path (mirroring Claude's own AskUserQuestion
"Other"): the typed answer is stored as `{value: "__other__", freeText}` and
`answeredMessage` hands the creator's words to the agent VERBATIM with an
instruction to act on them — never coerced into one of the offered options,
and explicitly allowed to redirect the plan entirely. (Gate-raised questions
on a USER's own action skip the automatic tool retry for freeform answers —
there's no param value to merge.)

**The "everyone" trap**: `status: null` means *unspecified* (may ask);
the explicit value `"all"` means *everyone, deliberately*. The question's
"Everyone (N)" option maps to `"all"`, so a retry never re-triggers the same
question.

### Resume — three paths, all in `lib/marketing/agent/resume.ts`

| event | function | message shape |
|---|---|---|
| approve | `resumeAgentAfterResolution` | "✓ Approved & executed: …" |
| deny | `resumeAgentAfterResolution` | "✕ Denied: … Do not retry…" (+ reason) |
| answered | `resumeAgentAfterAnswer` | gate-raised: "✎ … Retry `<tool>` with `<param>` = `<value>`…"; model-raised: "✎ Answered … Continue." |

All three: agent-raised blockers only, one turn, same conversation (questions
store `conversation_id`), never throw, message kept short (the paused call's
full args already live in the transcript — 4000-slice safe). Answers are
recorded even with no OpenAI key (the resume is best-effort on top).

A gate-raised question on a **user-initiated** call resolves differently:
`answerQuestionAction` re-runs the tool with the param merged, and the
resulting approval card renders in the question's place.

## The reversible tier — quiet log + revert window

Unconditional, in every mode (this was the redesign's core bug: 25 reversible
tools rendered blocking Accept/Reject cards):

- Reversible calls execute immediately and appear as **quiet, dismissible
  activity-log entries** — no elevation, no primary button. Pending approval
  cards are the only loud surface.
- One-click **Revert** stays available for the course's window
  (`revert_window_hours`, default 24h, 1–720 configurable). The gate stamps
  `revert_expires_at` from the injected clock; `rejectAction` refuses past
  expiry (fail closed, checked at read + write time — no cron).
- **Dismiss** = `acceptAction` (row → `executed`; the change stays).
- Policy-executed irreversible actions appear in the same log with an
  "auto · policy" chip + the decision reason — audited, never revertable.

## The one-card approval flow

`components/marketing/ApprovalCard.tsx` — used identically in the agent chat,
the hub inbox, the campaign builder, and the leads page:

- Full preview INLINE (subject, body excerpt, audience + segment, launch
  checklist), fed by `effectLabel` + `bodyPreview` on each irreversible tool's
  preview. Hub/builder pages re-run the side-effect-free preview server-side
  (`previewMarketingAction`) so counts stay truthful to CURRENT state.
- Exactly three actions: **Approve & {effect}** (one click, no nested
  confirm), **Edit** (inline form over the tool's `editableParams`, re-runs
  the preview via `editPendingAction`), **Reject** (optional note flows into
  the agent's resume).
- Request buttons (`publish/launch/cancel/test/consent`) return the pending
  payload so the card renders **where the creator clicked** — the old
  request-here-approve-elsewhere two-step is gone.
- `approveMarketingAction` claims the row atomically (`pending → 'approved'`)
  before executing; a double-click loses the claim and sees "already
  resolved" — never a duplicate send. A failed execute releases the claim
  back to `pending` (retryable).

### Cross-surface sync (2026-07-06)

The same pending action (or clarifying question) can be rendered on several
surfaces at once — chat, hub inbox, builder, leads. The DB row was always the
single source of truth, but nothing invalidated an already-rendered copy, so
approving on one surface left a stale, still-clickable card on the others.

- **`lib/marketing/approvalSync.ts`** — an in-memory zustand store keyed by
  `actionId`/`questionId`, mirrored across tabs via a `BroadcastChannel`.
  Every `ApprovalCard`/`QuestionCard` subscribes by its id and collapses the
  moment ANY surface resolves it; resolutions are first-writer-wins (a vaguer
  "resolved elsewhere" never overwrites a concrete approved/denied). No
  persistence — the server list is authoritative on the next load.
- **Stale clicks tell the truth** — `approvePendingAction`/`denyPendingAction`
  check the row's status first and return `alreadyResolved: true` ("Already
  handled — resolved elsewhere") instead of the old asymmetry (approve threw,
  deny silently no-op'd as success). The card collapses to a neutral
  "Handled" line.
- **The resume is no longer headless** — the server action captures the resumed
  run's events (`resumeAgentAfterResolution/AfterAnswer` take `emit`), folds
  them via the pure `followUpFromEvents` (`lib/marketing/agent/events.ts`)
  into `ActionResult.agentFollowUp`, and the resolution carries it through
  the sync store. The chat panel (`AgentPanel`) replays it as transcript
  items — including a NEW approval/question card when the resumed run blocks
  again — so the wrap-up contract ("what executed, what happens next, with
  timing") is actually seen, even when the approval happened on the hub.
- **Resume lands in the right thread** — `marketing_action.conversation_id`
  (migration `20260706000000`) stores the conversation an agent-requested
  action paused; the approval resume passes it instead of relying on
  "most recent conversation for the course".

Verified by `npm run verify:marketing:sync` (pure).

## Settings surface

`components/marketing/AutonomySettings.tsx` on the Marketing hub: three mode
cards + the auto-only policy form (tool checklist with hard-denied entries
locked, recipient cap, allowed hours, first-send toggle, revert window).
Saved via `updateAutonomySettingsAction`, which strips hard-denied tools
server-side regardless of what the client sent.

## The invariants and where they're pinned

All in `scripts/verify-marketing-autonomy.ts` (`npm run
verify:marketing:autonomy`, pure checks first, then live):

1. **Unknown tool fails closed** — `executeMarketingTool` throws, nothing
   recorded; the engine never auto-approves an unknown name even when
   allow-listed; drift guard ties `KNOWN_IRREVERSIBLE_TOOLS` to the registry.
2. **Hard-deny holds everywhere** — 3 tools × 3 modes × maximally permissive
   policy → all pending (pure sweep + live launch/cancel under a policy that
   allow-lists them).
3. **Deny ⇒ never executed** — provider send-count unchanged, page stays
   draft, row `rejected`.
4. **One guardrail fails ⇒ card** — every permutation pure + the live ladder
   (null caps / null hours / outside hours / unseen segment each alone), then
   the clean match auto-executes exactly once.
5. **Reversible never pends** — staged under all three modes; window stamped;
   expired revert refused; dismiss resolves.
6. **Governance language intact** — the system prompt still declares
   IRREVERSIBLE / explicit approval / cannot bypass.

Plus: owner/foreign test-email routing, gate + model questions pausing through
one shape, answer idempotency, resume-in-same-conversation, the approve race,
and segment history from both approval paths.
