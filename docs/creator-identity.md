# Course covers + creator identity (2026-07-11)

How course cover images, public creator profiles (avatar / headline / bio +
stats), and the redesigned `/learn/[slug]` landing fit together. Companion to
`docs/publishing.md` (snapshots) and `docs/portal-split.md` (roles/portals).

Migration: `supabase/migrations/20260711000000_course_covers_creator_identity.sql`.
Pure checks: `npm run verify:identity` (90). ⚠ As of 2026-07-11 this migration
— and its predecessor `20260708000000_user_roles_portal.sql` — is **written
and were APPLIED to the live project on 2026-07-14** (in filename order). The
degradation matrix below is kept as the contract for FRESH environments. Every
consumer degrades gracefully until then (see the matrix below).

---

## 1. Schema

| Object | What | Notes |
|---|---|---|
| `courses.cover_image_url` (text, nullable) | The course cover | **Live-mutable CARD metadata, deliberately NOT snapshotted** (the M2 rule: card metadata never snapshots). A creator can refresh the cover without republishing. Written by the author through the existing `courses` update policy; the public reads it ONLY via the definer RPCs. |
| `profiles.headline` (text ≤120) | Creator one-liner | CHECK-capped; mirrors `PROFILE_LIMITS.headline` in `lib/profile/schema.ts`. |
| `profiles.bio` (text ≤2000) | Creator bio | CHECK-capped; mirrors `PROFILE_LIMITS.bio`. |
| `profiles.avatar_url` | Creator photo | **Not added here** — existed since the core schema. |

