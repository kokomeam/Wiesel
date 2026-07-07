/**
 * Social Post Generator — PURE suite (no key, no DB, no browser).
 *
 *   - Zod gates: platform caps via PLATFORM_LIMITS superRefine, the 1–5 batch
 *     cap, request source-consistency, performance "log something" rule
 *   - Batch planning: balanced funnel mix table (5→3/1/1 … 1→goal),
 *     value-first ordering, goal→stage map
 *   - Safety lint: every rule fires, the source-context whitelist exempts the
 *     creator's own claims, repair instruction shape
 *   - Timing presets: none/custom/same_day spacing ≥2h, spread_week weekday
 *     morning slots (9–11 local) incl. the DST spring-forward edge,
 *     spread_2_weeks distinct ascending days, deterministic under seeded rand
 *   - Export builders: .txt/.md shape, front-matter carries the real status,
 *     no publish-like language
 *   - imageMeta: PNG/JPEG/WebP(VP8L/VP8X) dimension parsing by magic bytes,
 *     soft norm warning
 *   - Prompt: byte-stable static prefix, PROMPT_VERSION recorded
 *   - Templates: grounded in real course facts, lint-clean, platform-capped
 *   - Tool registry snapshot: exactly 19 tools — 5 read + 14 reversible,
 *     ZERO irreversible (no approval cards in this feature)
 *   - Hardening greps: language rules in feature UI, no social-platform hosts,
 *     no scheduler primitives, the versioned-update single-writer rule
 *
 * Run: `npx tsx scripts/verify-social.ts`
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BANNED_UI_PHRASES,
  GOAL_STAGE_MAP,
  MANUAL_PUBLISH_NOTICE,
  PLATFORMS,
  PLATFORM_LIMITS,
  buildBatchPlan,
} from "@/lib/marketing/social/constants";
import {
  GeneratedPostBatchSchema,
  GeneratedPostSchema,
  GenerateRequestSchema,
  PostPerformanceSchema,
  SocialPostPatchSchema,
  SocialVoiceProfileSchema,
} from "@/lib/marketing/social/schemas";
import { lintGeneratedPost, lintRepairInstruction } from "@/lib/marketing/social/lint";
import { computePlannedTimes, zonedTimeToUtc } from "@/lib/marketing/social/timing";
import {
  buildCopyText,
  buildMdExport,
  buildTxtExport,
  exportFileName,
} from "@/lib/marketing/social/exportText";
import { imageNormWarning, parseImageMeta } from "@/lib/marketing/social/imageMeta";
import {
  PROMPT_VERSION,
  SOCIAL_REVISION_SYSTEM_PROMPT,
  SOCIAL_SYSTEM_PROMPT,
  buildGenerationInput,
  buildRepairInput,
} from "@/lib/marketing/social/prompt";
import {
  buildTemplatePosts,
  suggestHashtagsDeterministic,
} from "@/lib/marketing/social/templates";
import { deriveVoiceProfileDeterministic } from "@/lib/marketing/social/voice";
import { socialPostTools } from "@/lib/marketing/tools/socialPosts";
import {
  ALL_MARKETING_TOOLS,
  MARKETING_GENERATE_TOOLS,
  MARKETING_READ_TOOLS,
} from "@/lib/marketing/tools";

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

/** Deterministic LCG for seeded jitter. */
function seededRand(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

const VOICE = deriveVoiceProfileDeterministic({ courses: [], emailVoiceRules: [], samples: [] });

/* ────────────────────────────── schemas ────────────────────────────── */

function schemaChecks() {
  console.log("# Zod gates");
  const base = {
    platform: "linkedin" as const,
    goal: "value" as const,
    funnelStage: "tofu" as const,
    tone: "friendly" as const,
    body: "Most beginners think watercolor is about controlling the paint. It is not — you guide the water.",
    cta: null,
    hashtags: ["#watercolor", "#learning"],
    suggestedImageIdea: "Photo of your palette mid-lesson",
    plannedPostAt: null,
  };
  check("valid post parses", GeneratedPostSchema.safeParse(base).success);
  check(
    "LinkedIn 3000-char cap enforced",
    !GeneratedPostSchema.safeParse({ ...base, body: "x".repeat(3001) }).success
  );
  check(
    "Facebook practical cap (5000) enforced",
    !GeneratedPostSchema.safeParse({ ...base, platform: "facebook", body: "x".repeat(5001) }).success
  );
  check(
    "LinkedIn allows ≤5 hashtags only",
    !GeneratedPostSchema.safeParse({
      ...base,
      hashtags: ["#a1", "#a2", "#a3", "#a4", "#a5", "#a6"],
    }).success
  );
  check(
    "Facebook allows ≤3 hashtags only",
    !GeneratedPostSchema.safeParse({
      ...base,
      platform: "facebook",
      hashtags: ["#a1", "#a2", "#a3", "#a4"],
    }).success
  );
  check("body under 30 chars rejected", !GeneratedPostSchema.safeParse({ ...base, body: "hi" }).success);
  check(
    "malformed hashtag rejected",
    !GeneratedPostSchema.safeParse({ ...base, hashtags: ["#bad tag!"] }).success
  );
  check(
    "batch of 6 rejected (Zod layer of the 4-layer cap)",
    !GeneratedPostBatchSchema.safeParse({ posts: Array.from({ length: 6 }, () => base) }).success
  );
  check("batch of 0 rejected", !GeneratedPostBatchSchema.safeParse({ posts: [] }).success);

  const req = {
    sourceType: "manual" as const,
    sourceText: "USACO silver prep course for ambitious middle schoolers",
    platform: "linkedin" as const,
    goal: "value" as const,
    tone: "professional" as const,
    count: 3,
  };
  check("valid manual request parses", GenerateRequestSchema.safeParse(req).success);
  check(
    "manual without sourceText rejected",
    !GenerateRequestSchema.safeParse({ ...req, sourceText: undefined }).success
  );
  check(
    "course source requires courseId",
    !GenerateRequestSchema.safeParse({ ...req, sourceType: "course" }).success
  );
  check(
    "pinned mix requires a goal",
    !GenerateRequestSchema.safeParse({ ...req, goal: undefined, funnelMix: "pinned" }).success
  );
  check("count 6 rejected", !GenerateRequestSchema.safeParse({ ...req, count: 6 }).success);
  check("count 0 rejected", !GenerateRequestSchema.safeParse({ ...req, count: 0 }).success);
  check(
    "custom timing needs one time per post",
    !GenerateRequestSchema.safeParse({
      ...req,
      timingPreset: "custom",
      customTimes: ["2026-07-08T09:00:00Z"],
    }).success
  );

  check(
    "performance: empty log rejected",
    !PostPerformanceSchema.safeParse({ loggedAt: "2026-07-06T00:00:00Z", source: "manual" }).success
  );
  check(
    "performance: one-tap qualitative alone is enough",
    PostPerformanceSchema.safeParse({
      qualitative: "good",
      loggedAt: "2026-07-06T00:00:00Z",
      source: "manual",
    }).success
  );
  check(
    "performance: metrics alone are enough",
    PostPerformanceSchema.safeParse({
      impressions: 1850,
      loggedAt: "2026-07-06T00:00:00Z",
      source: "manual",
    }).success
  );
  check("patch: empty patch rejected", !SocialPostPatchSchema.safeParse({}).success);
  check(
    "voice profile schema round-trips",
    SocialVoiceProfileSchema.safeParse(VOICE).success
  );
}

/* ─────────────────────────── batch planning ────────────────────────── */

function planningChecks() {
  console.log("\n# batch planning — funnel mix + ordering");
  const stagesOf = (n: number) => buildBatchPlan(n, "balanced", "value").map((s) => s.funnelStage);
  check("5 balanced → 3 tofu / 1 mofu / 1 bofu", stagesOf(5).join(",") === "tofu,tofu,tofu,mofu,bofu");
  check("4 balanced → 2/1/1", stagesOf(4).join(",") === "tofu,tofu,mofu,bofu");
  check("3 balanced → 2/0/1 (mofu drops first)", stagesOf(3).join(",") === "tofu,tofu,bofu");
  check("2 balanced → 1/0/1", stagesOf(2).join(",") === "tofu,bofu");
  check(
    "1 → whatever the selected goal maps to",
    buildBatchPlan(1, "balanced", "launch")[0].funnelStage === "bofu"
  );
  check(
    "ordering is value-first (tofu earliest, bofu last)",
    stagesOf(5)[0] === "tofu" && stagesOf(5)[4] === "bofu"
  );
  const plan5 = buildBatchPlan(5, "balanced", "launch");
  check("balanced assigns goals per stage (mofu = pain_point)", plan5[3].goal === "pain_point");
  check("bofu slot honors a bofu selected goal", plan5[4].goal === "launch");
  check(
    "bofu slot defaults to benefit for a tofu selected goal",
    buildBatchPlan(5, "balanced", "value")[4].goal === "benefit"
  );
  check(
    "tofu slots alternate value/problem_solution",
    plan5[0].goal === "value" && plan5[1].goal === "problem_solution"
  );
  const pinned = buildBatchPlan(4, "pinned", "pain_point");
  check(
    "pinned mode is uniform goal + stage",
    pinned.every((s) => s.goal === "pain_point" && s.funnelStage === "mofu")
  );

  console.log("\n# goal → stage map (PRD §9.4)");
  const expected: Record<string, string> = {
    value: "tofu",
    problem_solution: "tofu",
    pain_point: "mofu",
    benefit: "bofu",
    launch: "bofu",
    promo_cta: "bofu",
  };
  for (const [goal, stage] of Object.entries(expected)) {
    check(`${goal} → ${stage}`, GOAL_STAGE_MAP[goal as keyof typeof GOAL_STAGE_MAP] === stage);
  }
}

/* ────────────────────────────── lint ───────────────────────────────── */

function lintChecks() {
  console.log("\n# safety lint — table-driven, whitelist escape hatch");
  const post = (body: string, hashtags: string[] = ["#a"]) => ({
    platform: "linkedin" as const,
    body,
    cta: null,
    hashtags,
  });
  const clean =
    "Most beginners think watercolor is about controlling the paint. Module 2 teaches the opposite: let the water move.";
  check("clean post passes", lintGeneratedPost(post(clean), "").length === 0);

  const earn = "My students made $5,000 in their first month using this method.";
  check(
    "earnings claim flagged",
    lintGeneratedPost(post(earn), "").some((v) => v.rule === "earnings_claim")
  );
  check(
    "earnings claim whitelisted when the creator's context contains it",
    lintGeneratedPost(post(earn), `Real result to quote: my students made $5,000 in their first month using this method.`).length === 0
  );

  const result = "Students achieved 300 point rating gains within weeks.";
  check(
    "fabricated student result flagged",
    lintGeneratedPost(post(result), "").some((v) => v.rule === "student_result_claim")
  );

  const scarcity = "Only 3 spots left — enroll before midnight.";
  check(
    "fake scarcity flagged",
    lintGeneratedPost(post(scarcity), "").some((v) => v.rule === "fake_scarcity")
  );
  check(
    "scarcity allowed when verbatim in creator context",
    lintGeneratedPost(post(scarcity), "Note: only 3 spots left — enroll before midnight.").length === 0
  );

  const testimonial = 'As one student put it: "This course changed how I paint forever and ever" — Maria.';
  check(
    "fabricated testimonial flagged",
    lintGeneratedPost(post(testimonial), "").some((v) => v.rule === "fabricated_testimonial")
  );

  check(
    "hashtag overflow flagged (LinkedIn max 5)",
    lintGeneratedPost(post(clean, ["#1a", "#2a", "#3a", "#4a", "#5a", "#6a"]), "").some(
      (v) => v.rule === "hashtag_overflow"
    )
  );

  const caps = "THIS IS THE MOST IMPORTANT COURSE YOU WILL EVER TAKE IN YOUR ENTIRE LIFE, DO NOT MISS IT.";
  check("ALL-CAPS ratio >30% flagged", lintGeneratedPost(post(caps), "").some((v) => v.rule === "all_caps_ratio"));
  check("short strings exempt from the caps rule", lintGeneratedPost(post("GO! Deep-dive time — a calm look at watercolor pigments today."), "").length === 0);

  const instruction = lintRepairInstruction(lintGeneratedPost(post(earn), ""));
  check(
    "repair instruction names the offense",
    instruction.includes("income/earnings") && instruction.includes("Never invent")
  );
}

/* ────────────────────────────── timing ─────────────────────────────── */

function localHourIn(tz: string, iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(iso))
  );
}
function localDayIn(tz: string, iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(new Date(iso));
}
function weekdayIn(tz: string, iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(iso));
}

