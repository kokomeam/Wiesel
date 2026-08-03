/**
 * Seed a lesson with clip demo data (M-G) — the flat_affect eval fixture's
 * transcript + its gold moments as ranked candidates, so /marketing/clips
 * shows a fully populated state without a model call or a long recording.
 *
 * Usage: npx tsx scripts/seed-clips.ts <lessonId>
 *   (the lesson must belong to a course; signs in nothing — uses the
 *    service role like the other seed scripts)
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { FIXTURE_LESSONS, wordsFromSegments } from "@/lib/marketing/clips/fixtures/lessons";
import { CLIP_PROMPT_VERSION } from "@/lib/marketing/clips/prompt";

dns.setDefaultResultOrder("ipv4first");

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

async function main() {
  const lessonId = process.argv[2];
  if (!lessonId) {
    console.error("usage: npx tsx scripts/seed-clips.ts <lessonId>");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  const admin = createClient<Database>(url, key);

  const { data: lesson, error } = await admin
    .from("lessons")
    .select("id, course_id, courses!inner(author_id)")
    .eq("id", lessonId)
    .single();
  if (error || !lesson) throw new Error(`lesson not found: ${error?.message}`);
  const courseId = lesson.course_id as string;
  const creatorId = (lesson as unknown as { courses: { author_id: string } }).courses.author_id;

  const fixture = FIXTURE_LESSONS.find((f) => f.key === "flat_affect")!;
  const words = wordsFromSegments(fixture.segments);

  const { data: transcript, error: tErr } = await admin
    .from("lesson_transcript")
    .upsert(
      {
        creator_id: creatorId,
        course_id: courseId,
        lesson_id: lessonId,
        source: "platform",
        language: "en",
        duration_seconds: fixture.durationMs / 1000,
        words: words as unknown as Json,
        text: fixture.segments.map((s) => s.text).join(" "),
        recording_format: fixture.recordingFormat,
        format_source: "platform",
      },
      { onConflict: "lesson_id" }
    )
    .select("id")
    .single();
  if (tErr) throw new Error(`transcript seed: ${tErr.message}`);

  const requestId = crypto.randomUUID();
  const rows = fixture.goldMoments.map((g, i) => ({
    creator_id: creatorId,
    course_id: courseId,
    lesson_id: lessonId,
    transcript_id: transcript.id,
    request_id: requestId,
    rank: i + 1,
    start_ms: g.startMs,
    end_ms: g.endMs,
    segments: null,
    stitched_script: null,
    moment_type: g.momentType,
    hook_text: g.note.split("—")[0].trim().slice(0, 60),
    alt_hooks: ["A moment worth clipping", "Straight from the lesson"] as unknown as Json,
    funnel_stage: i === fixture.goldMoments.length - 1 ? "bofu" : "tofu",
    target_platform_fit: ["instagram", "tiktok"] as unknown as Json,
    rubric_scores: {
      hook_potential: 4,
      standalone: 4,
      specificity: 4,
      curiosity_gap: 4,
      pedagogical_value: 5,
      visual_interest: 3,
      brand_safety: 5,
    } as unknown as Json,
    rationale: g.note,
    caption_draft: null,
    end_card_cta: null,
    layout: "audiogram",
    status: "candidate",
    prompt_version: CLIP_PROMPT_VERSION,
    ai_metadata: { seeded: true } as unknown as Json,
  }));
  const { error: cErr } = await admin.from("clip_moment_candidate").insert(rows);
  if (cErr) throw new Error(`candidate seed: ${cErr.message}`);
  console.log(`seeded transcript + ${rows.length} candidates on lesson ${lessonId} (request ${requestId})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
