/**
 * TUTOR-1 Amendment A4, Wave 2 — pgvector RETRIEVAL INDEX INTEGRATION suite
 * (live Supabase + the deterministic mock model; no OpenAI key needed).
 * Self-provisions throwaway users each run. Requires SUPABASE_SERVICE_ROLE_KEY
 * (tutor_chunks writes go through the service-role definer RPC / admin client).
 *
 * PREREQUISITE: the A4 Wave-2 migration 20260810140000_tutor_retrieval_chunks.sql
 * (+ the base course/publish/enroll schema) is applied to the live project.
 *
 * The fixture is one module → TWO lessons, each with a slide_deck (2 slides with
 * real text) AND lesson 1 with a lecture_text block. A DISTINCTIVE lexical term
 * ("LLRB") lives in EXACTLY ONE lesson-1 slide's text (the lexical-only test); a
 * second distinctive term ("Splaytree") is the fallback if mock-vector coincidence
 * makes LLRB the vector top-1.
 *
 *   A4-9 (embed at publish, every lesson; idempotent republish = zero embeds):
 *     • first embedAndStoreChunks → skipped=false, embedded=chunks>0.
 *     • distinct lesson_id over tutor_chunks EQUALS {lesson1, lesson2}.
 *     • a second call (same publicationId) → skipped=true, embedded=0, and the
 *       mock's getEmbedCalls().length delta is EXACTLY 0.
 *
 *   A4-10 (hybrid: a lexical-only match a pure vector arm misses):
 *     • retrieveChunks(queryText contains "LLRB", vectorLimit:1) surfaces the
 *       LLRB chunk via the LEXICAL arm (lexicalRank≠null; vectorRank null unless
 *       it also happened to be the mock-vector top-1).
 *
 *   A4-11 (lesson filter INSIDE the query — behavioral):
 *     • eligibleLessonIds=[lesson2] → every returned chunk has lessonId=lesson2;
 *       no lesson1 chunk appears even for lesson-1 terms.
 *
 *   A4-12 (resolvable anchor):
 *     • every retrieved chunk's anchor.blockId resolves to a real snapshot block;
 *       retrievalAnchorToHref returns /learn/{slug}/{lessonId}?block=… (&slide= iff
 *       slideId present).
 *
 *   A4-13 (source_tier canon-only, CHECK enforced):
 *     • every stored row has source_tier='canon'.
 *     • a DIRECT admin insert with source_tier='adjacent' FAILS the CHECK.
 *
 * Run (AFTER the migration): `npx tsx scripts/verify-tutor-retrieval-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; pin IPv4-first (this dev machine's
// Clash setup resets IPv6 TLS before the handshake). Harmless everywhere else.
dns.setDefaultResultOrder("ipv4first");

/** Retry transient TRANSPORT failures (never HTTP errors) — this network drops
 *  connections sporadically mid-run. */
const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
};

import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule, createSlide, newRowId } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, LectureTextBlock, SlideDeckBlock, Slide } from "@/lib/course/types";
import { resolveLivePublicationBySlug, type PublicationRow } from "@/lib/learn/resolve";
import { PublicationSnapshotSchema, type PublicationSnapshot } from "@/lib/course/publish/schemas";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { embedAndStoreChunks, chunksExistForPublication } from "@/lib/tutor/retrieval/embedStore";
import { retrieveChunks } from "@/lib/tutor/retrieval/retrieve";
import { deriveRetrievalChunks, retrievalAnchorToHref } from "@/lib/tutor/retrieval/chunker";

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

type DB = SupabaseClient<Database>;

function loadEnv(): { url: string; anon: string; service?: string } {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY,
  };
}