function timingChecks() {
  console.log("\n# timing presets — tz-aware, jittered, DST-safe");
  const NOW = "2026-07-06T15:20:00.000Z"; // a Monday
  const TZ = "America/New_York";

  check(
    "preset none → all nulls",
    computePlannedTimes({ preset: "none", count: 4, nowIso: NOW, rand: seededRand() }).every((t) => t === null)
  );

  const custom = ["2026-07-08T09:00:00.000Z", "2026-07-09T09:00:00.000Z"];
  check(
    "custom passes through",
    computePlannedTimes({ preset: "custom", count: 2, nowIso: NOW, rand: seededRand(), customTimes: custom }).join(",") === custom.join(",")
  );

  const sameDay = computePlannedTimes({ preset: "same_day", count: 5, nowIso: NOW, timeZone: TZ, rand: seededRand() });
  check("same_day returns ISO instants", sameDay.every((t) => t !== null && !Number.isNaN(Date.parse(t))));
  const gaps = sameDay.slice(1).map((t, i) => Date.parse(t!) - Date.parse(sameDay[i]!));
  check("same_day spacing ≥ 2h", gaps.every((g) => g >= 2 * 3600_000), `gaps=${gaps.map((g) => Math.round(g / 60000))}min`);
  check("same_day starts after now", Date.parse(sameDay[0]!) > Date.parse(NOW));

  const week = computePlannedTimes({ preset: "spread_week", count: 5, nowIso: NOW, timeZone: TZ, rand: seededRand(7) });
  check("spread_week: one per day, no two same day", new Set(week.map((t) => localDayIn(TZ, t!))).size === 5);
  check(
    "spread_week: weekday-ish slots only",
    week.every((t) => !["Sat", "Sun"].includes(weekdayIn(TZ, t!)))
  );
  check(
    "spread_week: 9:00–11:59 local mornings",
    week.every((t) => localHourIn(TZ, t!) >= 9 && localHourIn(TZ, t!) <= 11),
    `hours=${week.map((t) => localHourIn(TZ, t!))}`
  );
  check("spread_week ascending (value-first order maps onto time)", week.every((t, i) => i === 0 || Date.parse(t!) > Date.parse(week[i - 1]!)));

  // DST spring-forward edge: US DST began 2026-03-08. Slots straddling it must
  // still land 9–11 local, and the wall-clock conversion must converge.
  const dstNow = "2026-03-06T12:00:00.000Z"; // Friday before the transition
  const dst = computePlannedTimes({ preset: "spread_2_weeks", count: 5, nowIso: dstNow, timeZone: TZ, rand: seededRand(3) });
  check(
    "spread_2_weeks across the DST edge stays 9:00–11:59 local",
    dst.every((t) => localHourIn(TZ, t!) >= 9 && localHourIn(TZ, t!) <= 11),
    `hours=${dst.map((t) => localHourIn(TZ, t!))}`
  );
  check("spread_2_weeks distinct ascending days", new Set(dst.map((t) => localDayIn(TZ, t!))).size === 5);
  const springForward = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 9, minute: 30 }, TZ);
  check(
    "zonedTimeToUtc: 9:30 local on the DST day = 13:30 UTC (EDT)",
    new Date(springForward).toISOString() === "2026-03-08T13:30:00.000Z"
  );

  const a = computePlannedTimes({ preset: "spread_week", count: 3, nowIso: NOW, timeZone: TZ, rand: seededRand(9) });
  const b = computePlannedTimes({ preset: "spread_week", count: 3, nowIso: NOW, timeZone: TZ, rand: seededRand(9) });
  check("deterministic under a seeded rand", a.join(",") === b.join(","));

  check(
    "invalid timezone degrades to UTC (never throws)",
    computePlannedTimes({ preset: "spread_week", count: 2, nowIso: NOW, timeZone: "Not/AZone", rand: seededRand() }).every((t) => t !== null)
  );
}

