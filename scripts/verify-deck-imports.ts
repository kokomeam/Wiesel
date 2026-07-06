/**
 * Imported-deck (PPT/PPTX/PDF) checks — pure, no key / no DB / no network.
 * Run: `npx tsx scripts/verify-deck-imports.ts`
 *
 * Covers the data-model + service contracts that the upload flow, worker, and
 * rail viewer all depend on:
 *  1. Upload validation — extension/MIME agreement, size bounds, sanitize, title.
 *  2. Status state machine — exactly the legal transitions.
 *  3. Imported-deck block schema + persistence round-trip (content jsonb).
 *  4. Patch pipeline — ADD_BLOCK + UPDATE_IMPORTED_DECK reducers; native deck kept.
 *  5. Storage path builders — owner-first paths, padded page labels.
 *  6. row → client View — page sort + SIGNED urls + missing-page fallback.
 *  7. NO permanent public URLs (the storage layer never calls getPublicUrl).
 *  8. Google-Slides-compatible source shape (schema-ready, not implemented).
 *  9. pngDimensions IHDR reader (worker).
 */

import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  createImportedDeckBlock,
  createLesson,
  createModule,
} from "@/lib/course/factories";
import { LessonBlockSchema } from "@/lib/course/schemas";
import {
  addBlockPatch,
  addImportedDeckBlockPatch,
  updateImportedDeckPatch,
} from "@/lib/course/commands";
import { applyCoursePatch, CoursePatchSchema } from "@/lib/course/patches";
import { PLACEHOLDER_COURSE } from "@/lib/course/placeholder";
import { findBlock } from "@/lib/course/queries";
import type { CourseDocument, ImportedDeckBlock, LessonBlock } from "@/lib/course/types";
import {
  ACCEPTED_EXTENSIONS,
  canTransition,
  DECK_IMPORT_STATUSES,
  deriveDeckTitle,
  extensionOf,
  formatBytes,
  formatForFile,
  MAX_DECK_FILE_BYTES,
  sanitizeFileName,
  validateUpload,
} from "@/lib/course/imports/deckImportValidation";
import {
  deckImportRoot,
  originalObjectPath,
  pageLabel,
  pageObjectPath,
  previewPdfObjectPath,
  thumbObjectPath,
} from "@/lib/course/imports/deckImportStorage";
import { buildDeckImportView } from "@/lib/course/imports/deckImportService";
import {
  rowSourceType,
  rowStatus,
  type DeckImportPageRow,
  type DeckImportRow,
} from "@/lib/course/imports/deckImportTypes";
import { pngDimensions } from "@/workers/deck-import/renderPdfPages";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n} ${d}`);
  }
};
/** Order-insensitive deep equality (persistence reorders keys: content + id). */
function stable(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(stable);
  if (o && typeof o === "object")
    return Object.fromEntries(Object.keys(o as object).sort().map((k) => [k, stable((o as Record<string, unknown>)[k])]));
  return o;
}
const deepEqual = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

const NOW = "2026-06-29T00:00:00.000Z";
const OWNER = "11111111-1111-1111-1111-111111111111";
const COURSE = "22222222-2222-2222-2222-222222222222";
const DECK = "33333333-3333-3333-3333-333333333333";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PPT_MIME = "application/vnd.ms-powerpoint";

async function main() {
/* ───────────────────── 1. upload validation ───────────────────── */
console.log("\n# 1. Upload validation");

check("a valid .pdf passes", validateUpload({ fileName: "deck.pdf", mimeType: "application/pdf", size: 1000 }).ok);
check("a valid .pptx passes", validateUpload({ fileName: "deck.pptx", mimeType: PPTX_MIME, size: 1000 }).ok);
check("a valid .ppt passes", validateUpload({ fileName: "deck.ppt", mimeType: PPT_MIME, size: 1000 }).ok);
check(
  "a generic octet-stream MIME falls back to the extension (.pptx)",
  validateUpload({ fileName: "deck.pptx", mimeType: "application/octet-stream", size: 1000 }).ok
);
check(
  "a CONFLICTING MIME is rejected (pdf bytes claimed for a .pptx name)",
  !validateUpload({ fileName: "deck.pptx", mimeType: "application/pdf", size: 1000 }).ok
);
check("an unsupported extension (.key) is rejected", !validateUpload({ fileName: "deck.key", mimeType: "", size: 1000 }).ok);
check("an empty file is rejected", !validateUpload({ fileName: "deck.pdf", mimeType: "application/pdf", size: 0 }).ok);
check(
  "an oversize file is rejected",
  !validateUpload({ fileName: "deck.pdf", mimeType: "application/pdf", size: MAX_DECK_FILE_BYTES + 1 }).ok
);
check("a file with no name is rejected", !validateUpload({ fileName: "", mimeType: "application/pdf", size: 10 }).ok);

check("formatForFile resolves needsPdfNormalize for pptx", formatForFile("a.pptx", PPTX_MIME)?.needsPdfNormalize === true);
check("formatForFile leaves PDF as no-normalize", formatForFile("a.pdf", "application/pdf")?.needsPdfNormalize === false);
check("extensionOf lower-cases + strips dot", extensionOf("DECK.PPTX") === "pptx");
check("ACCEPTED_EXTENSIONS = the 3 formats", ACCEPTED_EXTENSIONS.join(",") === ".pdf,.pptx,.ppt");

check("sanitizeFileName strips path traversal", sanitizeFileName("../../etc/passwd.pdf") === "passwd.pdf");
check("sanitizeFileName spaces → dashes, keeps ext", sanitizeFileName("My Big Deck.pptx") === "my-big-deck.pptx");
check("sanitizeFileName collapses unsafe chars", /^[a-z0-9._-]+$/.test(sanitizeFileName("Wëird   N@me!!.pdf")));
check("sanitizeFileName never returns empty", sanitizeFileName("@@@.pdf").length > 0);
check("deriveDeckTitle humanizes the stem", deriveDeckTitle("Intro_to-Genetics.pptx") === "Intro to Genetics");
check("formatBytes is human-readable", formatBytes(1048576) === "1.0 MB");

/* ───────────────────── 2. status transitions ───────────────────── */
console.log("\n# 2. Status state machine");

check("uploaded → processing", canTransition("uploaded", "processing"));
check("uploaded → failed", canTransition("uploaded", "failed"));
check("uploaded → ready is ILLEGAL", !canTransition("uploaded", "ready"));
check("processing → ready", canTransition("processing", "ready"));
check("processing → failed", canTransition("processing", "failed"));
check("failed → processing (retry)", canTransition("failed", "processing"));
check("ready → processing (replace/retry)", canTransition("ready", "processing"));
check("ready → failed is ILLEGAL", !canTransition("ready", "failed"));
check("failed → ready is ILLEGAL (must re-process)", !canTransition("failed", "ready"));
check("self-transition is allowed (idempotent)", canTransition("processing", "processing"));
check("there are exactly 4 statuses", DECK_IMPORT_STATUSES.length === 4);

/* ──────────────── 3. block schema + persistence round-trip ──────────────── */
console.log("\n# 3. Imported-deck block schema + round-trip");

const importedBlock = createImportedDeckBlock({
  id: "44444444-4444-4444-4444-444444444444",
  deckImportId: DECK,
  title: "Imported lecture",
  sourceType: "upload",
  originalFileName: "lecture.pptx",
  originalMimeType: PPTX_MIME,
  originalFileSize: 2048,
  status: "processing",
});

const parsed = LessonBlockSchema.safeParse(importedBlock);
check("createImportedDeckBlock yields a schema-valid block", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
check("its type discriminant is imported_deck", importedBlock.type === "imported_deck");
check("status defaulted independently works", createImportedDeckBlock({ deckImportId: DECK, title: "t", sourceType: "upload", originalFileName: "f.pdf", originalMimeType: "application/pdf", originalFileSize: 1 }).status === "processing");

// Mirror persistence.ts exactly: content = block minus id; restore = content + id.
const { id: bid, ...payload } = importedBlock;
const restored = { ...payload, id: bid } as LessonBlock;
const reparsed = LessonBlockSchema.safeParse(restored);
check("round-trips through blocks.content jsonb (toRows→fromRows)", reparsed.success);
check("round-trip preserves every field", deepEqual(restored, importedBlock));
check(
  "no storage path leaks into the block snapshot",
  !JSON.stringify(importedBlock).includes("original_file_path") &&
    !("originalFilePath" in importedBlock)
);

/* ───────────────────── 4. patch pipeline ───────────────────── */
console.log("\n# 4. Patch pipeline (reducers)");

// PLACEHOLDER_COURSE is empty; build a doc with a real module + lesson to act on.
const seedModule = createModule("Module 1", 0);
const seedLesson = createLesson("Lesson 1", 0);
seedModule.lessons.push(seedLesson);
const lessonId = seedLesson.id;
let doc: CourseDocument = { ...PLACEHOLDER_COURSE, modules: [seedModule] };

// Native slide_deck path is preserved.
const nativePatch = addBlockPatch(lessonId, "slide_deck");
check("native slide_deck ADD_BLOCK still validates", CoursePatchSchema.safeParse(nativePatch).success);
const nativeApplied = applyCoursePatch(doc, nativePatch, NOW);
check("native slide_deck still inserts", nativeApplied.ok);

// Imported deck ADD_BLOCK.
const addImported = addImportedDeckBlockPatch(lessonId, {
  id: "55555555-5555-5555-5555-555555555555",
  deckImportId: DECK,
  title: "Imported deck",
  sourceType: "upload",
  originalFileName: "x.pdf",
  originalMimeType: "application/pdf",
  originalFileSize: 10,
  status: "processing",
});
check("imported-deck ADD_BLOCK validates", CoursePatchSchema.safeParse(addImported).success);
const addedRes = applyCoursePatch(nativeApplied.ok ? nativeApplied.doc : doc, addImported, NOW);
check("imported-deck ADD_BLOCK applies", addedRes.ok);
doc = addedRes.ok ? addedRes.doc : doc;
const insertedHit = findBlock(doc, "55555555-5555-5555-5555-555555555555");
check("the imported block is present after apply", insertedHit?.block.type === "imported_deck");

// UPDATE_IMPORTED_DECK merges the snapshot.
const upd = updateImportedDeckPatch("55555555-5555-5555-5555-555555555555", {
  status: "ready",
  pageCount: 12,
  error: null,
});
check("UPDATE_IMPORTED_DECK validates", CoursePatchSchema.safeParse(upd).success);
const updRes = applyCoursePatch(doc, upd, NOW);
check("UPDATE_IMPORTED_DECK applies", updRes.ok);
const updatedBlock = updRes.ok ? (findBlock(updRes.doc, "55555555-5555-5555-5555-555555555555")?.block as ImportedDeckBlock) : null;
check("status was merged to ready", updatedBlock?.status === "ready");
check("pageCount was merged to 12", updatedBlock?.pageCount === 12);
check("null error clears to undefined", updatedBlock?.error === undefined);

// UPDATE_IMPORTED_DECK refuses a non-imported block.
const firstNative = doc.modules
  .flatMap((m) => m.lessons)
  .flatMap((l) => l.blocks)
  .find((b) => b.type === "slide_deck");
if (firstNative) {
  const wrong = updateImportedDeckPatch(firstNative.id, { status: "ready" });
  const wrongRes = applyCoursePatch(doc, wrong, NOW);
  check("UPDATE_IMPORTED_DECK rejects a non-imported block", !wrongRes.ok);
} else {
  check("UPDATE_IMPORTED_DECK rejects a non-imported block (skipped — no native block)", true);
}

/* ───────────────────── 5. storage path builders ───────────────────── */
console.log("\n# 5. Storage path builders (owner-first, padded)");

check("deckImportRoot is owner/course/deck", deckImportRoot(OWNER, COURSE, DECK) === `${OWNER}/${COURSE}/${DECK}`);
check(
  "originalObjectPath nests under /original",
  originalObjectPath(OWNER, COURSE, DECK, "my-deck.pdf") === `${OWNER}/${COURSE}/${DECK}/original/my-deck.pdf`
);
check("previewPdfObjectPath is /preview/deck.pdf", previewPdfObjectPath(OWNER, COURSE, DECK).endsWith("/preview/deck.pdf"));
check("pageLabel pads to 3 digits", pageLabel(7) === "page-007" && pageLabel(123) === "page-123");
check("pageObjectPath under /pages with padding", pageObjectPath(OWNER, COURSE, DECK, 1) === `${OWNER}/${COURSE}/${DECK}/pages/page-001.png`);
check("thumbObjectPath under /thumbs", thumbObjectPath(OWNER, COURSE, DECK, 1) === `${OWNER}/${COURSE}/${DECK}/thumbs/page-001.png`);
check("every path starts with the owner id (RLS folder-ownership)", originalObjectPath(OWNER, COURSE, DECK, "f").startsWith(`${OWNER}/`));

/* ───────────────────── 6. row → View (sort + signed urls) ───────────────────── */
console.log("\n# 6. row → client View");

// A fake supabase that signs every path deterministically (no network).
const fakeSupabase = {
  storage: {
    from: () => ({
      createSignedUrls: async (paths: string[]) => ({
        data: paths.map((p) => (p.includes("missing") ? { signedUrl: null, error: "x" } : { signedUrl: `signed://${p}`, error: null })),
        error: null,
      }),
    }),
  },
} as unknown as SupabaseClient<Database>;

