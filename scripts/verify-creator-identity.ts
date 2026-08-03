/**
 * Creator identity + course covers PURE verification — no DB, no key.
 * Run: `npx tsx scripts/verify-creator-identity.ts`  (npm run verify:identity)
 *
 * Covers: the image sizing math (fitWithin never upscales, centerCrop
 * geometry), the mime → extension allowlist (SVG rejected deliberately — it
 * can carry scripts and course-assets serves public URLs), the storage path
 * builders (uid-first, the storage-policy key), the profile form schema +
 * completeness nudge, the snapshot content summary + "includes" labels, and
 * fetchCourseLandingExtras' degrade-to-null contract over a stubbed client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  AVATAR_MAX_PX,
  avatarStoragePath,
  centerCrop,
  COVER_MAX_H,
  COVER_MAX_W,
  coverStoragePath,
  extForMime,
  fitWithin,
  MAX_UPLOAD_BYTES,
  storagePathFromPublicUrl,
} from "@/lib/images/resize";
import {
  CreatorProfileFormSchema,
  PROFILE_LIMITS,
  profileCompleteness,
} from "@/lib/profile/schema";
import {
  courseIncludesItems,
  summarizeCourseContents,
  type CourseContentSummary,
} from "@/lib/learn/courseIncludes";
import { fetchCourseLandingExtras } from "@/lib/learn/landingExtras";
import type {
  PublicationSnapshot,
  PublishedLesson,
  PublishedLessonBlock,
  PublishedModule,
} from "@/lib/course/publish/schemas";
import type { Slide } from "@/lib/course/types";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

/* ───────────────────────── Fixture builders ─────────────────────────────── */

const AI_META = { purpose: "t", editable: true, allowedActions: [], semanticTags: [] };

function slide(id: string): Slide {
  return {
    id,
    type: "slide",
    layout: "blank",
    style: {} as Slide["style"],
    elements: [],
    order: 0,
    ai: { formattingRules: [] } as unknown as Slide["ai"],
  };
}

function deck(id: string, slideCount: number): PublishedLessonBlock {
  return {
    id,
    order: 0,
    ai: AI_META,
    type: "slide_deck",
    slides: Array.from({ length: slideCount }, (_, i) => slide(`${id}-s${i}`)),
  };
}

function quiz(id: string, questionCount: number): PublishedLessonBlock {
  return {
    id,
    order: 0,
    ai: AI_META,
    type: "quiz",
    questions: Array.from({ length: questionCount }, (_, i) => ({
      id: `${id}-q${i}`,
      kind: "true_false" as const,
      prompt: "T or F?",
    })),
  };
}

function video(id: string): PublishedLessonBlock {
  return {
    id,
    order: 0,
    ai: AI_META,
    type: "video",
    asset: { provider: "mux", status: "ready" },
    recording: {},
    edit: {},
    settings: {
      showControls: true,
      allowDownload: false,
      showTranscript: false,
      showChapters: false,
    },
  };
}

function homework(id: string): PublishedLessonBlock {
  return {
    id,
    order: 0,
    ai: AI_META,
    type: "homework",
    instructions: "Do the thing",
    deliverableType: "text_response",
    exercises: [],
  };
}

function lecture(id: string): PublishedLessonBlock {
  return { id, order: 0, ai: AI_META, type: "lecture_text", tone: "concise", paragraphs: [] };
}

function example(id: string): PublishedLessonBlock {
  return {
    id,
    order: 0,
    ai: AI_META,
    type: "example",
    context: "c",
    explanation: "e",
    steps: [],
    takeaway: "t",
  };
}

function exercise(id: string): PublishedLessonBlock {
  return { id, order: 0, ai: AI_META, type: "exercise", prompt: "p" };
}

function resource(id: string): PublishedLessonBlock {
  return { id, order: 0, ai: AI_META, type: "resource", links: [] };
}