/* ────────────────────────────── export ─────────────────────────────── */

function exportChecks() {
  console.log("\n# export builders");
  const post = {
    id: "0f9b2c1d-aaaa-bbbb-cccc-000000000001",
    platform: "linkedin",
    funnelStage: "tofu",
    status: "ready",
    body: "Line one.\n\nLine two.",
    cta: "Follow along.",
    hashtags: ["#watercolor", "painting"],
    plannedPostAt: "2026-07-08T13:40:00.000Z",
  };
  const txt = buildTxtExport(post);
  check(".txt = body ␊␊ CTA ␊␊ hashtags", txt === "Line one.\n\nLine two.\n\nFollow along.\n\n#watercolor #painting\n");
  const md = buildMdExport(post);
  check(".md front-matter carries platform/stage/plannedPostAt/status", md.startsWith("---\nplatform: linkedin\nfunnelStage: tofu\nplannedPostAt: 2026-07-08T13:40:00.000Z\nstatus: ready\n---\n"));
  check(
    ".md never claims publication",
    !/publish|schedule/i.test(md)
  );
  check("copy text = body + CTA", buildCopyText(post) === "Line one.\n\nLine two.\n\nFollow along.");
  check("hashtags normalize the # prefix", md.includes("#watercolor #painting"));
  check("export filename is filesystem-safe", exportFileName(post, "md") === "linkedin-tofu-0f9b2c1d.md");
}

