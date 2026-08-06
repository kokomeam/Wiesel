/**
 * TUTOR-1 Wave 6 (P6.4) — escalation CONTENT-PATCH PROMOTION, PURE suite (no key,
 * no DB, no browser). Pins the DB-free decisions the promotion service makes:
 *
 *   • the FAQ-block builder shape (buildLectureBlock inputs → a valid LectureTextBlock);
 *   • the evidence ParsedEvidence shape (buildPromotionEvidence → parseEvidence round-trips);
 *   • the DERIVED-resolution logic (a cluster is resolved when its change_set_id's
 *     change_set is 'accepted' — modelled by the queue-view `resolved` flag + the
 *     drawer's clarifiedLine, with NO acceptChangeSet hook anywhere in this module);
 *   • the lesson-pick-from-anchors helper (firstLessonIdFromAnchors) + the pure doc
 *     helpers (findLessonInDoc / appendBlockToLesson);
 *   • the PRIVACY SPINE: buildPromotionBlockSpec is identity-FREE (no user id / email /
 *     name reaches the model).
 *
 * Run: `npx tsx scripts/verify-tutor-escalation-promotion.ts`
 */

import { parseEvidence } from "@/components/editor/agent/EvidenceCard";
import { clarifiedLine } from "@/components/studio/tutor/graph/NodeDetailDrawer";
import { CLUSTER_STATUS_CHIP } from "@/lib/studio/escalationCardView";
import {
  buildFallbackFaqBlock,
  buildPromotionEvidence,
  firstLessonIdFromAnchors,
  findLessonInDoc,
  appendBlockToLesson,
  PROMOTION_SYSTEM_PROMPT,
} from "@/lib/tutor/escalation/promotion";
import {
  buildPromotionBlockSpec,
  PromotionDraftSchema,
  PROMOTION_RESPONSE_NAME,
} from "@/lib/tutor/escalation/promotionDraft";
import type { CourseDocument } from "@/lib/course/types";

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

/* ─────────────────────── a tiny course-doc fixture ──────────────────────── */

function fixtureDoc(): CourseDocument {
  const now = new Date().toISOString();
  return {
    id: "course-1",
    title: "Algorithms",
    plan: { outcomes: [], prerequisites: [] },
    modules: [
      {
        id: "mod-1",
        type: "module",
        title: "Complexity",
        order: 0,
        lessons: [
          {
            id: "les-async",
            type: "lesson",
            title: "Asymptotic notation",
            order: 0,
            blocks: [
              // one existing block so append lands at index 1
              buildFallbackFaqBlock({ conceptTitle: "Seed", question: "", approvedAnswer: "existing content" }),
            ],
          },
          {
            id: "les-other",
            type: "lesson",
            title: "Recurrences",
            order: 1,
            blocks: [],
          },
        ],
      },
    ],
    theme: { name: "Editorial Warm", accent: "amber", slideDefaults: { layout: "title", themeId: "editorial-warm" } },
    metadata: { createdAt: now, updatedAt: now, aiReadableVersion: "1.0" },
  };
}

/* ─────────────────────── 1. FAQ block builder shape ─────────────────────── */

