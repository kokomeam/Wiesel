/**
 * TUTOR-1 — Amendment A4, Wave 2 · PURE suite (no DB, no key).
 *
 *   • chunker: per-slide / per-block grain, resolvable anchors, ordinal, skips
 *     imported_deck/video/empty                                          [A4-12]
 *   • padToDims: pad/truncate + the cosine-preserving property
 *   • toVectorLiteral format
 *   • the retrieval RPC's lesson filter is INSIDE the query (source assertion) [A4-11]
 *   • no chunk stores a source_tier other than 'canon' (CHECK assertion)   [A4-13]
 *
 * Run: `npx tsx scripts/verify-tutor-retrieval.ts`
 */

import { readFileSync } from "node:fs";

import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import {
  deriveRetrievalChunks,
  retrievalAnchorToHref,
} from "@/lib/tutor/retrieval/chunker";
import { padToDims, toVectorLiteral, TUTOR_EMBEDDING_DIMS } from "@/lib/tutor/retrieval/config";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/* ─────────────────────────────── fixture ───────────────────────────────── */

const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const DECK = "bbbbbbbb-0000-4000-8000-00000000000d";
const LECT = "bbbbbbbb-0000-4000-8000-00000000000e";
const QUIZ = "bbbbbbbb-0000-4000-8000-00000000000f";
const IMP = "bbbbbbbb-0000-4000-8000-000000000010";