/* ───────────────────────────── imageMeta ───────────────────────────── */

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, then a minimal SOF0 segment:
  // FF C0 | len(2)=0x0011 | precision(1)=8 | height(2) | width(2) | …
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 0, 0, 0]);
  new DataView(b.buffer).setUint16(7, h);
  new DataView(b.buffer).setUint16(9, w);
  return b;
}
function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); // RIFF....WEBP
  b.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 12); // VP8X chunk header
  const dv = new DataView(b.buffer);
  const put24 = (o: number, v: number) => {
    dv.setUint8(o, v & 0xff);
    dv.setUint8(o + 1, (v >> 8) & 0xff);
    dv.setUint8(o + 2, (v >> 16) & 0xff);
  };
  put24(24, w - 1);
  put24(27, h - 1);
  return b;
}

function imageChecks() {
  console.log("\n# imageMeta — magic-byte sniffing (no deps)");
  check("PNG dims parsed", (() => {
    const m = parseImageMeta(png(1200, 627));
    return m?.mime === "image/png" && m.width === 1200 && m.height === 627;
  })());
  check("JPEG dims parsed from SOF0", (() => {
    const m = parseImageMeta(jpeg(1080, 1350));
    return m?.mime === "image/jpeg" && m.width === 1080 && m.height === 1350;
  })());
  check("WebP VP8X canvas dims parsed", (() => {
    const m = parseImageMeta(webpVp8x(1200, 630));
    return m?.mime === "image/webp" && m.width === 1200 && m.height === 630;
  })());
  check("garbage is rejected", parseImageMeta(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) === null);

  const norm = PLATFORM_LIMITS.linkedin.imageNorm;
  check("norm-matching image → no warning", imageNormWarning({ width: 1200, height: 627 }, norm, "LinkedIn") === null);
  check(
    "far-off aspect ratio → soft warning (never a block)",
    (imageNormWarning({ width: 600, height: 1200 }, norm, "LinkedIn") ?? "").includes("will still work")
  );
}