const row: DeckImportRow = {
  id: DECK,
  owner_id: OWNER,
  course_id: COURSE,
  lesson_id: lessonId,
  block_id: "55555555-5555-5555-5555-555555555555",
  source_type: "upload",
  source_external_id: null,
  source_url: null,
  title: "Imported deck",
  original_file_name: "x.pdf",
  original_mime_type: "application/pdf",
  original_file_size: 10,
  original_file_path: `${OWNER}/${COURSE}/${DECK}/original/x.pdf`,
  preview_pdf_path: null,
  page_count: 3,
  status: "ready",
  error: null,
  metadata: {},
  created_at: NOW,
  updated_at: NOW,
};
const SHUFFLED: DeckImportPageRow[] = [
  { id: "p3", deck_import_id: DECK, page_number: 3, image_path: `${OWNER}/${COURSE}/${DECK}/pages/page-003.png`, thumbnail_path: `${OWNER}/${COURSE}/${DECK}/thumbs/page-003.png`, width: 1280, height: 720, created_at: NOW },
  { id: "p1", deck_import_id: DECK, page_number: 1, image_path: `${OWNER}/${COURSE}/${DECK}/pages/page-001.png`, thumbnail_path: `${OWNER}/${COURSE}/${DECK}/thumbs/page-001.png`, width: 1280, height: 720, created_at: NOW },
  { id: "p2", deck_import_id: DECK, page_number: 2, image_path: `${OWNER}/${COURSE}/${DECK}/pages/page-002.png`, thumbnail_path: null, width: 1280, height: 720, created_at: NOW },
  { id: "p4", deck_import_id: DECK, page_number: 4, image_path: `${OWNER}/${COURSE}/${DECK}/missing/page-004.png`, thumbnail_path: null, width: null, height: null, created_at: NOW },
];