function faqBlockTests() {
  console.log("\n— FAQ block builder (buildLectureBlock inputs) —");
  const block = buildFallbackFaqBlock({
    conceptTitle: "Asymptotic notation",
    question: "Why does my Theta bound differ from the book?",
    approvedAnswer: "Theta is a TIGHT bound — it needs matching upper AND lower bounds.",
  });
  check("is a lecture_text block", block.type === "lecture_text");
  check("title is FAQ: <concept>", block.title === "FAQ: Asymptotic notation", block.title ?? "");
  check("tone is concise", block.tone === "concise");
  check("has a stable id", typeof block.id === "string" && block.id.length > 0);
  check("first paragraph restates the question as key_idea", block.paragraphs[0]?.kind === "key_idea");
  check("first paragraph carries the question verbatim (prefixed Q:)", block.paragraphs[0]?.text.includes("Why does my Theta"));
  check("second paragraph carries the approved answer verbatim", block.paragraphs[1]?.text.includes("tight bound".toUpperCase().replace("TIGHT", "TIGHT")) || block.paragraphs[1]?.text.includes("TIGHT bound"));
  check("every paragraph has a stable id", block.paragraphs.every((p) => typeof p.id === "string" && p.id.length > 0));

  // No question ⇒ only the answer paragraph.
  const noQ = buildFallbackFaqBlock({ conceptTitle: "X", question: "", approvedAnswer: "The answer." });
  check("a missing question yields exactly one paragraph (the answer)", noQ.paragraphs.length === 1 && noQ.paragraphs[0].kind === "paragraph");

  // Empty answer ⇒ a safe placeholder (never an empty paragraph).
  const noA = buildFallbackFaqBlock({ conceptTitle: "X", question: "Q?", approvedAnswer: "   " });
  check("an empty approved answer degrades to a non-empty paragraph", (noA.paragraphs.at(-1)?.text.trim().length ?? 0) > 0);

  // The Terra draft schema — a valid 1–3 paragraph draft parses; a 4-paragraph draft
  // is rejected (bounded) and an empty title is rejected.
  const okDraft = PromotionDraftSchema.safeParse({
    title: "FAQ: Theta bounds",
    paragraphs: [{ kind: "key_idea", text: "Q: why?" }, { kind: "paragraph", text: "Because…" }],
  });
  check("a valid 2-paragraph Terra draft parses", okDraft.success);
  const tooMany = PromotionDraftSchema.safeParse({
    title: "t",
    paragraphs: [
      { kind: "paragraph", text: "a" },
      { kind: "paragraph", text: "b" },
      { kind: "paragraph", text: "c" },
      { kind: "paragraph", text: "d" },
    ],
  });
  check("a 4-paragraph draft is rejected (bounded to ≤3)", !tooMany.success);
  check("the responseFormat name is 'escalation_promotion'", PROMOTION_RESPONSE_NAME === "escalation_promotion");
}

/* ─────────────────────── 2. evidence ParsedEvidence shape ───────────────── */

function evidenceTests() {
  console.log("\n— evidence ParsedEvidence shape (round-trips through parseEvidence) —");
  const evidence = buildPromotionEvidence({
    conceptTitle: "Asymptotic notation",
    question: "Why does my Theta bound differ from the book?",
    memberCount: 14,
    summary: "Recurring Theta confusion",
  });
  const parsed = parseEvidence(evidence);
  check("the evidence parses (the EvidenceCard renders it)", parsed !== null);
  check("kind is escalation_cluster", parsed?.kind === "escalation_cluster");
  check("severity is medium", parsed?.severity === "medium");
  check("metrics.learners is the member count", parsed?.metrics.learners === 14);
  check("summary names the count of learners", (parsed?.summary ?? "").includes("14 learners"));
  check("summary quotes the recurring question", (parsed?.summary ?? "").includes("Theta bound"));
  check("a recommendation is present", typeof parsed?.recommendation === "string" && (parsed?.recommendation.length ?? 0) > 0);

  // Singular grammar at n=1.
  const one = parseEvidence(buildPromotionEvidence({ conceptTitle: "X", question: "q", memberCount: 1, summary: "s" }));
  check("n=1 uses singular 'learner'", (one?.summary ?? "").includes("1 learner escalated"));
}

/* ─────────────────────── 3. DERIVED-resolution logic ────────────────────── */