/* ────────────────────────── prompt stability ───────────────────────── */

function promptChecks() {
  console.log("\n# prompt — cache-stable prefix + version pin");
  check("PROMPT_VERSION pinned", PROMPT_VERSION === "social-v1");
  check(
    "system prompt is byte-stable across reads",
    SOCIAL_SYSTEM_PROMPT === SOCIAL_SYSTEM_PROMPT.slice(0) && SOCIAL_SYSTEM_PROMPT.length > 500
  );
  check(
    "system prompt carries both platform style guides",
    SOCIAL_SYSTEM_PROMPT.includes("LINKEDIN STYLE GUIDE") && SOCIAL_SYSTEM_PROMPT.includes("FACEBOOK STYLE GUIDE")
  );
  check(
    "system prompt bans fabrication + urgency",
    SOCIAL_SYSTEM_PROMPT.includes("fake student results") && SOCIAL_SYSTEM_PROMPT.includes("fake urgency")
  );
  check(
    "system prompt states the manual-publish model",
    SOCIAL_SYSTEM_PROMPT.includes("MANUALLY") && SOCIAL_SYSTEM_PROMPT.includes("never posts, schedules"),
    SOCIAL_SYSTEM_PROMPT.slice(0, 300)
  );
  check("revision prompt exists + stable", SOCIAL_REVISION_SYSTEM_PROMPT.includes("revise ONE existing social post"));
  const input = buildGenerationInput({
    voice: VOICE,
    sourceContext: 'COURSE: "Watercolor Foundations"',
    request: { platform: "linkedin", slots: buildBatchPlan(3, "balanced", "value"), tone: "friendly" },
  });
  check(
    "generation input carries voice + context + slots (variable block, not the system prefix)",
    input.includes("VOICE PROFILE") && input.includes("Watercolor Foundations") && input.includes("slot 3")
  );
  const repair = buildRepairInput({ originalInput: input, invalidJson: "{bad", issues: ["posts: expected array"] });
  check("repair input carries the invalid JSON + issue paths", repair.includes("{bad") && repair.includes("expected array"));
}

