# Portal split — student vs creator (2026-07-08)

The product now has two portals with role-aware routing. This doc is the
architecture reference for the split; the per-surface details live in
CHANGELOG.md (2026-07-08 entry) and CLAUDE.md.

## The role model

- `profiles.role` — `'creator' | 'learner'` (migration
  `20260708000000_user_roles_portal.sql`). **A routing preference, not a
  security boundary.** Every signed-in user can use both portals: a creator
  can enroll and learn, a learner can open the studio. All real authorization
  stays where it already lived (courses.author_id checks, enrollment RLS,
  SECURITY DEFINER RPCs pinned to `auth.uid()`).
- Stamped at signup from `raw_user_meta_data->>'role'` by
  `private.handle_new_user` (validated against the check constraint's values;
  anything else falls back to `'creator'`). The same trigger rewrite fixed the
  long-standing display-name bug: the form sends `display_name` but the
  trigger only read `name`/`full_name`, so every signup name was dropped.
  Both keys are now sent by the form AND read by the trigger; existing rows
  were backfilled from auth metadata.
- Existing accounts were backfilled to `'learner'` when they had enrollments
  but no authored courses; everyone else stays `'creator'`.

## Routing

| Surface | Route group | Shell | Auth |
| --- | --- | --- | --- |
| Student portal (`/home`, `/my-courses`, `/explore`) | `app/(student)/` | `StudentSidebar` (editor-free, learn-blue accent) | Required |
| Creator portal (`/dashboard`, `/studio`, `/marketing`, `/analytics`, `/exports`, `/marketplace`, `/settings`) | `app/(app)/` | `Sidebar` + `Topbar` | Required |
| Learner runtime (`/learn/[slug]`, `/learn/[slug]/[lessonId]`) | `app/(learn)/` | Minimal public top bar | Public landing; lesson page self-gates |
| Marketing site (`/`, `/educators`), `/login`, `/p/[slug]` | `app/(marketing)/` etc. | Own | Public |

- **Login** (`app/login/page.tsx`): signup shows a two-card role picker
  ("I'm here to learn" / "I'm here to teach"); the default is inferred from
  `?redirectTo=` (learner-shaped paths → learner). Sign-in with an explicit
  `redirectTo` honors it; without one it reads `profiles.role` and routes
  learner → `/home`, creator → `/dashboard` (missing column → `/dashboard`).
- **Middleware** (`lib/supabase/middleware.ts`): the PROTECTED regex now also
  covers `home|my-courses|explore`. When adding a top-level in-app route,
  add its prefix or it silently ships public.
- **Portal switchers**: creator sidebar → "Switch to learner home" card;
  student sidebar → "Switch to creator studio" card. Switching never writes
  `role` — the column only decides the post-login default.
- The `(learn)` shell's signed-in nav links to `/home` and `/explore` (it
  used to point at the creator marketplace).

## Student portal data layer

All learner reads run on the user-scoped client under RLS — no service role
anywhere in the portal:

- `my_learning()` v2 — one row per active/completed enrollment. The old
  version inner-joined the LIVE publication, so an unpublish erased the
  learner's card (including completed courses); v2 joins laterally to the
  live-else-newest publication and exposes `is_live` — the UI renders an
  unlinked "No longer available" card when false. Also returns
  `avg_rating`/`review_count` from `rollup_course_reviews` (definer bypasses
  the author-only rollup RLS deliberately; aggregates only, never bodies).
- `marketplace_listings()` v2 — same rating fields for Explore cards.
- `my_activity_days(p_days)` — the ONE sanctioned learner read over
  `learning_events` (whose table policy is author-select-only by design — do
  NOT add a student select policy; see the ON-CONFLICT/SELECT-policy note in
  the analytics migration). Definer, pinned to `auth.uid()`, returns distinct
  UTC activity dates. Feeds `computeStreak`.
- Continue-hero: live publication snapshot (RLS-readable) + own
  `learn_progress` rows → `buildCourseProgressSummary` (`lib/learn/summary.ts`).
  `continueLessonId === null` means the course is DONE — never fall back to
  lesson 1.