`profiles` RLS is select-using-true (world-readable since the core schema), so
headline/bio/avatar are **public by design — never put private data there**.
The CHECKs are drop-then-add (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`)
so the migration stays idempotent; NULL passes both.

## 2. RPC contract

### `course_landing_extras(p_course_id uuid)` — new

`security definer`, `stable`, granted to **anon + authenticated** (revoked
from public first). Returns **zero rows unless the course has a live
publication** (any visibility — unlisted landings possess the link); unpublish
⇒ zero rows ⇒ the landing hides the cover/creator/stats sections.

Definer access is what lets it read `enrollments` and
`rollup_course_reviews` (author-only under RLS) — but it exposes **card-safe
aggregates only**: counts and a weighted average. Never emails, never review
bodies, never enrollment rows.

| Column | Type | Meaning |
|---|---|---|
| `cover_image_url` | text | `courses.cover_image_url` |
| `creator_id` | uuid | `courses.author_id` |
| `creator_name` | text | `profiles.display_name`, coalesced to `'A WiseSel educator'` |
| `creator_headline` | text | nullable |
| `creator_bio` | text | nullable |
| `creator_avatar_url` | text | nullable |
| `creator_student_count` | integer | **distinct** learners across ALL the creator's courses (`enrollments.status in ('active','completed')`; a learner in three courses counts once) |
| `creator_course_count` | integer | distinct courses with a `live` publication |
| `creator_review_count` | integer | sum of `rollup_course_reviews.review_count` across the creator's courses |
| `creator_avg_rating` | numeric | review-count-**weighted** average, `round(…, 2)`; NULL until any review exists |
| `course_student_count` | integer | this course's active+completed enrollments |
| `course_review_count` | integer | this course's rollup count |
| `course_avg_rating` | numeric | this course's rollup average; nullable |

TS reader: `lib/learn/landingExtras.ts` `fetchCourseLandingExtras` — returns
`null` on **any** failure (missing RPC pre-migration, transport error, zero
rows, malformed row; the Zod row schema is tolerant of extra fields but
requires the essentials). The landing must never 500 over an optional read.

### `my_learning()` v3 · `marketplace_listings()` v3 — recreated

The 20260708000000 v2 bodies **verbatim**, plus a `courses` join, with new
columns **APPENDED (never reordered)**:

- `my_learning()` v3: + `cover_image_url` (last column).
- `marketplace_listings()` v3: + `cover_image_url`, `creator_avatar_url`,
  `creator_headline` (last three columns).

Append-only is the compatibility contract: a client compiled against v2 keeps
working against v3, and clients treat a missing field as "hide the visual".
Types were **hand-spliced** into `lib/database.types.ts` (never full-regen —
see the memory note).

## 3. Storage paths — and why no new policies were needed

Path builders live in `lib/images/resize.ts` (pure):

- Covers: `coverStoragePath(uid, courseId, fileId, ext)` →
  `{uid}/covers/{courseId}/{fileId}.{ext}`
- Avatars: `avatarStoragePath(uid, fileId, ext)` →
  `{uid}/avatar/{fileId}.{ext}`

Both land in the existing **public `course-assets` bucket**, whose policies
(core schema, `20260613000000`) gate insert/update/delete on
`(storage.foldername(name))[1] = auth.uid()` — i.e. **the first path segment
must be the caller's own uid**. The builders pin uid FIRST, so the existing
per-user policies ARE the write gate and the migration adds **zero storage
policies**. Reads are public-bucket URLs (the bucket is public; the broad
list/SELECT policy was dropped in the hardening migration).

Format gate: `extForMime` accepts **jpeg/png/webp only**. SVG is rejected
deliberately (can carry scripts; the bucket serves public URLs → XSS vector,
not an image format here). GIF is rejected (the canvas downscaler would
flatten animation anyway). Max upload `MAX_UPLOAD_BYTES` = 8 MiB;
`AVATAR_MAX_PX` 512 (square), `COVER_MAX_W×H` 1600×900.

## 4. Upload pipeline (client downscale → own-folder storage → row update)

All uploaders follow one shape (`components/settings/ProfileSettings.tsx` +
`components/dashboard/CreatorIdentityHeader.tsx` avatars — both consuming the
SHARED `lib/profile/clientProfile.ts` (`uploadAvatarImage` /
`saveProfileFields` / `saveAvatarUrl` / `removeCourseAsset`) so they can't
drift — and `components/editor/publish/CoverImageCard.tsx` covers):

1. **Validate** the picked file (`extForMime` + size cap).
2. **Downscale in the browser** — `lib/images/clientResize.ts`
   `downscaleImageFile` (createImageBitmap → canvas; avatars get a square
   `centerCrop` first; `fitWithin` never upscales; PNG/WebP keep their format,
   everything else re-encodes JPEG q0.85). On ANY failure (decode error,
   canvas unavailable, `toBlob` null) it **falls back to the original bytes**
   — an odd-but-valid image still uploads rather than dead-ending.
3. **Upload to the caller's own folder** (browser Supabase client,
   `upsert:false`, fresh `crypto.randomUUID()` file id per upload) and take
   the public URL. The uid comes from `auth.getUser()` at upload time, never
   from props.
4. **Update the row** — `profiles.avatar_url` or `courses.cover_image_url`.
   The cover saves **immediately** on upload (it's card metadata, not part of
   the immutable snapshot); a failed row update **rolls the just-uploaded
   object back**. Replacing/removing a cover also deletes the old object when
   its URL points into `course-assets` (external/legacy URLs are left alone).

## 5. Degradation matrix

Two migrations may be pending; each surface must be sane in all three states.

| Surface | Pre-portal migration (neither applied) | Portal applied, identity NOT | Both applied |
|---|---|---|---|
| `/learn/[slug]` landing | `course_landing_extras` doesn't exist → `fetchCourseLandingExtras` null → no cover (deterministic `CoverArt` fallback), no learner/rating chips, no "Created by" row, no instructor section. Outline/includes/outcomes/CTAs all still render (snapshot-derived). | same as pre-identity | full: cover, meta chips, instructor card + stats |
| Explore / marketplace cards | `marketplace_listings()` v1/v2 → no cover column → `CoverArt` gradient; no creator avatar row; (pre-portal also: no ratings, `is_live ?? true`) | v2: ratings yes, covers no → `CoverArt` | v3: uploaded covers + creator avatar/headline |
| My-learning / student home cards | `my_learning()` v1/v2 → `CoverArt` fallback (pre-portal also: no `is_live`/ratings) | ratings yes, covers → `CoverArt` | v3 covers |
| Dashboard / analytics picker / gallery (direct `courses` selects) | select naming `cover_image_url` errors (42703/PGRST204) → **retry without the column** → `CoverArt` | same | covers |
| Settings → ProfileSettings | display name + avatar still SAVE (retry drops headline/bio from the update); amber notice "Headline & bio will unlock once the pending database migration is applied"; PGRST204 detected | same | full form |
| Publish panel → CoverImageCard | select fails → **locked** info state ("Course covers unlock once the pending database migration is applied") | same | upload/replace/remove |
| Dashboard identity band (`CreatorIdentityHeader`, top of /dashboard — 2026-07-11, replaced the AttentionRail nudge) | avatar saves immediately (column since 0001); a headline/bio save keeps the editor OPEN with the amber unlock notice; missing pieces render dashed ghost prompts | same | full edit-in-place |

Rule of thumb encoded everywhere: **an RPC error or missing column means
"hide the visual", never an error page.**

## 6. Landing page composition (`app/(learn)/learn/[slug]/page.tsx`)

Data: `resolveCached(slug)` (publication resolution incl. `previous_slugs`
redirects) and `extrasCached(courseId)` (`fetchCourseLandingExtras`) are
wrapped in react `cache()` so `generateMetadata` and the page share one fetch
pass — the OG-image lookup doesn't double the DB round-trips.

Top to bottom:

1. **Hero** — warm glow, eyebrow, serif 5xl title, description; meta chips
   (level/audience always; learner count + `StarRating` only when `extras`
   present); "Created by" row (avatar + name, links `#instructor`).
2. **Sticky conversion card** (elevated Card) — aspect-video cover: the
   uploaded `cover_image_url` or `components/learn/CoverArt.tsx` (deterministic
   gradient keyed off the course id + oversized Fraunces initial + grain;
   hydration-safe, no randomness). Below it the **4 CTA states preserved
   verbatim** from M2: enroll / continue ("Your progress" literal kept —
   browser-suite anchor) / author preview / sign-in redirect.
3. **"This course includes"** — `courseIncludesItems(summarizeCourseContents
   (snapshot))` (`lib/learn/courseIncludes.ts`): modules·lessons, slides
   (across N decks), video lessons, quizzes (questions), homework,
   readings & resources, "About Xh of content" (authored `estimatedMinutes`).
   Computed from the **published snapshot**, never draft rows; zero-count
   lines dropped.
4. **"What you'll learn"** — the plan's real `outcomes` as a checklist in a
   tinted Card; `prerequisites` as a footnote when present.
5. **Course outline** — restyled `CourseOutline` (number medallions, sans
   lesson titles, per-lesson type icon chips via `primaryType`, open-state
   ring, Expand/Collapse all; per-module progress unchanged from 07-08).
6. **Instructor section** (`#instructor`) — eyebrow + serif name +
   `components/learn/InstructorCard.tsx` (avatar, headline, student/course/
   review/rating stats, line-clamped bio with Show more). Rendered only when
   `extras` resolved.
7. **Reviews** — `CourseReviewSection` (M9), eyebrow restyled brand-700.

The learn layout header widened to `max-w-6xl` and `loading.tsx` was reshaped
to match the new page silhouette.

## 7. Verify

- **`npm run verify:identity`** — `scripts/verify-creator-identity.ts`,
  **90 pure checks**, no key/DB/browser: `fitWithin` (never upscales, floors
  at 1px), `centerCrop` (wider/taller/equal sources), `extForMime` (accepts 3,
  rejects svg/gif/unknown), storage path shapes (uid first), `PROFILE_LIMITS`
  + `CreatorProfileFormSchema` edge lengths, `profileCompleteness`
  (blank-string = missing), `summarizeCourseContents`/`courseIncludesItems`
  (per-block-type counting, pluralization, hour formatting, zero-drop),
  and the `fetchCourseLandingExtras` degradation contract (error / empty /
  malformed / extra-fields-tolerated → null vs parsed). Chained into
  `npm test`.
- **Browser suites** — `verify:learn:browser` + `verify:portal:browser` pass
  in **both** modes: against the pre-migration live DB (degraded — CoverArt
  fallbacks, hidden instructor section, locked cover card) and post-migration.
  Both re-ran green in post-migration mode after the 2026-07-14 apply.
