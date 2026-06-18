/**
 * Regression test for atomic Reject (Task 1).
 *
 * Reject replays the inverse of a change-set through the SAME patch pipeline the
 * server uses (`diffBlocks` records the snapshots, `revertChangeSet` replays
 * them). This drives a realistic agent turn — create + update + delete across
 * blocks, including a slide deck — then reverts and asserts the course is
 * **byte-for-byte** the pre-change state. Also proves the revert is
 * all-or-nothing: a malformed item aborts the whole thing with nothing applied.
 *
 * Pure — no Supabase, no key. Run: `npx tsx scripts/verify-reject-revert.ts`
 * (the DB status→rejected + highlight-clear transitions are exercised by the
 * live agent integration + browser suites.)
 */

import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import { createBlock, createLesson, createModule, createParagraph } from "@/lib/course/factories";
import { findStructuredLayout } from "@/lib/course/slide/structuredLayouts";
import { diffBlocks } from "@/lib/ai/changeSetDiff";
import { revertChangeSet, type RevertItem } from "@/lib/ai/changeSet";
import type { CourseDocument, LectureTextBlock, SlideDeckBlock } from "@/lib/course/types";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

const NOW = "2026-06-16T00:00:00.000Z";

/** A deterministic course: one lesson with a slide deck, a lecture, a quiz. */
function buildDoc(): CourseDocument {
  const deck = createBlock("slide_deck", 0);
  const lecture = createBlock("lecture_text", 1);
  const quiz = createBlock("quiz", 2);
  const lesson = createLesson("Lesson 1", 0);
  lesson.blocks = [deck, lecture, quiz];
  const mod = createModule("Module 1", 0);
  mod.lessons = [lesson];
  return {
    id: "course-1",
    title: "Reject test course",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: { id: "editorial-warm", name: "Editorial Warm", accentColor: "#ea580c" } as never,
    metadata: { createdAt: NOW, updatedAt: NOW, ownerId: "owner-1", aiReadableVersion: "1.0" },
  };
}

/** Apply patches in order; fail loudly if any reducer rejects. */
function applyAll(doc: CourseDocument, patches: CoursePatch[]): CourseDocument {
  let d = doc;
  for (const p of patches) {
    const res = applyCoursePatch(d, p, NOW);
    if (!res.ok) throw new Error(`setup patch failed: ${res.error}`);
    d = res.doc;
  }
  return d;
}

/** Map the recorded diff to the rows Reject reads from `change_set_items`. */
function toItems(doc: CourseDocument, next: CourseDocument): RevertItem[] {
  return diffBlocks(doc, next).map((c) => ({
    block_id: c.blockId,
    lesson_id: c.lessonId,
    op: c.op,
    before: c.before,
  }));
}