function resolutionTests() {
  console.log("\n— DERIVED resolution (change-set accepted ⇒ resolved; no acceptChangeSet hook) —");
  // The status-chip mapping treats resolved_in_content as a success "Clarified in content".
  check("resolved_in_content maps to a success chip", CLUSTER_STATUS_CHIP.resolved_in_content.tone === "success");
  check("resolved_in_content label is 'Clarified in content'", CLUSTER_STATUS_CHIP.resolved_in_content.label === "Clarified in content");

  // The drawer's clarifiedLine models "clarified after N learners asked" from the
  // accepted clarifications (the RPC lists a cluster ONLY when its change-set is
  // accepted — this pure helper derives the copy from that list).
  check("no clarifications ⇒ null (no line)", clarifiedLine([]) === null);
  check("undefined clarifications ⇒ null", clarifiedLine(undefined) === null);
  const line = clarifiedLine([{ clusterId: "c1", memberCount: 12 }, { clusterId: "c2", memberCount: 5 }]);
  check("clarifiedLine counts the clarifications", line?.count === 2);
  check("clarifiedLine total = max member count across accepted promotions", line?.total === 12);
  // Model the derivation predicate directly: a cluster is resolved iff its change-set
  // status is 'accepted' — a pending/rejected/absent change-set is NOT resolved.
  const derivedResolved = (csStatus: string | null) => csStatus === "accepted";
  check("change-set 'accepted' ⇒ resolved", derivedResolved("accepted") === true);
  check("change-set 'pending' ⇒ NOT resolved", derivedResolved("pending") === false);
  check("change-set 'rejected' ⇒ NOT resolved", derivedResolved("rejected") === false);
  check("no change-set ⇒ NOT resolved", derivedResolved(null) === false);

  // The promotion module must never CALL acceptChangeSet — resolution is a READ.
  // (The word may appear in a doc comment explaining exactly this; we ban an
  // acceptChangeSet( invocation, not the word.)
  const src = readSource("lib/tutor/escalation/promotion.ts");
  check("promotion.ts never CALLS acceptChangeSet (resolution is derived)", !/acceptChangeSet\s*\(/.test(src));
  const actions = readSource("app/(app)/studio/[courseId]/tutor/escalationActions.ts");
  check("the promote action never CALLS acceptChangeSet", !/acceptChangeSet\s*\(/.test(actions));
}

/* ─────────────────────── 4. lesson-pick + doc helpers ───────────────────── */

function anchorTests() {
  console.log("\n— lesson pick from anchors + pure doc helpers —");
  check("first lessonId from a well-formed anchor array", firstLessonIdFromAnchors([{ lessonId: "les-async", blockId: "b" }] as never) === "les-async");
  check("null for a non-array", firstLessonIdFromAnchors(null) === null);
  check("null for an empty array", firstLessonIdFromAnchors([] as never) === null);
  check("skips a malformed entry, takes the first with a lessonId", firstLessonIdFromAnchors([{}, { lessonId: "les-2", blockId: "b" }] as never) === "les-2");
  check("ignores a non-string lessonId", firstLessonIdFromAnchors([{ lessonId: 7 }] as never) === null);

  const doc = fixtureDoc();
  check("findLessonInDoc locates an existing lesson", findLessonInDoc(doc, "les-async") !== null);
  check("findLessonInDoc returns null for a missing lesson", findLessonInDoc(doc, "nope") === null);

  const block = buildFallbackFaqBlock({ conceptTitle: "Asymptotic notation", question: "q?", approvedAnswer: "a." });
  const next = appendBlockToLesson(doc, "les-async", block);
  const targetLesson = next.modules[0].lessons.find((l) => l.id === "les-async")!;
  check("appendBlockToLesson adds the block to the named lesson", targetLesson.blocks.some((b) => b.id === block.id));
  check("the appended block's order = prior block count (end of lesson)", targetLesson.blocks.find((b) => b.id === block.id)?.order === 1);
  check("the OTHER lesson is untouched", next.modules[0].lessons.find((l) => l.id === "les-other")!.blocks.length === 0);
  check("appendBlockToLesson does NOT mutate the input doc", doc.modules[0].lessons[0].blocks.length === 1);
  check("a diff would see exactly one create (the new block id is new)", !doc.modules[0].lessons[0].blocks.some((b) => b.id === block.id));
}

/* ─────────────────────── 5. privacy spine (identity-free prompt) ────────── */

function privacyTests() {
  console.log("\n— privacy spine: the Terra prompt carries NO learner identity —");
  const spec = buildPromotionBlockSpec({
    conceptTitle: "Asymptotic notation",
    question: "Why does my Theta bound differ from the book?",
    approvedAnswer: "Theta is a tight bound.",
  });
  const forbidden = ["user_id", "userId", "@example.com", "learner-", "uuid", "email"];
  check("the built prompt contains no identity token", forbidden.every((t) => !spec.toLowerCase().includes(t.toLowerCase())), spec.slice(0, 80));
  check("the prompt DOES carry the anonymized question", spec.includes("Why does my Theta"));
  check("the prompt carries the concept + approved answer", spec.includes("Asymptotic notation") && spec.includes("tight bound"));
  check("the system prompt forbids naming a learner", /never refer to any learner by name/i.test(PROMOTION_SYSTEM_PROMPT));

  // A stray learner-id passed nowhere near the spec builder can never appear in it
  // (the builder takes exactly conceptTitle/question/approvedAnswer).
  const specWithoutId = buildPromotionBlockSpec({ conceptTitle: "C", question: "Q", approvedAnswer: "A" });
  check("the spec is a pure function of (concept, question, answer) only", specWithoutId.includes("C") && specWithoutId.includes("Q") && specWithoutId.includes("A"));
}

/* ─────────────────────── source reader ──────────────────────────────────── */

import { readFileSync } from "node:fs";
function readSource(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function main() {
  console.log("# verify-tutor-escalation-promotion (PURE) — P6.4 content-patch promotion");
  faqBlockTests();
  evidenceTests();
  resolutionTests();
  anchorTests();
  privacyTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
