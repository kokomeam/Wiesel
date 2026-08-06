/**
 * /home tutor entry — server helper (TUTOR-1 W4.3).
 *
 * Given the signed-in learner's enrolled-course list (the my_learning() rows
 * /home already loads), resolve the per-course tutor entry: whether the tutor
 * is ENABLED for that course, the latest turn of the learner's own thread (a
 * trimmed snippet), and the deep link that opens the tutor sidebar
 * (`?tutor=open`, consumed once by TutorMount).
 *
 * Pure pieces (trimSnippet / tutorDeepLink / reviewWithTutorHref /
 * learnHrefSlug) are exported for the verify-tutor-home goldens.
 *
 * SERVER ONLY — this module touches createAdminClient. Never import it from
 * client code (the card imports its types only).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

type DB = SupabaseClient<Database>;

/* ────────────────────────────── Shapes ─────────────────────────────────── */

/** The enrolled-course subset /home passes in (from its my_learning rows).
 *  continueLessonId is best-effort: /home only resolves it for the hero
 *  course (snapshot fetches are capped); null → the deep link lands on the
 *  course landing instead of a lesson. */
export interface TutorHomeCourse {
  courseId: string;
  slug: string;
  title: string;
  continueLessonId: string | null;
}

export interface TutorHomeLastTurn {
  role: "learner" | "assistant" | "instructor";
  /** Trimmed to ~TUTOR_SNIPPET_MAX chars on a word boundary. */
  content: string;
  createdAt: string;
}

export interface TutorHomeEntry {
  courseId: string;
  slug: string;
  title: string;
  /** null = no thread yet — the card invites a first question. */
  lastTurn: TutorHomeLastTurn | null;
  /** /learn/{slug}/{continueLessonId}?tutor=open, or the landing when no
   *  continue lesson is known. */
  deepLink: string;
}

/* ─────────────────────────── Pure builders ─────────────────────────────── */

export const TUTOR_SNIPPET_MAX = 140;

/**
 * Trim a turn's content to a snippet: whitespace collapsed, cut on a WORD
 * boundary at ≤ max chars, trailing punctuation stripped, ellipsis appended.
 * A pathological unbroken token (no space in the back 40% of the window)
 * hard-cuts instead so the snippet never collapses to almost nothing.
 */
export function trimSnippet(text: string, max = TUTOR_SNIPPET_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const window = clean.slice(0, max);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? window.slice(0, lastSpace) : window;
  return `${cut.replace(/[\s,;:.!?—-]+$/u, "")}…`;
}

/**
 * The tutor deep link for a course: the continue lesson when one is known
 * (TutorMount lives on the lesson layout), else the course landing.
 * `?tutor=open` is consumed once on mount by TutorMount.
 */
export function tutorDeepLink(slug: string, continueLessonId: string | null): string {
  return continueLessonId
    ? `/learn/${slug}/${continueLessonId}?tutor=open`
    : `/learn/${slug}?tutor=open`;
}

/**
 * Append the "Review with the tutor" params to an EXISTING review-item href.
 * The href may be a lesson deep link (`/learn/{slug}/{lessonId}`, heuristic
 * items) or a course landing (`/learn/{slug}`, mastery items) — and defensively
 * may already carry a query string, so the separator is picked accordingly.
 * The seed is a one-shot composer prefill TutorMount consumes via `?seed=`.
 */
export function reviewWithTutorHref(href: string, quizTitle: string): string {
  const sep = href.includes("?") ? "&" : "?";
  const seed = encodeURIComponent(`Help me review ${quizTitle}`);
  return `${href}${sep}tutor=open&seed=${seed}`;
}

/** Extract the course slug from a `/learn/{slug}` or `/learn/{slug}/{lessonId}`
 *  href (query string tolerated). null when the href isn't a learn link. */
export function learnHrefSlug(href: string): string | null {
  const [path] = href.split("?");
  const parts = path.split("/");
  if (parts[1] !== "learn") return null;
  const slug = parts[2];
  return slug ? slug : null;
}

/* ─────────────────────────── The server load ───────────────────────────── */

interface ThreadRowLike {
  id: string;
  course_id: string;
}

interface TurnRowLike {
  thread_id: string;
  role: string;
  content: string;
  created_at: string;
}

function narrowRole(role: string): TutorHomeLastTurn["role"] {
  if (role === "learner") return "learner";
  if (role === "instructor") return "instructor";
  return "assistant";
}

