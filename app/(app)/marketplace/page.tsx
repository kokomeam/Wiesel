/**
 * Marketplace — REAL published courses (Milestone 2; the mock listings are
 * gone). One tab holds both sides of the learner experience:
 *   "My learning"    — the caller's enrollments (via the my_learning RPC),
 *                      with progress and a Continue link.
 *   "Browse courses" — every live PUBLIC publication (marketplace_listings
 *                      RPC: card-safe metadata only, never snapshots).
 * A card opens /learn/{slug} — the course landing doubles as the
 * confirmation/preview screen with the Enroll button at the bottom.
 * No pricing yet (payments are a later milestone) — everything reads Free.
 */

import Link from "next/link";
import { BookOpen, CheckCircle2, GraduationCap, Layers, PlayCircle } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { createClient } from "@/lib/supabase/server";

/** Deterministic warm accent per course (no Math.random — hydration-safe). */
const CARD_ACCENTS = [
  "from-amber-500 to-orange-600",
  "from-orange-500 to-rose-500",
  "from-yellow-500 to-amber-600",
  "from-rose-400 to-orange-500",
  "from-amber-400 to-orange-500",
];
function accentFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return CARD_ACCENTS[hash % CARD_ACCENTS.length];
}

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [listingsRes, learningRes] = await Promise.all([
    supabase.rpc("marketplace_listings"),
    supabase.rpc("my_learning"),
  ]);
  const listings = listingsRes.data ?? [];
  const learning = learningRes.data ?? [];
  const enrolledCourseIds = new Set(learning.map((l) => l.course_id));

  // Which listed courses are the caller's own (author badge instead of Enroll).
  const ownCourses = user
    ? await supabase.from("courses").select("id").eq("author_id", user.id)
    : { data: [] as { id: string }[] };
  const ownCourseIds = new Set((ownCourses.data ?? []).map((c) => c.id));

  return (
    <div className="mx-auto max-w-7xl space-y-10 p-6 lg:p-8">
      <PageHeader
        title="Courses"
        description="Pick up where you left off, or discover something new."
      />

      {/* ── My learning ── */}
      {learning.length > 0 ? (
        <section aria-label="My learning">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-stone-400">
            My learning
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {learning.map((course) => {
              const pct =
                course.total_lessons > 0
                  ? Math.round((course.completed_lessons / course.total_lessons) * 100)
                  : 0;
              const completed = course.enrollment_status === "completed";
              return (
                <Link key={course.enrollment_id} href={`/learn/${course.slug}`} className="group">
                  <Card className="h-full overflow-hidden transition-all group-hover:shadow-md">
                    <div
                      className={`relative flex h-24 items-end bg-gradient-to-br ${accentFor(course.course_id)} p-4`}
                    >
                      {course.level ? (
                        <span className="absolute right-3 top-3 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold capitalize text-white backdrop-blur">
                          {course.level}
                        </span>
                      ) : null}
                      <h3 className="text-base font-semibold leading-tight text-white drop-shadow-sm">
                        {course.title}
                      </h3>
                    </div>
                    <div className="p-4">
                      <div className="flex items-center justify-between text-xs text-stone-500">
                        <span>
                          {course.completed_lessons}/{course.total_lessons} lessons
                        </span>
                        {completed ? (
                          <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                            <CheckCircle2 className="size-3.5" aria-hidden /> Completed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                            <PlayCircle className="size-3.5" aria-hidden /> Continue
                          </span>
                        )}
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
                        <div
                          className="brand-gradient h-full rounded-full"
                          style={{ width: `${completed ? 100 : pct}%` }}
                        />
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ── Browse ── */}
      <section aria-label="Browse courses">
        <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-stone-400">
          Browse courses
        </h2>
        {listings.length === 0 ? (
          <Card className="mt-3 flex flex-col items-center gap-3 px-6 py-16 text-center">
            <GraduationCap className="size-8 text-stone-300" aria-hidden />
            <p className="text-sm font-medium text-stone-700">No published courses yet</p>
            <p className="max-w-sm text-sm text-stone-500">
              Courses appear here the moment a creator publishes one. Build yours in the
              studio and hit Publish.
            </p>
            <Link
              href="/studio"
              className="brand-gradient mt-2 rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
            >
              Open the studio
            </Link>
          </Card>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {listings.map((listing) => {
              const enrolled = enrolledCourseIds.has(listing.course_id);
              const own = ownCourseIds.has(listing.course_id);
              return (
                <Link
                  key={listing.publication_id}
                  href={`/learn/${listing.slug}`}
                  className="group"
                  data-ai-tool="marketplace-course-card"
                >
                  <Card className="flex h-full flex-col overflow-hidden transition-all group-hover:shadow-md">
                    <div
                      className={`relative flex h-28 items-end bg-gradient-to-br ${accentFor(listing.course_id)} p-4`}
                    >
                      {listing.level ? (
                        <span className="absolute right-3 top-3 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold capitalize text-white backdrop-blur">
                          {listing.level}
                        </span>
                      ) : null}
                      <h3 className="text-base font-semibold leading-tight text-white drop-shadow-sm">
                        {listing.title}
                      </h3>
                    </div>
                    <div className="flex flex-1 flex-col p-4">
                      <p className="text-xs text-stone-500">by {listing.creator_name}</p>
                      {listing.description ? (
                        <p className="mt-2 line-clamp-2 text-sm text-stone-600">
                          {listing.description}
                        </p>
                      ) : null}
                      <div className="mt-3 flex items-center gap-3 text-xs text-stone-500">
                        <span className="inline-flex items-center gap-1">
                          <Layers className="size-3.5" aria-hidden />
                          {listing.module_count}{" "}
                          {listing.module_count === 1 ? "module" : "modules"}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <BookOpen className="size-3.5" aria-hidden />
                          {listing.lesson_count}{" "}
                          {listing.lesson_count === 1 ? "lesson" : "lessons"}
                        </span>
                      </div>
                      <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-4">
                        <span className="text-sm font-bold text-stone-900">Free</span>
                        <span className="rounded-full border border-stone-300/80 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-700 transition-colors group-hover:border-stone-400 group-hover:bg-stone-50">
                          {own ? "Your course" : enrolled ? "Open course" : "View & enroll"}
                        </span>
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