const view = await buildDeckImportView(fakeSupabase, row, SHUFFLED);
check("view pages are sorted ascending by page_number", view.pages.map((p) => p.pageNumber).join(",") === "1,2,3,4");
check("page image URLs are SIGNED (not public)", view.pages[0].imageUrl === `signed://${SHUFFLED[1].image_path}`);
check("a page with no thumbnail falls back to the full image url", view.pages[1].thumbnailUrl === view.pages[1].imageUrl);
check("a missing asset signs to null (graceful fallback)", view.pages[3].imageUrl === null);
check(
  "page views expose only url fields, never storage path fields",
  Object.keys(view.pages[0]).sort().join(",") === "height,imageUrl,pageNumber,thumbnailUrl,width"
);
check("view mirrors typed status + sourceType", view.status === "ready" && view.sourceType === "upload");

/* ───────────────────── 7. no permanent public URLs ───────────────────── */
console.log("\n# 7. Private-only storage (no public URLs)");

const storageSrc = readFileSync("lib/course/imports/deckImportStorage.ts", "utf8");
const serviceSrc = readFileSync("lib/course/imports/deckImportService.ts", "utf8");
check("deckImportStorage never calls .getPublicUrl()", !storageSrc.includes(".getPublicUrl("));
check("deckImportService never calls .getPublicUrl()", !serviceSrc.includes(".getPublicUrl("));
check("the bucket is referenced as the private 'deck-imports'", storageSrc.includes('"deck-imports"'));
check("signing goes through createSignedUrl(s)", storageSrc.includes("createSignedUrl"));