function importedDeck(id: string): PublishedLessonBlock {
  return {
    id,
    order: 0,
    ai: AI_META,
    type: "imported_deck",
    deckImportId: "di-1",
    sourceType: "upload",
    originalFileName: "deck.pdf",
    originalMimeType: "application/pdf",
    originalFileSize: 1000,
    status: "ready",
  };
}

function lesson(
  id: string,
  blocks: PublishedLessonBlock[],
  estimatedMinutes?: number
): PublishedLesson {
  return { id, type: "lesson", title: id, order: 0, estimatedMinutes, blocks };
}

function moduleNode(id: string, lessons: PublishedLesson[]): PublishedModule {
  return { id, type: "module", title: id, order: 0, lessons };
}

function snapshotOf(modules: PublishedModule[]): PublicationSnapshot {
  return {
    schemaVersion: 1,
    course: {
      id: "course-1",
      title: "Fixture course",
      plan: {} as PublicationSnapshot["course"]["plan"],
      theme: {} as PublicationSnapshot["course"]["theme"],
    },
    modules,
  };
}

/* ─────────────────── Stub supabase for landingExtras ────────────────────── */

const HAPPY_ROW = {
  cover_image_url: "https://cdn.example/cover.webp",
  creator_id: "u-1",
  creator_name: "Ada Lovelace",
  creator_headline: "USACO coach",
  creator_bio: "Teaching for 10 years.",
  creator_avatar_url: "https://cdn.example/ada.webp",
  creator_student_count: 42,
  creator_course_count: 3,
  creator_review_count: 18,
  creator_avg_rating: 4.62,
  course_student_count: 12,
  course_review_count: 5,
  course_avg_rating: 4.8,
};

function stubClient(
  impl: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>
): SupabaseClient<Database> {
  return { rpc: impl } as unknown as SupabaseClient<Database>;
}