function main() {
  const base = buildDoc();
  const snapshot = JSON.stringify(base.modules);
  const lesson = base.modules[0].lessons[0];
  const [deck, lecture, quiz] = lesson.blocks;

  // ── A simulated agent turn: UPDATE the lecture, CREATE a new deck, DELETE the quiz.
  const editedLecture: LectureTextBlock = {
    ...(lecture as LectureTextBlock),
    paragraphs: [
      ...(lecture as LectureTextBlock).paragraphs,
      createParagraph("An extra paragraph the agent wrote.", "paragraph"),
    ],
  };
  const newDeck = createBlock("slide_deck", 99);
  const turn: CoursePatch[] = [
    { action: "SET_BLOCK_CONTENT", blockId: lecture.id, block: editedLecture },
    { action: "ADD_BLOCK", lessonId: lesson.id, block: newDeck },
    { action: "DELETE_BLOCK", lessonId: lesson.id, blockId: quiz.id },
  ];
  const afterTurn = applyAll(base, turn);

  // The turn really changed things (else the test proves nothing).
  const changes = diffBlocks(base, afterTurn);
  const ops = changes.map((c) => c.op).sort();
  check("agent turn produced create+delete+update", JSON.stringify(ops) === JSON.stringify(["create", "delete", "update"]), JSON.stringify(ops));
  check("deck (untouched) is NOT in the diff", !changes.some((c) => c.blockId === deck.id));
  check("course actually differs after the turn", JSON.stringify(afterTurn.modules) !== snapshot);

  // ── Reject → byte-for-byte restore.
  const items = toItems(base, afterTurn);
  const reverted = revertChangeSet(afterTurn, items, NOW);
  check("revert succeeded", reverted.ok, reverted.ok ? "" : reverted.error);
  if (reverted.ok) {
    check("course is byte-for-byte the pre-change state", JSON.stringify(reverted.doc.modules) === snapshot);
    const blocks = reverted.doc.modules[0].lessons[0].blocks;
    check("block count restored (3)", blocks.length === 3, `got ${blocks.length}`);
    check("orders restored 0,1,2", JSON.stringify(blocks.map((b) => b.order)) === "[0,1,2]");
    check("deleted quiz restored at its original position", blocks[2].id === quiz.id && blocks[2].type === "quiz");
    check("created deck removed", !blocks.some((b) => b.id === newDeck.id));
  }

  // ── Each op type reverts in isolation, too.
  for (const single of turn) {
    const one = applyAll(base, [single]);
    const r = revertChangeSet(one, toItems(base, one), NOW);
    const okByte = r.ok && JSON.stringify(r.doc.modules) === snapshot;
    check(`isolated ${single.action} reverts byte-for-byte`, okByte, r.ok ? "" : r.error);
  }

  // ── Atomicity: a malformed item aborts the WHOLE revert, applying nothing.
  const goodItems = toItems(base, afterTurn);
  const corrupted: RevertItem[] = goodItems.map((it) =>
    it.op === "update" ? { ...it, before: null } : it
  );
  const bad = revertChangeSet(afterTurn, corrupted, NOW);
  check("malformed item makes revert fail (no partial apply)", !bad.ok);
  check("abort error names the un-revertable block", !bad.ok && /before-snapshot/i.test(bad.error));

  // ── Idempotent end-state: re-adding an already-gone created block is a no-op,
  //    not a failure (revert tolerates the goal already being met).
  const createOnly = applyAll(base, [{ action: "ADD_BLOCK", lessonId: lesson.id, block: newDeck }]);
  const createItems = toItems(base, createOnly);
  // Delete the created block out-of-band, then revert: should still succeed.
  const goneRes = applyCoursePatch(createOnly, { action: "DELETE_BLOCK", lessonId: lesson.id, blockId: newDeck.id }, NOW);
  const gone = goneRes.ok ? goneRes.doc : createOnly;
  const r2 = revertChangeSet(gone, createItems, NOW);
  check("revert tolerates an already-removed created block", r2.ok && JSON.stringify(r2.doc.modules) === snapshot, r2.ok ? "" : r2.error);

  // ── A NEW structured slide reverts byte-for-byte too: set a section_break
  //    template on the deck's first slide (an UPDATE to that block), then revert.
  {
    const baseS = buildDoc();
    const snapS = JSON.stringify(baseS.modules);
    const deckS = baseS.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
    const editedDeck: SlideDeckBlock = structuredClone(deckS);
    editedDeck.slides[0].template = findStructuredLayout("section_break")!.seed();
    editedDeck.slides[0].layout = "section_break";
    const afterS = applyAll(baseS, [{ action: "SET_BLOCK_CONTENT", blockId: deckS.id, block: editedDeck }]);
    const changesS = diffBlocks(baseS, afterS);
    check("setting a structured template is a single UPDATE diff", changesS.length === 1 && changesS[0].op === "update", JSON.stringify(changesS.map((c) => c.op)));
    const revS = revertChangeSet(afterS, toItems(baseS, afterS), NOW);
    check("structured slide reverts byte-for-byte", revS.ok && JSON.stringify(revS.doc.modules) === snapS, revS.ok ? "" : revS.error);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