/* ───────────────────── templates (zero-key fallback) ───────────────── */

function templateChecks() {
  console.log("\n# deterministic template fallback — grounded + lint-clean");
  const ctx = {
    courseTitle: "Watercolor Foundations",
    description: "Learn transparent watercolor from first principles.",
    audience: "beginner painters",
    outcomes: ["Paint a controlled wet-on-wet wash"],
    moduleTitles: ["Wet-on-wet techniques", "Color mixing"],
    topic: null,
  };
  for (const platform of PLATFORMS) {
    const plan = buildBatchPlan(5, "balanced", "launch");
    const posts = buildTemplatePosts(plan, platform, "friendly", ctx);
    check(`${platform}: one post per slot`, posts.length === 5);
    check(
      `${platform}: references real course facts`,
      posts.some((p) => p.body.includes("Watercolor Foundations")) &&
        posts.some((p) => p.body.includes("Wet-on-wet techniques"))
    );
    check(
      `${platform}: within the char cap`,
      posts.every((p) => p.body.length <= PLATFORM_LIMITS[platform].charCap)
    );
    check(
      `${platform}: within the hashtag range`,
      posts.every((p) => p.hashtags.length <= PLATFORM_LIMITS[platform].hashtagMax)
    );
    check(
      `${platform}: lint-clean`,
      posts.every((p) => lintGeneratedPost({ platform, body: p.body, cta: p.cta, hashtags: p.hashtags }, "").length === 0)
    );
    check(
      `${platform}: image ideas are shootable, never generative`,
      posts.every((p) => !/generate|AI image/i.test(p.suggestedImageIdea))
    );
  }
  check(
    "hashtag fallback respects the platform max",
    suggestHashtagsDeterministic("Watercolor wash techniques for beginner painters and educators", "facebook").length <= 3
  );
}

/* ───────────────────────── tool registry snapshot ──────────────────── */

const EXPECTED_READ = [
  "list_social_posts",
  "get_social_post",
  "get_social_voice_profile",
  "suggest_hashtags",
  "draft_image_alt_text",
];
const EXPECTED_WRITE = [
  "generate_social_post_drafts",
  "revise_social_post",
  "change_post_tone",
  "regenerate_social_post",
  "create_social_post_variant",
  "create_social_post",
  "update_social_post",
  "delete_social_post",
  "mark_social_post_status",
  "attach_social_post_image",
  "remove_social_post_image",
  "rewrite_for_platform",
  "update_planned_post_time",
  "log_social_post_performance",
];

function registryChecks() {
  console.log("\n# tool registry snapshot — 19 tools, read + reversible ONLY");
  check("exactly 19 social tools", socialPostTools.length === 19, `got ${socialPostTools.length}`);
  const byName = new Map(socialPostTools.map((t) => [t.name, t]));
  for (const name of EXPECTED_READ) {
    check(`${name} registered as read`, byName.get(name)?.reversibility === "read");
  }
  for (const name of EXPECTED_WRITE) {
    check(`${name} registered as reversible`, byName.get(name)?.reversibility === "reversible");
  }
  check(
    "ZERO irreversible tools (no approval cards in this feature — the autonomy-redesign rule)",
    socialPostTools.every((t) => t.reversibility !== "irreversible")
  );
  check(
    "all social tools reachable through the shared registry",
    socialPostTools.every((t) => ALL_MARKETING_TOOLS.some((x) => x.name === t.name))
  );
  check(
    "read tools land in the agent's observe set",
    EXPECTED_READ.every((n) => MARKETING_READ_TOOLS.has(n))
  );
  check(
    "all 19 land in the generate-phase set (reads + reversible)",
    [...EXPECTED_READ, ...EXPECTED_WRITE].every((n) => MARKETING_GENERATE_TOOLS.has(n))
  );
  check(
    "versioned write tools require expectedVersion",
    ["revise_social_post", "change_post_tone", "regenerate_social_post", "update_social_post", "update_planned_post_time"].every(
      (n) => JSON.stringify((byName.get(n)?.params as { shape?: unknown }) ?? "").length > 0 &&
        Object.keys((byName.get(n)!.params as unknown as { shape: Record<string, unknown> }).shape).includes("expectedVersion")
    )
  );
}