function main() {
  void (async () => {
    /* ── 1. fitWithin ── */
    console.log("\n— fitWithin —");
    const same = fitWithin(800, 450, COVER_MAX_W, COVER_MAX_H);
    check("never upscales (inside box unchanged)", same.width === 800 && same.height === 450);
    const exact = fitWithin(3200, 1800, COVER_MAX_W, COVER_MAX_H);
    check("scales to exact bounds (2x 16:9)", exact.width === 1600 && exact.height === 900);
    const wide = fitWithin(4000, 1000, COVER_MAX_W, COVER_MAX_H);
    check("width-bound source hits maxW", wide.width === 1600 && wide.height === 400);
    const tall = fitWithin(1000, 4000, COVER_MAX_W, COVER_MAX_H);
    check("height-bound source hits maxH", tall.width === 225 && tall.height === 900);
    check(
      "aspect preserved on scale",
      Math.abs(exact.width / exact.height - 3200 / 1800) < 0.01
    );
    const atMax = fitWithin(1600, 900, COVER_MAX_W, COVER_MAX_H);
    check("exactly at bounds unchanged", atMax.width === 1600 && atMax.height === 900);
    const avatar = fitWithin(1024, 1024, AVATAR_MAX_PX, AVATAR_MAX_PX);
    check("square avatar → 512×512", avatar.width === 512 && avatar.height === 512);
    const tiny = fitWithin(100, 200, AVATAR_MAX_PX, AVATAR_MAX_PX);
    check("small avatar untouched", tiny.width === 100 && tiny.height === 200);
    const sliver = fitWithin(10000, 1, COVER_MAX_W, COVER_MAX_H);
    check("extreme sliver floors at 1px", sliver.width === 1600 && sliver.height === 1);
    const zero = fitWithin(0, 0, COVER_MAX_W, COVER_MAX_H);
    check("zero dims → 0×0 (caller rejects)", zero.width === 0 && zero.height === 0);
    check("constants pinned (512/1600/900/8MiB)",
      AVATAR_MAX_PX === 512 &&
        COVER_MAX_W === 1600 &&
        COVER_MAX_H === 900 &&
        MAX_UPLOAD_BYTES === 8 * 1024 * 1024
    );

    /* ── 2. centerCrop ── */
    console.log("\n— centerCrop —");
    const wider = centerCrop(3200, 900, 16 / 9);
    check(
      "wider source trims sides",
      wider.sw === 1600 && wider.sh === 900 && wider.sx === 800 && wider.sy === 0
    );
    const taller = centerCrop(1600, 1800, 16 / 9);
    check(
      "taller source trims top/bottom",
      taller.sw === 1600 && taller.sh === 900 && taller.sx === 0 && taller.sy === 450
    );
    const equal = centerCrop(1600, 900, 16 / 9);
    check(
      "matching aspect → full frame",
      equal.sx === 0 && equal.sy === 0 && equal.sw === 1600 && equal.sh === 900
    );
    const sqFromLandscape = centerCrop(2000, 1000, 1);
    check(
      "square crop from landscape centers x",
      sqFromLandscape.sw === 1000 && sqFromLandscape.sh === 1000 && sqFromLandscape.sx === 500
    );
    const sqFromPortrait = centerCrop(1000, 2000, 1);
    check(
      "square crop from portrait centers y",
      sqFromPortrait.sw === 1000 && sqFromPortrait.sh === 1000 && sqFromPortrait.sy === 500
    );
    check(
      "crop rect stays inside source",
      wider.sx + wider.sw <= 3200 && taller.sy + taller.sh <= 1800
    );
    const odd = centerCrop(1234, 777, 16 / 9);
    check(
      "crop rect matches target aspect (±1px rounding)",
      Math.abs(odd.sw / odd.sh - 16 / 9) < 0.01 && odd.sx + odd.sw <= 1234
    );
    const degenerate = centerCrop(0, 100, 16 / 9);
    check("degenerate source → empty crop, no NaN", degenerate.sw === 0 && !Number.isNaN(degenerate.sx));

    /* ── 3. extForMime ── */
    console.log("\n— extForMime —");
    check("image/jpeg → jpg", extForMime("image/jpeg") === "jpg");
    check("image/png → png", extForMime("image/png") === "png");
    check("image/webp → webp", extForMime("image/webp") === "webp");
    check("image/gif rejected", extForMime("image/gif") === null);
    check("image/svg+xml rejected (script-capable, public bucket)", extForMime("image/svg+xml") === null);
    check("application/pdf rejected", extForMime("application/pdf") === null);
    check("empty string rejected", extForMime("") === null);

    /* ── 4. Storage paths ── */
    console.log("\n— storage paths —");
    const cover = coverStoragePath("uid-1", "course-9", "file-3", "webp");
    check("cover path exact shape", cover === "uid-1/covers/course-9/file-3.webp");
    check("cover path pins uid as first segment", cover.split("/")[0] === "uid-1");
    const av = avatarStoragePath("uid-1", "file-7", "jpg");
    check("avatar path exact shape", av === "uid-1/avatar/file-7.jpg");
    check("avatar path pins uid as first segment", av.split("/")[0] === "uid-1");
    check(
      "distinct file ids → distinct paths",
      coverStoragePath("u", "c", "a", "png") !== coverStoragePath("u", "c", "b", "png")
    );
    const pubBase = "https://xyz.supabase.co/storage/v1/object/public/course-assets/";
    check(
      "public URL → bucket-relative path",
      storagePathFromPublicUrl(`${pubBase}uid-1/avatar/file-7.jpg`) ===
        "uid-1/avatar/file-7.jpg"
    );
    check(
      "query/hash stripped from parsed path",
      storagePathFromPublicUrl(`${pubBase}uid-1/covers/c/f.webp?width=100#x`) ===
        "uid-1/covers/c/f.webp"
    );
    check(
      "foreign URL never parsed into a delete target",
      storagePathFromPublicUrl("https://example.com/photos/me.jpg") === null
    );
    check(
      "unrelated URL containing 'course-assets' rejected (needs full storage prefix)",
      storagePathFromPublicUrl("https://example.com/course-assets/x.png") === null
    );
    check(
      "bare prefix with no object path → null",
      storagePathFromPublicUrl(pubBase) === null
    );
    check(
      "percent-encoded path decodes",
      storagePathFromPublicUrl(`${pubBase}uid-1/avatar/a%20b.jpg`) === "uid-1/avatar/a b.jpg"
    );
    check(
      "malformed percent-encoding → null (never throws)",
      storagePathFromPublicUrl(`${pubBase}uid-1/avatar/%E0%A4%A.jpg`) === null
    );

    /* ── 5. Profile schema ── */
    console.log("\n— profile schema —");
    check(
      "PROFILE_LIMITS pinned (80/120/2000)",
      PROFILE_LIMITS.displayName === 80 &&
        PROFILE_LIMITS.headline === 120 &&
        PROFILE_LIMITS.bio === 2000
    );
    const okForm = CreatorProfileFormSchema.safeParse({
      displayName: "A".repeat(80),
      headline: "H".repeat(120),
      bio: "B".repeat(2000),
    });
    check("accepts at every boundary (80/120/2000)", okForm.success);
    check(
      "rejects displayName 81",
      !CreatorProfileFormSchema.safeParse({ displayName: "A".repeat(81), headline: null, bio: null })
        .success
    );
    check(
      "rejects empty displayName",
      !CreatorProfileFormSchema.safeParse({ displayName: "", headline: null, bio: null }).success
    );
    check(
      "rejects whitespace-only displayName (trimmed to empty)",
      !CreatorProfileFormSchema.safeParse({ displayName: "   ", headline: null, bio: null }).success
    );
    const trimmed = CreatorProfileFormSchema.safeParse({
      displayName: "  Ada Lovelace  ",
      headline: null,
      bio: null,
    });
    check(
      "trims displayName in output",
      trimmed.success && trimmed.data.displayName === "Ada Lovelace"
    );
    check(
      "rejects headline 121",
      !CreatorProfileFormSchema.safeParse({ displayName: "A", headline: "H".repeat(121), bio: null })
        .success
    );
    check(
      "rejects bio 2001",
      !CreatorProfileFormSchema.safeParse({ displayName: "A", headline: null, bio: "B".repeat(2001) })
        .success
    );
    const nullable = CreatorProfileFormSchema.safeParse({ displayName: "A", headline: null, bio: null });
    check("headline/bio nullable", nullable.success);

    /* ── 6. profileCompleteness ── */
    console.log("\n— profileCompleteness —");
    const full = profileCompleteness({ avatar_url: "u", headline: "h", bio: "b" });
    check("all present → complete", full.complete && full.missing.length === 0);
    const none = profileCompleteness({ avatar_url: null, headline: null, bio: null });
    check(
      "all null → photo/headline/bio missing in order",
      !none.complete && none.missing.join(",") === "photo,headline,bio"
    );
    const emptyAvatar = profileCompleteness({ avatar_url: "", headline: "h", bio: "b" });
    check("empty avatar counts as missing photo", emptyAvatar.missing.join(",") === "photo");
    const blankHeadline = profileCompleteness({ avatar_url: "u", headline: "   ", bio: "b" });
    check("whitespace headline counts as missing", blankHeadline.missing.join(",") === "headline");
    const noBio = profileCompleteness({ avatar_url: "u", headline: "h", bio: null });
    check("only bio missing", noBio.missing.join(",") === "bio");
    check("any missing ⇒ not complete", !noBio.complete);

    /* ── 7. summarizeCourseContents ── */
    console.log("\n— summarizeCourseContents —");
    const snapshot = snapshotOf([
      moduleNode("m1", [
        lesson("l1", [deck("d1", 3), video("v1"), quiz("qz1", 2), lecture("lt1")], 30),
        lesson("l2", [deck("d2", 2), homework("hw1"), example("ex1"), exercise("xr1")], 45),
      ]),
      moduleNode("m2", [lesson("l3", [resource("rs1"), quiz("qz2", 1), importedDeck("id1")])]),
    ]);
    const s = summarizeCourseContents(snapshot);
    check("moduleCount", s.moduleCount === 2, `got ${s.moduleCount}`);
    check("lessonCount", s.lessonCount === 3, `got ${s.lessonCount}`);
    check("slideDeckCount", s.slideDeckCount === 2, `got ${s.slideDeckCount}`);
    check("slideCount sums slides arrays", s.slideCount === 5, `got ${s.slideCount}`);
    check("videoCount", s.videoCount === 1, `got ${s.videoCount}`);
    check("quizCount", s.quizCount === 2, `got ${s.quizCount}`);
    check("questionCount sums questions", s.questionCount === 3, `got ${s.questionCount}`);
    check("homeworkCount", s.homeworkCount === 1, `got ${s.homeworkCount}`);
    check(
      "readingCount = lecture+example+exercise+resource",
      s.readingCount === 4,
      `got ${s.readingCount}`
    );
    check("totalMinutes sums lesson estimates", s.totalMinutes === 75, `got ${s.totalMinutes}`);
    const empty = summarizeCourseContents(snapshotOf([]));
    check(
      "empty snapshot → all zeros",
      Object.values(empty).every((v) => v === 0)
    );

    /* ── 8. courseIncludesItems ── */
    console.log("\n— courseIncludesItems —");
    const items = courseIncludesItems(s);
    const byIcon = new Map(items.map((i) => [i.icon, i.label]));
    check("modules label", byIcon.get("modules") === "2 modules · 3 lessons");
    check("slides label (plural decks)", byIcon.get("slides") === "5 slides across 2 decks");
    check("video label singular", byIcon.get("video") === "1 video lesson");
    check("quiz label with questions", byIcon.get("quiz") === "2 quizzes (3 questions)");
    check("homework label singular", byIcon.get("homework") === "1 homework assignment");
    check("reading label", byIcon.get("reading") === "4 reading & resources");
    check("time label h+m", byIcon.get("time") === "About 1h 15m of content");
    check("all seven present, none dropped", items.length === 7);
    const zeroItems = courseIncludesItems(summarizeCourseContents(snapshotOf([])));
    check("zero summary → no items", zeroItems.length === 0);
    const singleDeck: CourseContentSummary = {
      ...s,
      slideDeckCount: 1,
      slideCount: 8,
      videoCount: 0,
      homeworkCount: 0,
    };
    const singleItems = courseIncludesItems(singleDeck);
    const singleByIcon = new Map(singleItems.map((i) => [i.icon, i.label]));
    check("single deck drops 'across'", singleByIcon.get("slides") === "8 slides");
    check(
      "zero-count icons dropped",
      !singleByIcon.has("video") && !singleByIcon.has("homework")
    );
    const oneOfEach: CourseContentSummary = {
      moduleCount: 1,
      lessonCount: 1,
      slideDeckCount: 1,
      slideCount: 1,
      videoCount: 0,
      quizCount: 1,
      questionCount: 1,
      homeworkCount: 0,
      readingCount: 1,
      totalMinutes: 45,
    };
    const onesByIcon = new Map(courseIncludesItems(oneOfEach).map((i) => [i.icon, i.label]));
    check("singular slide", onesByIcon.get("slides") === "1 slide");
    check("singular quiz + question", onesByIcon.get("quiz") === "1 quiz (1 question)");
    check("singular module · lesson", onesByIcon.get("modules") === "1 module · 1 lesson");
    check("sub-hour time label", onesByIcon.get("time") === "About 45 min of content");
    const exactHours = courseIncludesItems({ ...oneOfEach, totalMinutes: 120 });
    check(
      "exact hours drop minutes",
      exactHours.find((i) => i.icon === "time")?.label === "About 2h of content"
    );

    /* ── 9. fetchCourseLandingExtras ── */
    console.log("\n— fetchCourseLandingExtras —");
    let seenArgs: unknown = null;
    const happy = await fetchCourseLandingExtras(
      stubClient(async (name, args) => {
        seenArgs = { name, args };
        return { data: [HAPPY_ROW], error: null };
      }),
      "course-1"
    );
    check("happy path returns extras", happy !== null);
    check(
      "passes p_course_id through",
      JSON.stringify(seenArgs) ===
        JSON.stringify({ name: "course_landing_extras", args: { p_course_id: "course-1" } })
    );
    check("maps cover url", happy?.coverImageUrl === "https://cdn.example/cover.webp");
    check(
      "maps creator card",
      happy?.creator.id === "u-1" &&
        happy?.creator.name === "Ada Lovelace" &&
        happy?.creator.headline === "USACO coach" &&
        happy?.creator.bio === "Teaching for 10 years." &&
        happy?.creator.avatarUrl === "https://cdn.example/ada.webp"
    );
    check(
      "maps creator stats",
      happy?.creator.studentCount === 42 &&
        happy?.creator.courseCount === 3 &&
        happy?.creator.reviewCount === 18 &&
        happy?.creator.avgRating === 4.62
    );
    check(
      "maps course stats",
      happy?.course.studentCount === 12 &&
        happy?.course.reviewCount === 5 &&
        happy?.course.avgRating === 4.8
    );

    const sparse = await fetchCourseLandingExtras(
      stubClient(async () => ({
        data: [
          {
            ...HAPPY_ROW,
            cover_image_url: null,
            creator_name: null,
            creator_headline: null,
            creator_bio: null,
            creator_avatar_url: null,
            creator_student_count: null,
            creator_avg_rating: null,
            course_avg_rating: null,
          },
        ],
        error: null,
      })),
      "course-1"
    );
    check("null cover stays null", sparse?.coverImageUrl === null);
    check("null creator name falls back", sparse?.creator.name === "A WiseSel educator");
    check(
      "null card fields stay null",
      sparse?.creator.headline === null &&
        sparse?.creator.bio === null &&
        sparse?.creator.avatarUrl === null
    );
    check("null counts coalesce to 0", sparse?.creator.studentCount === 0);
    check(
      "avg ratings stay null with no reviews",
      sparse?.creator.avgRating === null && sparse?.course.avgRating === null
    );

    const errored = await fetchCourseLandingExtras(
      stubClient(async () => ({ data: null, error: { message: "function does not exist" } })),
      "course-1"
    );
    check("rpc error → null (pre-migration degrade)", errored === null);
    const emptyRows = await fetchCourseLandingExtras(
      stubClient(async () => ({ data: [], error: null })),
      "course-1"
    );
    check("zero rows (no live publication) → null", emptyRows === null);
    const nullData = await fetchCourseLandingExtras(
      stubClient(async () => ({ data: null, error: null })),
      "course-1"
    );
    check("null data → null", nullData === null);
    const malformed = await fetchCourseLandingExtras(
      stubClient(async () => ({ data: [{ creator_name: "no id" }], error: null })),
      "course-1"
    );
    check("malformed row (missing creator_id) → null", malformed === null);
    const thrown = await fetchCourseLandingExtras(
      stubClient(async () => {
        throw new Error("network down");
      }),
      "course-1"
    );
    check("thrown transport error → null", thrown === null);
    const extraFields = await fetchCourseLandingExtras(
      stubClient(async () => ({
        data: [{ ...HAPPY_ROW, some_future_column: "tolerated" }],
        error: null,
      })),
      "course-1"
    );
    check("unknown extra fields tolerated", extraFields !== null);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  })();
}

main();
