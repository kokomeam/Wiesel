# Publishing — the version/snapshot model

How WiseSel takes a draft course live, and why learners can never see (or be
broken by) draft edits. Source of truth: `lib/course/publish/*` + migrations
`20260702020000_publishing.sql` / `20260702020100_publishing_hardening.sql`.

## The model

- **The draft is the only editable thing.** The studio (and every AI agent)
  edits `courses → modules → lessons → blocks` freely, at any time.
- **Publishing takes an immutable snapshot.** `publish_course` (a SECURITY
  DEFINER RPC — the only writer of `course_publications`; the table has no
  insert policy) runs one transaction: verify authorship → lock the course row
  → bump `version` → retire the previous `live` row → insert the new
  publication + its quiz answer keys → mirror `courses.status`.
- **Immutability is enforced in the database.** A BEFORE UPDATE trigger rejects
  any change to `snapshot` / `version` / `content_hash` / `published_at` /
  `created_by`. Only `status`, `visibility`, and `slug`/`previous_slugs` stay
  mutable (unpublish/restore, public/unlisted, renames).
- **Learners read snapshots only.** The `/learn/*` runtime resolves the LIVE
  publication; the draft tables never open to students
  (`courses.visibility` deliberately stays `private`).

## Node-id stability (everything hangs off this)

Module/lesson/block/slide/question ids in the snapshot are the DRAFT ROW IDS,
preserved verbatim. Consequences:

- `learn_progress`, `quiz_attempts`, `learning_events`, and every analytics
  rollup stay JOINABLE across republishes.
- Quiz attempt numbering continues across versions (a retake after republish is
  attempt N+1, not a fresh 1).
- The maintenance agent's findings (`agent_findings.targets`) address draft
  nodes directly — a proposal deep-links into the editor by the same ids the
  learner data reported.

## Answer-key isolation

`correctChoiceId(s)` / `correctAnswer` / `expectedAnswer` / `acceptedAnswers` /
`explanation` are STRIPPED from the snapshot into `quiz_answer_keys`
(publication_id + block_id), a table with **RLS enabled and ZERO policies** —
not even the author's client can read it. Grading (`lib/learn/grading.ts` via
the service role) is the only consumer; the published-quiz Zod schema is strict
so an unstripped question fails validation, and `findAnswerKeyLeaks` deep-scans
before every publish. One deliberate definer-side exception: the analytics
rollup resolves each question's correct-answer BUCKET into
`rollup_question_stats.key_value` at rollup time so the dashboard's distractor
flag never needs the admin client.

## Slugs & renames

- First publish slugifies the title, suffixing against live slugs. Republish
  inherits the slug and bumps the version; an IDENTICAL republish (same
  `content_hash`) is a no-op, not a version bump.
- Uniqueness is "one live publication per slug" (a partial unique index), NOT a
  global column — so v2 can reuse v1's slug.
- Renames append the old slug to `previous_slugs`; `/learn/<old>` redirects.

## Republish semantics

- The previous live row flips to `unpublished` in the same transaction — there
  is never zero-or-two live versions.
- Learner history survives: progress/attempts join by stable node ids; the quiz
  route grades against the publication the learner SAW (fetched by id), so a
  mid-session republish can't break a submission.
- Analytics rollups are keyed by `(course_id, publication_id, version)` — a
  republish starts fresh live-version rollups while old versions remain for
  historical drill-down.

## Where the maintenance agent fits (the draft-only rail)

The agent NEVER touches this surface: it edits the draft exclusively, through
the same change-set review pipeline as a human, and nothing it can call inserts
into `course_publications` (RPC-only writes + no insert policy make that
structural, and `verify:maintenance:int` asserts it). Publishing the agent's
accepted fixes is always an explicit human act.

## Tests

`npm run verify:publish` (pure: slug/hash/snapshot-strip/preflight/diff) and
`npm run verify:publish:int` (live: the full RLS matrix, DB immutability,
draft-edit independence, version retirement, enrollment gating, slug flows).
