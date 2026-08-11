# Tutor threading — lesson-scoped conversations (TUTOR-1 Amendment A4)

How the tutor conversation is **scoped, bounded, and recovered**: one thread per
learner per lesson, rolling compaction, transparent chain-expiry recovery, and
why no thread is ever reset automatically. Companion: `retrieval.md`,
`docs/audits/TUT-A4-audit.md`.

Code: `lib/tutor/runtime/{service,loop,compaction,streamState,history,runtimeEvents}.ts`,
`lib/learn/{useTutorStream,tutorHistory,tutorHome}.ts`. Schema: `tutor_threads`
(migrations `20260804100000` + `20260810120000`).

## Thread resolution (Wave 1)

Before A4, the tutor had one unbounded thread per **(learner, course)**. A4
re-scopes to one **ACTIVE thread per (learner, LESSON)** — the lesson is already
the tutor's scope boundary in the URL, so it is now the conversation boundary too
— plus a single **general (null-lesson) thread** per (learner, course) for turns
sent outside a lesson (the course landing).

`tutor_threads` gained `lesson_id` (a snapshot node id, **no FK** — the tutor
tables deliberately hold no FK to draft content, since a draft node may be deleted
while a thread lives), `archived_at`, `compaction_summary`, and
`compacted_through_turn`. The old `UNIQUE(user_id, course_id)` was **dropped** and
replaced by two PARTIAL uniques that exclude archived rows:

```
unique (user_id, lesson_id)  where lesson_id is not null and archived_at is null   -- one active thread / lesson
unique (user_id, course_id)  where lesson_id is null     and archived_at is null   -- one active general thread / course
```

`resolveThread(admin, {userId, courseId, lessonId})` (`service.ts`) is a race-safe
get-or-create — SELECT the active row → INSERT → on a 23505 unique-violation race,
re-SELECT (a partial unique can't be a PostgREST `onConflict` arbiter, so this
does NOT use upsert). Opening the tutor on a lesson resolves the **same** thread
every time; a **different** lesson resolves a **different** thread; the general
(null-lesson) thread is distinct again.

**Backfill.** Existing threads were attributed to a lesson only when their turns
named exactly one lesson (2 of 24 live); the rest stay `lesson_id` null — readable
legacy general threads that are never extended (opening a lesson mints a fresh
per-lesson thread beside them).

**Multi-thread reads.** Every `(user, course)` single-row read was fixed for the
new one-thread-per-lesson world: `readActiveStream` (resolves the in-flight thread
by `active_stream_id is not null`), `loadTutorHomeEntries` (latest turn per
`course_id`, thread-count-agnostic), `loadTutorHistory` (takes a `lessonId`), and
the `apply_escalation_reply` RPC (migration `20260810130000` — its
`ON CONFLICT (user_id, course_id)` referenced the dropped constraint).

**Outline indicators.** `loadTutoredLessonIds` marks lessons with a non-empty
conversation; the course outline (`CourseNavSidebar`) renders a dot
(`data-ai-tutor-thread`). The outline is the conversation history index — no
separate chat-history navigation is built.

## Compaction (A4-4)

A long thread is bounded for the MODEL by the L4 replay window
(`HISTORY_MAX_TURNS` newest turns). Compaction preserves the memory that window
drops: once a thread crosses a turn/char threshold, the turns older than the keep
window are folded into a rolling `compaction_summary` and the fold cursor
`compacted_through_turn` advances.

- Pure logic: `compaction.ts` — `shouldCompact` / `compactionPlan` (fold
  `[cursor, total − keepRecent)`) / `buildCompactionInput` / `clampSummary` /
  `assembleReplayWithSummary` (summary + windowed verbatim replay; **byte-identical
  to the pre-A4 replay when there is no summary**).
- IO: `maybeCompactThread` (`service.ts`) runs at turn START (so the summary is
  always persisted before it is used and the whole path is int-testable),
  best-effort (a failure never fails a turn), using a small-tier summarizer.
- Config (env, call-time): `TUTOR_COMPACTION_TURN_THRESHOLD` (24),
  `TUTOR_COMPACTION_CHAR_THRESHOLD` (24k), `TUTOR_COMPACTION_KEEP_RECENT`
  (= HISTORY_MAX_TURNS), `TUTOR_COMPACTION_SUMMARY_MAX_CHARS` (2k).

**The learner sees the full transcript; the model sees a bounded window.** These
are separate concerns: `loadTutorHistory` returns every turn of the active thread
for display, while the loop's L4 is the summary + the recent window. Compaction
only changes what the model reads, never what the learner reads.

## Chain-expiry recovery (A4-5)

OpenAI stores Responses for **30 days** by default; a `previous_response_id` older
than that is rejected. When provider-side chaining is on
(`TUTOR_ENABLE_CHAINING`, default off) and the model rejects a stale/expired
anchor (`finishReason === "error"`, `errorKind === "model_error"`, an id was
sent), the loop recovers **transparently**: it rebuilds the input from the
compaction summary + the textual replay the chained path had dropped, retries
ONCE without the anchor, and emits **`tutor.chain.rebuilt`** with the reason. The
learner sees no error. (Pre-A4 this path was a hard turn failure with no
self-heal.)

## "Start fresh" — archive, never delete (A4-7)

The tutor panel header has an explicit **Start fresh** control
(`data-ai-tool=tutor-start-fresh`). It calls the `archive_thread` POST action →
`archiveThread` sets `archived_at` (never deletes; the archived thread stays
queryable) and clears the transcript locally; the next turn opens a fresh thread
for the same lesson (the partial uniques exclude archived rows, so this is legal).

## Why there is NO automatic reset

A thread is **only** reset from the explicit Start-fresh control — never on
refresh, navigation, tab close, or any session boundary. Accidental refreshes are
common and mobile browsers reload backgrounded tabs unprompted; unpredictable data
loss reads as broken software. Switching lessons reloads the *new* lesson's thread
(a different conversation) but leaves the old thread untouched.

This is enforced + asserted (`verify-tutor-threading.ts`, A4-6): `archive_thread`
appears ONLY in `useTutorStream.startFresh`; there is **no** `beforeunload` /
`pagehide` / `visibilitychange` / `unload` listener anywhere in the tutor client;
and `startFresh` is wired to an `onClick`, never a `useEffect`/cleanup.

## Tests

- `verify:tutor` → `verify-tutor-threading.ts` (compaction thresholds + L4
  assembly, the chain-rebuild loop path, the no-auto-reset source assertion).
- `verify:tutor:int` → `verify-tutor-threading-int.ts` (per-lesson resolution,
  legacy-thread survival, archive-not-delete, compaction persist+fold with the
  transcript preserved, outline exactness). Migration apply + rollback proven via
  a rolled-back `DO` block; the changed turn path re-verified by
  `verify-tutor-stream-int.ts` + `verify-tutor-route-int.ts`.
