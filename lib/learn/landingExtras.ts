/**
 * Course-landing extras — cover art + creator card + card-safe stats, read via
 * the `course_landing_extras` definer RPC (migration 20260711000000).
 *
 * Degradation contract: that migration may not be applied to the live DB yet,
 * so ANY failure (missing RPC, transport error, zero rows, malformed row)
 * returns null and the caller simply hides the sections — the landing must
 * never 500 over an optional read.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/database.types";

export type CourseLandingExtras = {
  coverImageUrl: string | null;
  creator: {
    id: string;
    name: string;
    headline: string | null;
    bio: string | null;
    avatarUrl: string | null;
    studentCount: number;
    courseCount: number;
    reviewCount: number;
    avgRating: number | null;
  };
  course: {
    studentCount: number;
    reviewCount: number;
    avgRating: number | null;
  };
};

/** Tolerant on purpose (unknown extra fields pass; counts/nullables coalesce)
 *  — only a row missing its essentials fails the parse. */
const ExtrasRowSchema = z.object({
  cover_image_url: z.string().nullish(),
  creator_id: z.string().min(1),
  creator_name: z.string().nullish(),
  creator_headline: z.string().nullish(),
  creator_bio: z.string().nullish(),
  creator_avatar_url: z.string().nullish(),
  creator_student_count: z.number().nullish(),
  creator_course_count: z.number().nullish(),
  creator_review_count: z.number().nullish(),
  creator_avg_rating: z.number().nullish(),
  course_student_count: z.number().nullish(),
  course_review_count: z.number().nullish(),
  course_avg_rating: z.number().nullish(),
});

export async function fetchCourseLandingExtras(
  supabase: SupabaseClient<Database>,
  courseId: string
): Promise<CourseLandingExtras | null> {
  try {
    const { data, error } = await supabase.rpc("course_landing_extras", {
      p_course_id: courseId,
    });
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const parsed = ExtrasRowSchema.safeParse(data[0]);
    if (!parsed.success) return null;
    const row = parsed.data;
    return {
      coverImageUrl: row.cover_image_url ?? null,
      creator: {
        id: row.creator_id,
        name: row.creator_name ?? "A WiseSel educator",
        headline: row.creator_headline ?? null,
        bio: row.creator_bio ?? null,
        avatarUrl: row.creator_avatar_url ?? null,
        studentCount: row.creator_student_count ?? 0,
        courseCount: row.creator_course_count ?? 0,
        reviewCount: row.creator_review_count ?? 0,
        avgRating: row.creator_avg_rating ?? null,
      },
      course: {
        studentCount: row.course_student_count ?? 0,
        reviewCount: row.course_review_count ?? 0,
        avgRating: row.course_avg_rating ?? null,
      },
    };
  } catch {
    return null;
  }
}
