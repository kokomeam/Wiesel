/**
 * /explore — the learner-voiced course catalog: every live PUBLIC publication
 * (marketplace_listings RPC — card-safe metadata only, never snapshots), with
 * star ratings, creator names, and module/lesson counts. Courses the learner
 * is already enrolled in show "Enrolled — continue" instead of the enroll CTA.
 * A card opens /learn/{slug} — the course landing doubles as the enroll
 * confirmation/preview screen.
 */

import { GraduationCap } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListingCard } from "@/components/learn/CourseCards";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const supabase = await createClient();
  const [listingsRes, learningRes] = await Promise.all([
    supabase.rpc("marketplace_listings"),
    supabase.rpc("my_learning"),
  ]);
  const listings = listingsRes.data ?? [];
  const enrolledCourseIds = new Set((learningRes.data ?? []).map((row) => row.course_id));

  return (
    <div
      className="paper-glow mx-auto w-full max-w-6xl px-6 py-8"
      style={{ "--glow-color": "rgba(125,211,252,0.25)" } as React.CSSProperties}
    >
      <PageHeader
        eyebrow="Course catalog"
        tone="learn"
        title="Explore"
        description={
          listings.length > 0
            ? `${listings.length} live course${listings.length === 1 ? "" : "s"} from educators on WiseSel — free while in beta.`
            : "Courses from educators on WiseSel — free while in beta."
        }
      />

      <div className="mt-8">
        {listingsRes.error ? (
          <Card className="border-amber-200 bg-amber-50/60 p-5">
            <p className="text-sm font-medium text-amber-800">
              Couldn&apos;t load the catalog
            </p>
            <p className="mt-1 text-sm text-amber-700">
              Something went wrong on our side. Refresh the page to try again.
            </p>
          </Card>
        ) : listings.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <GraduationCap className="size-8 text-stone-300" aria-hidden />
            <p className="text-sm font-medium text-stone-700">
              No courses published yet
            </p>
            <p className="max-w-sm text-sm text-stone-500">
              Educators are building right now — check back soon for new courses
              to enroll in.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {listings.map((listing) => (
              <ListingCard
                key={listing.publication_id}
                listing={listing}
                ctaLabel={
                  enrolledCourseIds.has(listing.course_id)
                    ? "Enrolled — continue"
                    : "View & enroll"
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