/* ─────────────────────────── hardening greps ───────────────────────── */

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(p)) yield p;
  }
}

function grepChecks() {
  console.log("\n# hardening — language rules, no social hosts, no scheduler");
  const root = new URL("..", import.meta.url).pathname;

  // 1. Language rules: the banned phrases appear NOWHERE in feature UI files.
  const uiDirs = [join(root, "components/marketing/social"), join(root, "app/(app)/marketing/social")];
  const uiOffenders: string[] = [];
  for (const dir of uiDirs) {
    for (const f of walk(dir)) {
      const content = readFileSync(f, "utf8").toLowerCase();
      for (const phrase of BANNED_UI_PHRASES) {
        if (content.includes(phrase)) uiOffenders.push(`${f}: "${phrase}"`);
      }
    }
  }
  check("banned phrases absent from all feature UI strings", uiOffenders.length === 0, uiOffenders.join("; "));
  check(
    "the manual-publish sentence itself stays clean",
    !BANNED_UI_PHRASES.some((p) => MANUAL_PUBLISH_NOTICE.toLowerCase().includes(p))
  );

  // 2. No social-platform hosts anywhere in the feature (no APIs, no OAuth).
  const HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "tiktok.com", "twitter.com", "api.x.com", "graph.facebook"];
  const codeDirs = [
    join(root, "lib/marketing/social"),
    join(root, "app/api/marketing/social-posts"),
    join(root, "app/api/marketing/social-voice-profile"),
    join(root, "components/marketing/social"),
  ];
  const hostOffenders: string[] = [];
  for (const dir of codeDirs) {
    for (const f of walk(dir)) {
      const content = readFileSync(f, "utf8").toLowerCase();
      for (const h of HOSTS) if (content.includes(h)) hostOffenders.push(`${f}: ${h}`);
    }
  }
  check("zero social-platform hosts in the feature code", hostOffenders.length === 0, hostOffenders.join("; "));

  // 3. Absence of scheduler: nothing in the feature lib runs on a timer, and
  //    the marketing scheduler never reads social tables/fields.
  const timerOffenders: string[] = [];
  for (const f of walk(join(root, "lib/marketing/social"))) {
    const content = readFileSync(f, "utf8");
    if (/setInterval|setTimeout\(|pg_cron|node-cron|CronCreate/i.test(content)) timerOffenders.push(f);
  }
  check("no timer/cron primitives in lib/marketing/social", timerOffenders.length === 0, timerOffenders.join("; "));
  const scheduler = readFileSync(join(root, "lib/marketing/scheduler.ts"), "utf8");
  check(
    "the marketing scheduler never touches social posts or plannedPostAt",
    !/social_post|planned_post_at|plannedPostAt/.test(scheduler)
  );

  // 4. The versioned-update single-writer rule: .from("social_post") writes
  //    live ONLY in the repository + the gate's entity restore.
  const ALLOWED = ["lib/marketing/social/repository.ts", "lib/marketing/entities.ts"];
  const writeOffenders: string[] = [];
  for (const dir of [join(root, "lib"), join(root, "app"), join(root, "components")]) {
    for (const f of walk(dir)) {
      if (ALLOWED.some((a) => f.endsWith(a))) continue;
      const content = readFileSync(f, "utf8");
      if (/from\(["']social_post["']\)\s*\r?\n?\s*\.(update|insert|upsert|delete)/m.test(content.replace(/\s+/g, " "))) {
        writeOffenders.push(f);
      }
    }
  }
  check(
    "social_post writes confined to repository.ts + entities.ts",
    writeOffenders.length === 0,
    writeOffenders.join("; ")
  );
}

/* ────────────────────────────── run ────────────────────────────────── */

schemaChecks();
planningChecks();
lintChecks();
timingChecks();
exportChecks();
imageChecks();
promptChecks();
templateChecks();
registryChecks();
grepChecks();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
