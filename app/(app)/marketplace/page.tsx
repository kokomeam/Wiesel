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
 *
 * Cards are the SHARED components/learn/CourseCards.tsx (also used by the
 * student portal); this page keeps the creator voice ("Your course" badge,
 * studio-facing empty state) and the brand-orange progress tone.
 */

import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { ListingCard, MyLearningCard } from "@/components/learn/CourseCards";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
  const supabase = await createClient();
  const user = await getSessionUser();

  const [listingsRes, learningRes, ownCoursesRes] = await Promise.all([
    supabase.rpc("marketplace_listings"),
    supabase.rpc("my_learning"),
    // Which listed courses are the caller's own (author badge instead of Enroll).
    user
      ? supabase.from("courses").select("id").eq("author_id", user.id)
      : Promise.resolve({ data: [] as { id: string }[] }),
  ]);
  const listings = listingsRes.data ?? [];
  const learning = learningRes.data ?? [];
  const enrolledCourseIds = new Set(learning.map((l) => l.course_id));
  const ownCourseIds = new Set((ownCoursesRes.data ?? []).map((c) => c.id));

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
            {learning.map((course) => (
              <MyLearningCard key={course.enrollment_id} course={course} tone="brand" />
            ))}
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
                <ListingCard
                  key={listing.publication_id}
                  listing={listing}
                  ctaLabel={own ? "Your course" : enrolled ? "Open course" : "View & enroll"}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