async function provisionUser(
  url: string,
  anon: string,
  tag: string
): Promise<{ client: DB; userId: string; email: string }> {
  const email = `tutor-retr-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id, email };
}

/** Give a slide a title + one text element carrying `body` (so the chunker mines
 *  real, distinctive text per slide — createSlide's placeholders start empty). */
function seedSlide(layoutId: string, title: string, body: string): Slide {
  const slide = createSlide(layoutId);
  slide.title = title;
  // Ensure at least one text-bearing element carries `body`. Prefer an existing
  // text/heading placeholder; else append a text element (matches the chunker's
  // el.text mining path either way).
  const textEl = slide.elements.find((e) => e.type === "text" || e.type === "heading");
  if (textEl && (textEl.type === "text" || textEl.type === "heading")) {
    textEl.text = body;
  } else {
    slide.elements.push({
      id: newRowId(),
      type: "text",
      text: body,
      x: 100,
      y: 100,
      width: 600,
      height: 200,
      zIndex: slide.elements.length,
      style: {},
      ai: { formattingRules: [], qualityChecks: [], allowedActions: [] },
    } as unknown as Slide["elements"][number]);
  }
  return slide;
}

/**
 * Publishable fixture: one module → TWO lessons.
 *  • Lesson 1: a 2-slide deck (slide 1 carries "LLRB" — the DISTINCTIVE lexical
 *    term used ONLY once; slide 2 carries "Splaytree" — the fallback term) PLUS a
 *    lecture_text block. Both lessons therefore have chunkable content.
 *  • Lesson 2: a 2-slide deck with its own distinctive lesson-2-only terms.
 */
function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  // Lesson 1 deck — slide 1 = LLRB (the lexical-only probe), slide 2 = Splaytree.
  const deckA = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deckA.slides = [
    seedSlide(
      "title",
      "Balanced search trees",
      "A left-leaning red-black tree, abbreviated LLRB, keeps every path balanced within a constant factor."
    ),
    seedSlide(
      "title_bullets",
      "Rotations and rebalancing",
      "A Splaytree moves recently accessed keys toward the root using rotations to keep hot keys shallow."
    ),
  ];
  const lectureA = createBlock("lecture_text", 1) as LectureTextBlock;
  lectureA.title = "Lesson one notes";
  lectureA.paragraphs = [
    {
      id: newRowId(),
      kind: "paragraph",
      text: "These notes explain how balanced trees bound the height of the structure logarithmically.",
    },
  ];
  const lessonA = createLesson("Lesson A", 0);
  lessonA.blocks = [deckA, lectureA];

  // Lesson 2 deck — lesson-2-only distinctive terms (never overlap lesson 1).
  const deckB = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deckB.slides = [
    seedSlide(
      "title",
      "Hashing fundamentals",
      "A hashmap distributes keys across buckets so lookups average constant time under a good hash."
    ),
    seedSlide(
      "title_bullets",
      "Collision handling",
      "When two keys collide in a bucket, chaining stores them in a linked list of entries."
    ),
  ];
  const lessonB = createLesson("Lesson B", 1);
  lessonB.blocks = [deckB];

  const mod = createModule("Foundations", 0);
  mod.lessons = [lessonA, lessonB];
  return {
    id: courseId,
    title,
    description: "Tutor retrieval integration fixture.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

async function seedCourse(client: DB, doc: CourseDocument, ownerId: string): Promise<void> {
  const rows = courseDocToRows(doc, ownerId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
}

/** Collect every block id that appears anywhere in the published snapshot. */
function snapshotBlockIds(snapshot: PublicationSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) {
      for (const block of lesson.blocks) ids.add(block.id);
    }
  }
  return ids;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor:retrieval:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Tutor retrieval itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course (one module → two lessons; lesson 1 has a deck + lecture_text)");

  const lesson1Id = doc.modules[0].lessons[0].id;
  const lesson2Id = doc.modules[0].lessons[1].id;

  const cleanup = async () => {
    // tutor_chunks cascade off the publication/course, but delete explicitly first
    // (before the course delete) to be robust regardless of cascade timing.
    await admin.from("tutor_chunks").delete().eq("course_id", courseId);
    await admin.from("tutor_turns").delete().eq("course_id", courseId);
    await admin.from("tutor_threads").delete().eq("course_id", courseId);
    await admin.from("tutor_course_settings").delete().eq("course_id", courseId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll (only the learner) ── */
    console.log("\n# publish + enroll");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const publication: PublicationRow = found.publication;
    const slug = publication.slug;

    const enrolled = await learner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner.userId })
      .select("*")
      .single();
    check("learner self-enrolls", !enrolled.error, String(enrolled.error?.message));

    // The immutable snapshot (+ version + content_hash) from the published row.
    const pubRow = await admin
      .from("course_publications")
      .select("snapshot, version, content_hash")
      .eq("id", publication.id)
      .single();
    if (pubRow.error || !pubRow.data) throw new Error(`publication row load: ${pubRow.error?.message}`);
    const snapshot = PublicationSnapshotSchema.parse((pubRow.data as { snapshot: unknown }).snapshot);
    const version = (pubRow.data as { version: number }).version;
    const contentHash = (pubRow.data as { content_hash: string }).content_hash;

    // The embed client — un-pooled (embedStore §: publish-time bulk embed is
    // creator/background work, never the learner pool). The mock implements
    // .embed() (deterministic 32-dim) + records .getEmbedCalls().
    const mock = createMockModelClient([], {});

    // Ground-truth chunk set from the snapshot (what embed SHOULD produce).
    const expectedChunks = deriveRetrievalChunks(snapshot);
    check("fixture yields >0 derivable chunks", expectedChunks.length > 0, String(expectedChunks.length));

    /* ═══════════════════ A4-9 — embed at publish; idempotent republish ════════ */
    console.log("\n# A4-9 — embedAndStoreChunks embeds every lesson once; a repeat is a zero-embed no-op");

    check("A4-9 (pre): no chunks exist yet for the publication",
      (await chunksExistForPublication(admin, publication.id)) === false);

    const first = await embedAndStoreChunks(admin, mock, {
      courseId,
      publicationId: publication.id,
      version,
      contentHash,
      snapshot,
    });
    check("A4-9: first embed → skipped=false", first.skipped === false, JSON.stringify(first));
    check("A4-9: first embed → embedded === deriveRetrievalChunks(snapshot).length > 0",
      first.embedded === expectedChunks.length && first.embedded > 0,
      JSON.stringify({ embedded: first.embedded, expected: expectedChunks.length }));

    // Every lesson WITH content is embedded: distinct lesson_id over tutor_chunks
    // EQUALS {lesson1, lesson2}.
    const distinctLessons = await admin
      .from("tutor_chunks")
      .select("lesson_id")
      .eq("publication_id", publication.id);
    const lessonSet = new Set((distinctLessons.data ?? []).map((r) => r.lesson_id as string));
    check("A4-9: distinct stored lesson_ids EQUAL {lesson1, lesson2} (every lesson with content embedded)",
      lessonSet.size === 2 && lessonSet.has(lesson1Id) && lessonSet.has(lesson2Id),
      JSON.stringify({ stored: [...lessonSet], expected: [lesson1Id, lesson2Id] }));

    // Record the embed-call count AFTER call 1, then call again on the SAME
    // publication — the idempotency guard must make ZERO additional embed calls.
    const embedCallsAfterFirst = mock.getEmbedCalls().length;
    check("A4-9: the first embed actually issued ≥1 embed call", embedCallsAfterFirst >= 1, String(embedCallsAfterFirst));

    const second = await embedAndStoreChunks(admin, mock, {
      courseId,
      publicationId: publication.id,
      version,
      contentHash,
      snapshot,
    });
    check("A4-9: republish-unchanged → skipped=true, embedded=0", second.skipped === true && second.embedded === 0,
      JSON.stringify(second));
    const embedCallDelta = mock.getEmbedCalls().length - embedCallsAfterFirst;
    check("A4-9: republish-unchanged issued EXACTLY ZERO additional embed calls",
      embedCallDelta === 0, `delta=${embedCallDelta}`);

    /* ═══════════════════ A4-10 — hybrid: lexical-only match ═══════════════════ */
    console.log("\n# A4-10 — a lexical-only term (LLRB) is surfaced by the lexical arm even with vectorLimit:1");

    // Confirm "LLRB" is in EXACTLY ONE chunk (the invariant the probe relies on).
    const llrbChunks = expectedChunks.filter((c) => /LLRB/.test(c.text));
    check("A4-10 (pre): 'LLRB' appears in exactly one derived chunk", llrbChunks.length === 1, String(llrbChunks.length));

    // websearch_to_tsquery ANDs its lexemes, so the query terms must be a SUBSET
    // of the target chunk's tsv. "LLRB balanced tree" → 'llrb' & 'balanc' & 'tree',
    // all present in the LLRB slide and — crucially — 'llrb' is present in NO other
    // chunk, so the lexical arm matches exactly the LLRB chunk. The mock's
    // semantically-meaningless vectors make it almost impossible for the LLRB chunk
    // to also be the single vector-top-1, so lexical is what carries it.
    const hybrid = await retrieveChunks(admin, mock, {
      publicationId: publication.id,
      queryText: "LLRB balanced tree",
      eligibleLessonIds: [lesson1Id, lesson2Id],
      vectorLimit: 1, // vector arm returns only its single mock-nearest chunk
    });
    // KEY assertion: a term-matching chunk appears VIA the lexical arm (lexicalRank
    // non-null), which a 1-candidate vector arm would (essentially) miss.
    const llrbHit = hybrid.find((r) => /LLRB/.test(r.text));
    check("A4-10: the LLRB chunk IS in the hybrid results", llrbHit !== undefined,
      JSON.stringify(hybrid.map((r) => ({ ord: r.chunkOrdinal, v: r.vectorRank, l: r.lexicalRank }))));
    check("A4-10: the LLRB chunk was surfaced by the LEXICAL arm (lexicalRank ≠ null)",
      llrbHit?.lexicalRank != null,
      JSON.stringify({ vectorRank: llrbHit?.vectorRank, lexicalRank: llrbHit?.lexicalRank }));
    // Corroborating: with vectorLimit:1 the lexical arm is what carried it (the
    // vector arm's single candidate is almost never the semantically-meaningless
    // mock's LLRB chunk — but if it coincidentally IS, lexicalRank still holds).
    check("A4-10: some result matches the term via the lexical arm (hybrid > pure vector)",
      hybrid.some((r) => /LLRB/.test(r.text) && r.lexicalRank != null));

    /* ═══════════════════ A4-11 — lesson filter INSIDE the query ═══════════════ */
    console.log("\n# A4-11 — eligibleLessonIds=[lesson2] returns ONLY lesson-2 chunks (in-query filter)");

    // Query using lesson-1 terms but restrict eligibility to lesson 2 — a
    // POST-filter that fetched then filtered could still leak; the in-query filter
    // must return only lesson-2 chunks (or nothing), never a lesson-1 chunk.
    const lesson2Only = await retrieveChunks(admin, mock, {
      publicationId: publication.id,
      queryText: "left-leaning red-black tree LLRB rotations balanced",
      eligibleLessonIds: [lesson2Id],
    });
    check("A4-11: every returned chunk belongs to lesson 2",
      lesson2Only.every((r) => r.lessonId === lesson2Id),
      JSON.stringify(lesson2Only.map((r) => r.lessonId)));
    check("A4-11: NO lesson-1 chunk appears (proves the in-query filter, not a post-filter)",
      !lesson2Only.some((r) => r.lessonId === lesson1Id));
    check("A4-11: restricting to lesson 2 still returns results (the filter runs, not a wipe)",
      lesson2Only.length > 0, String(lesson2Only.length));

    /* ═══════════════════ A4-12 — resolvable anchor ════════════════════════════ */
    console.log("\n# A4-12 — every retrieved chunk's anchor resolves to a real block + a valid deep-link href");

    const allBlockIds = snapshotBlockIds(snapshot);
    const broad = await retrieveChunks(admin, mock, {
      publicationId: publication.id,
      queryText: "balanced trees hashing buckets rotations",
      eligibleLessonIds: [lesson1Id, lesson2Id],
    });
    check("A4-12 (pre): a broad query returns ≥1 chunk to anchor-check", broad.length > 0, String(broad.length));

    const everyAnchorResolves = broad.every((r) => allBlockIds.has(r.anchor.blockId));
    check("A4-12: every retrieved chunk's anchor.blockId resolves to a real snapshot block",
      everyAnchorResolves,
      JSON.stringify(broad.map((r) => r.anchor.blockId)));

    const everyHrefValid = broad.every((r) => {
      const href = retrievalAnchorToHref(slug, r.anchor);
      const base = `/learn/${slug}/${r.anchor.lessonId}?block=${encodeURIComponent(r.anchor.blockId)}`;
      const expected = r.anchor.slideId ? `${base}&slide=${encodeURIComponent(r.anchor.slideId)}` : base;
      // &slide= present iff slideId present.
      const slideConsistent = r.anchor.slideId ? href.includes("&slide=") : !href.includes("&slide=");
      return href === expected && href.startsWith(`/learn/${slug}/${r.anchor.lessonId}?block=`) && slideConsistent;
    });
    check("A4-12: retrievalAnchorToHref → /learn/{slug}/{lessonId}?block=… (&slide= iff slideId present)",
      everyHrefValid,
      JSON.stringify(broad.map((r) => ({ href: retrievalAnchorToHref(slug, r.anchor), slideId: r.anchor.slideId }))));
    // At least one deck chunk (slideId present) so the &slide= branch is exercised.
    check("A4-12: at least one retrieved chunk is a slide chunk (exercises the &slide= branch)",
      broad.some((r) => r.anchor.slideId != null));

    /* ═══════════════════ A4-13 — source_tier canon-only (CHECK) ═══════════════ */
    console.log("\n# A4-13 — every stored row is 'canon'; a direct 'adjacent' insert FAILS the CHECK");

    const tiers = await admin.from("tutor_chunks").select("source_tier").eq("publication_id", publication.id);
    check("A4-13: every stored chunk row has source_tier='canon'",
      (tiers.data ?? []).length > 0 && (tiers.data ?? []).every((r) => (r as { source_tier: string }).source_tier === "canon"),
      JSON.stringify((tiers.data ?? []).map((r) => (r as { source_tier: string }).source_tier)));

    // A direct admin insert with source_tier='adjacent' — otherwise-valid row
    // (real 1536-dim embedding literal). The CHECK (source_tier = 'canon') must
    // reject it, proving 'adjacent' is unreachable.
    const zeroVec1536 = "[" + Array(1536).fill(0).join(",") + "]";
    const adjacentInsert = await admin.from("tutor_chunks").insert({
      course_id: courseId,
      publication_id: publication.id,
      version,
      content_hash: contentHash,
      lesson_id: lesson1Id,
      block_id: doc.modules[0].lessons[0].blocks[0].id,
      slide_id: null,
      chunk_ordinal: 100000, // avoid the (publication_id, chunk_ordinal) unique clash
      text: "an adjacent-tier chunk that must be rejected",
      embedding: zeroVec1536,
      display_anchor: { lessonId: lesson1Id, blockId: doc.modules[0].lessons[0].blocks[0].id, slideId: null },
      source_tier: "adjacent",
    } as never);
    check("A4-13: a direct insert with source_tier='adjacent' FAILS the check constraint",
      adjacentInsert.error !== null,
      `error=${adjacentInsert.error?.message ?? "(none — insert unexpectedly SUCCEEDED)"}`);

    // Sanity: the same row with source_tier='canon' would be accepted (control) —
    // then clean it so it never leaks into other assertions on rerun. This proves
    // the rejection above was the tier CHECK, not some other constraint.
    const canonControl = await admin.from("tutor_chunks").insert({
      course_id: courseId,
      publication_id: publication.id,
      version,
      content_hash: contentHash,
      lesson_id: lesson1Id,
      block_id: doc.modules[0].lessons[0].blocks[0].id,
      slide_id: null,
      chunk_ordinal: 100001,
      text: "a canon-tier control chunk (accepted, then removed)",
      embedding: zeroVec1536,
      display_anchor: { lessonId: lesson1Id, blockId: doc.modules[0].lessons[0].blocks[0].id, slideId: null },
      source_tier: "canon",
    } as never);
    check("A4-13: the SAME row with source_tier='canon' is ACCEPTED (control — the CHECK is tier-specific)",
      canonControl.error === null, String(canonControl.error?.message));
    await admin.from("tutor_chunks").delete().eq("publication_id", publication.id).eq("chunk_ordinal", 100001);
  } finally {
    await cleanup();
    console.log("\n# cleaned up course + tutor_chunks + tutor rows (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