/**
 * Load the tutor entries for /home's right rail.
 *
 * DISABLED-COURSE FILTER — ON BY DEFAULT, why the admin client, and why it's
 * safe here: the tutor is ENABLED unless the creator explicitly turned it OFF
 * (a `tutor_course_settings` row with enabled=false; a MISSING row ⇒ on). So we
 * exclude ONLY the explicitly-disabled courses — every other enrolled course
 * gets a tutor entry. tutor_course_settings is AUTHOR-ONLY under RLS (it's
 * creator config), so the learner's user-scoped client reads zero rows and
 * cannot distinguish "disabled" from "no row". We therefore follow the house
 * rule "access checks BEFORE admin reads": the enrolled-course list passed in
 * (my_learning(), enrollment-scoped under RLS) IS the access check —
 * enrollment IS the access check here — and only AFTER that list is
 * established do we read tutor_course_settings via createAdminClient, narrowed
 * to exactly those course ids, to find the explicitly-disabled subset. The
 * admin read exposes nothing learner-visible beyond a boolean the gated /learn
 * layout already embodies.
 *
 * Fail-OPEN to default-on: if the admin client is unconfigured or the settings
 * read errors (fresh environment, pre-migration DB), we DON'T hide every
 * course — we treat all enrolled courses as enabled (the disabled set is
 * empty), matching the on-by-default contract. A threads/turns read error
 * degrades to lastTurn null (the course still appears with "ask your first
 * question").
 */
export async function loadTutorHomeEntries(
  supabase: DB,
  userId: string,
  courses: readonly TutorHomeCourse[]
): Promise<TutorHomeEntry[]> {
  if (courses.length === 0) return [];

  // 1. Disabled set — admin read AFTER the enrollment-scoped list (see above).
  //    ON BY DEFAULT: exclude only courses with an explicit enabled=false row.
  let disabledIds: Set<string>;
  try {
    const admin = createAdminClient();
    const settingsRes = await admin
      .from("tutor_course_settings")
      .select("course_id, enabled")
      .in(
        "course_id",
        courses.map((c) => c.courseId)
      );
    // Fail OPEN to default-on: a read error hides no course (empty disabled set).
    if (settingsRes.error) disabledIds = new Set();
    else
      disabledIds = new Set(
        (settingsRes.data ?? [])
          .filter((row) => row.enabled === false)
          .map((row) => row.course_id)
      );
  } catch {
    // Admin client unconfigured (fresh env) → fail OPEN to default-on: treat
    // every enrolled course as enabled (no course hidden).
    disabledIds = new Set();
  }

  const enabled = courses.filter((c) => !disabledIds.has(c.courseId));
  if (enabled.length === 0) return [];

  // 2. Own threads (RLS learner-own + enrollment-gated; the eq is belt and
  //    braces). One thread per (user, course) by unique constraint.
  let threads: ThreadRowLike[] = [];
  try {
    const threadsRes = await supabase
      .from("tutor_threads")
      .select("id, course_id")
      .eq("user_id", userId)
      .in(
        "course_id",
        enabled.map((c) => c.courseId)
      );
    threads = (threadsRes.data ?? []) as ThreadRowLike[];
  } catch {
    threads = [];
  }
  const threadIdByCourse = new Map(threads.map((t) => [t.course_id, t.id]));

  // 3. Latest turns — ONE query with in() on thread ids, newest first,
  //    limit 2×threads (the card needs only the latest per thread; a course
  //    whose turns all fall outside the window degrades to lastTurn null).
  const latestByThread = new Map<string, TurnRowLike>();
  if (threads.length > 0) {
    try {
      const turnsRes = await supabase
        .from("tutor_turns")
        .select("thread_id, role, content, created_at")
        .eq("user_id", userId)
        .in(
          "thread_id",
          threads.map((t) => t.id)
        )
        .order("created_at", { ascending: false })
        .limit(threads.length * 2);
      for (const row of (turnsRes.data ?? []) as TurnRowLike[]) {
        // Rows arrive newest-first: first row per thread wins.
        if (!latestByThread.has(row.thread_id)) latestByThread.set(row.thread_id, row);
      }
    } catch {
      // Degrade: every course renders the first-question invitation.
    }
  }

  // 4. Entries — EVERY enabled enrolled course returns, thread or not.
  return enabled.map((course) => {
    const threadId = threadIdByCourse.get(course.courseId);
    const turn = threadId ? latestByThread.get(threadId) : undefined;
    return {
      courseId: course.courseId,
      slug: course.slug,
      title: course.title,
      lastTurn: turn
        ? {
            role: narrowRole(turn.role),
            content: trimSnippet(turn.content),
            createdAt: turn.created_at,
          }
        : null,
      deepLink: tutorDeepLink(course.slug, course.continueLessonId),
    };
  });
}
