/**
 * Escalation PROMOTION draft — the Terra schema + PURE prompt builder (TUTOR-1 Wave 6
 * · P6.4). Kept out of promotion.ts (the DB service) so the pure verify suite can pin
 * the block-draft shape + the identity-free prompt with no key / DB.
 *
 * THE PRIVACY SPINE (binding): `buildPromotionBlockSpec` is PURE and takes only the
 * concept title + the ANONYMIZED recurring question + the instructor's approved answer.
 * No learner id, email, or name can reach the model — the pure suite asserts it.
 */

import { z } from "zod";

/* ────────────────────────────── schema ──────────────────────────────────── */

/** One drafted paragraph of the FAQ block. `kind` maps 1:1 to a LectureParagraph
 *  kind ('key_idea' for the restated question, 'paragraph' for the explanation,
 *  'aside' for a caveat). Bounded so the strict-JSON schema stays compact. */
export const PromotionParagraphSchema = z.object({
  kind: z.enum(["paragraph", "key_idea", "aside"]),
  text: z.string().min(1).max(1200),
});
export type PromotionParagraph = z.infer<typeof PromotionParagraphSchema>;

/** The Terra draft of the FAQ/clarification block. */
export const PromotionDraftSchema = z.object({
  title: z.string().min(1).max(160),
  paragraphs: z.array(PromotionParagraphSchema).min(1).max(3),
});
export type PromotionDraft = z.infer<typeof PromotionDraftSchema>;

/** The responseFormat name — the mock's `opts.structured` map key. */
export const PROMOTION_RESPONSE_NAME = "escalation_promotion";

/* ─────────────────────────── prompt builder (PURE) ──────────────────────── */

/**
 * Build the FAQ-draft prompt input. PURE. NO identity token appears — the only free
 * text is the concept title + the anonymized question + the instructor's approved
 * answer. (Asserted by the pure verify suite.)
 */
export function buildPromotionBlockSpec(args: {
  conceptTitle: string;
  question: string;
  approvedAnswer: string;
}): string {
  const parts: string[] = [];
  parts.push(`CONCEPT: ${args.conceptTitle.trim()}`);
  if (args.question.trim()) {
    parts.push(`RECURRING LEARNER QUESTION (anonymized):\n${args.question.trim()}`);
  }
  parts.push(
    `INSTRUCTOR'S APPROVED ANSWER (the authoritative content — ground the FAQ in it):\n${
      args.approvedAnswer.trim() || "(the instructor has not written an answer yet — clarify the concept plainly)"
    }`
  );
  return parts.join("\n\n");
}