- Quiz review queue: own `quiz_attempts` (explicit `.eq('user_id', uid)` —
  the RLS policy is own-OR-author, so a creator-as-learner would otherwise
  see their students' attempts) → `latestAttemptsPerBlock` → `reviewQueue`
  (< 70%), titles resolved from snapshots (fetches capped at 3 courses;
  unresolvable blocks skipped).
- Pure logic lives in `lib/learn/studentHome.ts`; tested by
  `scripts/verify-student-home.ts`.

**Graceful pre-migration degradation** (until `20260708000000` is applied):
`row.is_live ?? true`, optional rating fields, `profiles.role` read via
`maybeSingle()` falling back to `'creator'`, `my_activity_days` errors hide
the streak tile ("—"). Nothing crashes on the old schema.

## Creator dashboard data layer

`app/(app)/dashboard/page.tsx` (was 100% lib/data.ts mock): courses by
`author_id`, then ONE `.in(courseIds)` batch (live `course_publications`,
`enrollments`, `rollup_course_reviews`, open `agent_findings`, draft
`learner_messages` — all under author RLS), then the spotlight course's
`rollup_lesson_funnel`. Pure aggregation in `lib/analytics/creatorHome.ts`
(tested by `scripts/verify-creator-home.ts`). No revenue data exists (Stripe
unbuilt) — the revenue card is an explicit coming-soon, never fake numbers.

## The learn-blue accent

`--color-learn-50..950` + `.learn-gradient` in `app/globals.css`. A NAMED ramp
because raw `sky-*` already carries three unrelated meanings (studio module
chrome, agent question cards, delivery chips). 60/30/10: paper+white dominate,
brand orange stays the primary action color everywhere, learn-blue marks
student-portal identity (nav active states, progress bars, tutor preview).
Primitives: Badge tone `learn`, Button variant `learn`,
`components/ui/ProgressBar` (`tone: brand|learn|emerald`),
`components/ui/Skeleton` (+ `.skeleton-shimmer`).

## Agent chat status model (editor panel)

Client-side only; the SSE wire protocol (`lib/ai/events.ts`) is untouched.

- `thinking` ends ONLY on `done`/`error`. A mid-run `assistant_message`
  settles the current bubble (`settleAssistantMessage`) without ending the
  turn — previously it called `finishTurn`, which killed the spinner minutes
  early AND dropped all later `assistant_delta`s (the streaming guard).
  `appendAssistant` now opens a fresh streaming bubble when the last one has
  settled.
- `StatusStrip` (above the composer while thinking): humanized phase copy +
  the phase event's `detail` (previously discarded), the running tool's
  friendly label, and an 8s-silence heartbeat ("Still working…") driven by
  `lastEventAt` — non-streaming PLAN calls can be silent for 30s+.
- `lib/ai/toolLabels.ts` is the single tool-name → human-phrase registry
  (present-continuous + done forms + category icon). A drift guard in
  `scripts/verify-agent-ux.ts` fails if a registered tool lacks an explicit
  label — never render raw snake_case.
- The plan modal minimizes (keeps `pendingOutline`, `planModalOpen=false`) on
  Escape/backdrop; Discard is an explicit button only. Checkpoints render a
  Continue button; errors a Try-again.

## Not done / deliberate

- **Migration `20260708000000_user_roles_portal.sql` must be applied to the
  live Supabase project** (it was authored + type-spliced this session, but
  applying to production was withheld for review). Everything degrades until
  then; after applying, role routing / is_live / ratings / streaks light up.
- Tutor chat on `/home` is an explicit no-network PREVIEW (canned replies,
  labeled). Wiring it to a real model is a future milestone.
- `/exports` and `/settings` remain the last lib/data.ts mock pages (out of
  this redesign's scope; the dashboard no longer imports lib/data.ts at all).
- No streak/notification system beyond the activity-days streak tile.