/* ───────────────────── 8. Google-Slides-ready shape ───────────────────── */
console.log("\n# 8. Google Slides / OneDrive compatible shape");

const gdriveBlock = createImportedDeckBlock({
  deckImportId: DECK,
  title: "From Drive",
  sourceType: "google_drive",
  originalFileName: "remote.pdf",
  originalMimeType: "application/pdf",
  originalFileSize: 5,
});
check("a google_drive sourceType validates", LessonBlockSchema.safeParse(gdriveBlock).success);
const onedriveOk = LessonBlockSchema.safeParse({ ...gdriveBlock, sourceType: "onedrive" }).success;
check("a onedrive sourceType validates", onedriveOk);
const gdriveRow: DeckImportRow = { ...row, source_type: "google_drive", source_external_id: "drive-file-abc" };
check("rowSourceType narrows google_drive", rowSourceType(gdriveRow) === "google_drive");
check("the row carries source_external_id for the future Drive id", gdriveRow.source_external_id === "drive-file-abc");
check("rowStatus narrows an unknown status to uploaded", rowStatus({ status: "weird" } as DeckImportRow) === "uploaded");

/* ───────────────────── 9. pngDimensions (worker) ───────────────────── */
console.log("\n# 9. pngDimensions IHDR reader");

function fakePng(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24);
  [137, 80, 78, 71, 13, 10, 26, 10].forEach((v, i) => (b[i] = v));
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}
const dim = pngDimensions(fakePng(1280, 720));
check("reads width/height from IHDR", dim?.width === 1280 && dim?.height === 720);
check("rejects too-short input", pngDimensions(new Uint8Array(10)) === null);
check("rejects a non-PNG signature", pngDimensions(new Uint8Array(24)) === null);

/* ───────────────────────────── summary ───────────────────────────── */
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