/** A loosely-built snapshot (cast) — the chunker reads only specific fields. */
function buildSnapshot(): PublicationSnapshot {
  const slide = (id: string, title: string, text: string) => ({
    id, type: "slide", title, layout: "title", style: {}, order: 0,
    ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] },
    elements: [{ id: `${id}-el`, type: "text", text }],
  });
  return {
    schemaVersion: 1,
    course: { id: "cccccccc-0000-4000-8000-000000000001", title: "Data Structures", plan: { outcomes: [], prerequisites: [] }, theme: { name: "Editorial Warm", accent: "amber", slideDefaults: { layout: "title", themeId: "editorial-warm" } } },
    modules: [
      {
        id: "mod-1", type: "module", title: "Balanced Trees", order: 0,
        lessons: [
          {
            id: L1, type: "lesson", title: "2-3 Trees", objective: "Understand 2-3 tree balancing.", order: 0,
            blocks: [
              {
                id: DECK, type: "slide_deck", title: "2-3 Tree deck", order: 0,
                ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] },
                slides: [
                  slide("s1", "What is a 2-3 tree", "A 2-3 tree keeps every leaf at the same depth."),
                  slide("s2", "Amortized cost", "Insertions run in amortized logarithmic time."),
                  // an empty slide (no text) → must be skipped
                  { id: "s3", type: "slide", title: "", layout: "title", style: {}, order: 2, ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] }, elements: [] },
                ],
              },
              {
                id: LECT, type: "lecture_text", title: "Notes", order: 1,
                ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] },
                tone: "detailed",
                paragraphs: [{ id: "p1", kind: "paragraph", text: "The LLRB tree is a red-black variant." }],
              },
              // imported_deck → no snapshot prose → skipped
              { id: IMP, type: "imported_deck", title: "Slides.pdf", order: 2, ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] }, asset: { status: "ready", pageCount: 3 } },
            ],
          },
          {
            id: L2, type: "lesson", title: "Hashing", objective: "Understand hashing.", order: 1,
            blocks: [
              {
                id: QUIZ, type: "quiz", title: "Hash quiz", order: 0,
                ai: { purpose: "assess", editable: true, allowedActions: [], semanticTags: [] },
                questions: [{ id: "q1", type: "mc", prompt: "What is a collision?", choices: [{ id: "c1", text: "Two keys map to one bucket" }] }],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as PublicationSnapshot;
}

function main(): void {
  const snapshot = buildSnapshot();
  const chunks = deriveRetrievalChunks(snapshot);

  console.log("\n— chunker: per-slide / per-block grain (A4-4 grain) —");
  const bySlide = chunks.filter((c) => c.slideId !== null);
  const byBlock = chunks.filter((c) => c.slideId === null);
  check("one chunk per NON-EMPTY slide (2 of 3 slides; the empty one skipped)", bySlide.length === 2, `slides=${bySlide.length}`);
  check("the empty slide (s3) produced NO chunk", !chunks.some((c) => c.slideId === "s3"));
  check("non-deck text blocks each get ONE chunk (lecture + quiz)", byBlock.length === 2, `blocks=${byBlock.length}`);
  check("imported_deck produced NO chunk (no snapshot prose)", !chunks.some((c) => c.blockId === IMP));
  check("chunkOrdinal is 0..n-1 in document order", chunks.every((c, i) => c.chunkOrdinal === i));
  check("slide chunk text includes the slide's own content", bySlide[0].text.includes("same depth"));
  check("chunk text is prefixed with the module › lesson heading", bySlide[0].text.startsWith("Balanced Trees › 2-3 Trees"));
  check("lexical term '2-3 tree' survives into a chunk (for A4-10)", chunks.some((c) => /2-3 tree/i.test(c.text)));
  check("quiz chunk mines stems + choice text", byBlock.some((c) => c.text.includes("collision") && c.text.includes("one bucket")));

  console.log("\n— anchors: every chunk carries a RESOLVABLE display anchor (A4-12) —");
  const blockIds = new Set<string>();
  const slideIds = new Set<string>();
  for (const m of snapshot.modules) for (const l of m.lessons) for (const b of l.blocks) {
    blockIds.add(b.id);
    if (b.type === "slide_deck") for (const s of (b as unknown as { slides: { id: string }[] }).slides) slideIds.add(s.id);
  }
  check("every chunk anchor's blockId resolves to a real snapshot block", chunks.every((c) => blockIds.has(c.anchor.blockId)));
  check("every slide-chunk anchor's slideId resolves to a real slide", bySlide.every((c) => c.anchor.slideId !== null && slideIds.has(c.anchor.slideId)));
  check("anchor lessonId matches the chunk's lesson", chunks.every((c) => c.anchor.lessonId === c.lessonId));
  const href = retrievalAnchorToHref("data-structures", bySlide[0].anchor);
  check("retrievalAnchorToHref builds a ?block=&slide= deep link", href === `/learn/data-structures/${L1}?block=${DECK}&slide=s1`, href);
  const blockHref = retrievalAnchorToHref("data-structures", byBlock[0].anchor);
  check("a block-level anchor href omits &slide=", !blockHref.includes("&slide="), blockHref);

  console.log("\n— padToDims + toVectorLiteral —");
  check("padToDims pads a short vector with zeros to the stored dim", padToDims([1, 2, 3]).length === TUTOR_EMBEDDING_DIMS);
  check("padToDims truncates an over-long vector", padToDims(new Array(TUTOR_EMBEDDING_DIMS + 5).fill(1)).length === TUTOR_EMBEDDING_DIMS);
  check("padToDims is a no-op at the exact dim", padToDims(new Array(TUTOR_EMBEDDING_DIMS).fill(0.5)).length === TUTOR_EMBEDDING_DIMS);
  // The cosine-preserving property (why a 32-dim mock ranks identically once padded).
  const a = [0.2, 0.9, -0.4, 0.1], b = [0.7, -0.3, 0.5, 0.2];
  check("zero-padding PRESERVES cosine exactly (mock ranking is unaffected)", Math.abs(cosine(a, b) - cosine(padToDims(a), padToDims(b))) < 1e-9);
  check("toVectorLiteral renders the pgvector [a,b,c] literal", toVectorLiteral([1, 2, 3]) === "[1,2,3]");

  console.log("\n— retrieval RPC: lesson filter INSIDE the query + source_tier CHECK (A4-11 / A4-13) —");
  const migration = readFileSync(new URL("../supabase/migrations/20260810140000_tutor_retrieval_chunks.sql", import.meta.url), "utf8");
  const filterHits = (migration.match(/lesson_id = any\(p_lesson_ids\)/g) ?? []).length;
  check("BOTH retrieval arms filter lesson_id = any(p_lesson_ids) IN the query (A4-11)", filterHits >= 2, `matches=${filterHits}`);
  check("the retrieve RPC uses pgvector cosine (<=>) for the vector arm", migration.includes("embedding <=>"));
  check("the retrieve RPC uses tsvector lexical match (websearch_to_tsquery)", migration.includes("websearch_to_tsquery"));
  check("A4-13: source_tier is CHECK-constrained to 'canon' (adjacent unreachable)", /check\s*\(source_tier\s*=\s*'canon'\)/.test(migration));
  check("A4-13: the chunker never emits a source_tier (it is the DB default 'canon')", !JSON.stringify(chunks).includes("source_tier"));

  console.log("\n— publish → embed wiring (A4-9) —");
  const publishSvc = readFileSync(new URL("../lib/course/publish/service.ts", import.meta.url), "utf8");
  check("publishCourse enqueues the chunk-embed on a REAL publish", publishSvc.includes("enqueueChunkEmbedForPublish"));
  const inngestRoute = readFileSync(new URL("../app/api/inngest/route.ts", import.meta.url), "utf8");
  check("the durable tutorChunksEmbed function is REGISTERED in the Inngest route", inngestRoute.includes("tutorChunksEmbed"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
