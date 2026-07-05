/**
 * Copy quality rubric — the definition of "converts" (Amendment 2).
 *
 * Mechanically scores one generated email against the rubric: framework
 * adherence (by blueprint stage), subject/preview format, CTA discipline, body
 * length + readability + concreteness, mobile-first structure, and a spam-
 * exposure lint. EVERY finding here is ADVISORY — only the separate trust/
 * compliance findings in reviewCampaignCompliance ever block launch (fake
 * urgency, guaranteed outcomes, missing unsubscribe, consent, sender identity,
 * broken CTA URLs, missing merge-variable fallback+data).
 *
 * Pure functions over an EmailTouch-shaped input — no network, no model call,
 * so scoring is instant and deterministic (an LLM used for content is scored
 * by the SAME mechanical rubric a human-written email would be).
 */

import type { CopyFramework } from "./blueprints";
import type { EmailBody, EmailBlock, CourseMarketingContext } from "./types";

export interface QualityScore {
  /** 0–100, weighted average of the checks below. Advisory only. */
  score: number;
  failedCriteria: string[];
  passedCriteria: string[];
}

const SPAM_TRIGGER_WORDS = [
  "act now",
  "buy now",
  "click here",
  "guarantee",
  "guaranteed",
  "limited time",
  "risk free",
  "act immediately",
  "$$$",
  "100% free",
  "no obligation",
  "urgent",
  "winner",
];

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/** Heuristic syllable count (vowel-group approximation) — good enough for a
 *  Flesch-Kincaid grade-level ADVISORY signal, not a linguistics engine. */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g) ?? [];
  let n = groups.length;
  if (w.endsWith("e") && n > 1) n--;
  return Math.max(1, n);
}

/** Flesch-Kincaid Grade Level. Lower = easier. Rubric target: ≤ 8. */
function fleschKincaidGrade(text: string): number {
  const s = sentences(text);
  const w = words(text);
  if (s.length === 0 || w.length === 0) return 0;
  const syllables = w.reduce((acc, word) => acc + countSyllables(word), 0);
  return 0.39 * (w.length / s.length) + 11.8 * (syllables / w.length) - 15.59;
}

function bodyText(body: EmailBody): string {
  return body.blocks
    .filter((b): b is Extract<EmailBlock, { kind: "heading" | "paragraph" }> => b.kind === "heading" || b.kind === "paragraph")
    .map((b) => b.text)
    .concat(body.blocks.filter((b): b is Extract<EmailBlock, { kind: "bullets" }> => b.kind === "bullets").flatMap((b) => b.items))
    .join(" ");
}

function ctaCount(body: EmailBody): number {
  return body.blocks.filter((b) => b.kind === "button").length;
}

const FRAMEWORK_LABEL: Record<CopyFramework, string> = {
  PAS: "Problem–Agitate–Solve",
  claim_mechanism_proof: "claim → mechanism → proof",
  objection_reframe_evidence: "objection → reframe → evidence",
  offer_transformation_deadline: "offer → transformation → deadline → single CTA",
};

export interface ScoreInput {
  subject: string;
  previewText: string | null;
  body: EmailBody;
  framework: CopyFramework;
  /** Offer/final-CTA stages get the wider 350-word ceiling. */
  isOfferStage: boolean;
  course: Pick<CourseMarketingContext, "modules" | "outcomes">;
}

export function scoreEmailStep(input: ScoreInput): QualityScore {
  const failed: string[] = [];
  const passed: string[] = [];
  const weights: number[] = [];
  const hits: number[] = [];

  const check = (label: string, ok: boolean, weight = 1) => {
    weights.push(weight);
    hits.push(ok ? weight : 0);
    (ok ? passed : failed).push(label);
  };

  // Subject: sentence case, no emoji, ≤1 punctuation mark, concrete (non-empty).
  const subj = input.subject.trim();
  const hasEmoji = /\p{Extended_Pictographic}/u.test(subj);
  const isAllCaps = subj === subj.toUpperCase() && /[A-Z]/.test(subj);
  const punctCount = (subj.match(/[!?.]/g) ?? []).length;
  check("Subject: no emoji", !hasEmoji);
  check("Subject: not ALL CAPS", !isAllCaps);
  check("Subject: at most one punctuation mark", punctCount <= 1);
  check("Subject: concrete (not empty/generic)", subj.length >= 8);

  // Preview text: 40–90 chars, distinct from the subject.
  const preview = input.previewText?.trim() ?? "";
  check("Preview text present (not left to default)", preview.length > 0);
  if (preview.length > 0) {
    check("Preview text 40–90 characters", preview.length >= 40 && preview.length <= 90);
    check("Preview text extends the subject (doesn't repeat it)", preview.toLowerCase() !== subj.toLowerCase());
  }

  // CTA discipline.
  const ctas = ctaCount(input.body);
  check("Exactly one primary CTA", ctas === 1);
  const buttonLabels = input.body.blocks.filter((b): b is Extract<EmailBlock, { kind: "button" }> => b.kind === "button").map((b) => b.label.toLowerCase());
  check("CTA copy is verb-first, not \"click here\"", !buttonLabels.some((l) => l.includes("click here")));

  // Body length + readability + paragraph length.
  const text = bodyText(input.body);
  const wc = words(text).length;
  const maxWords = input.isOfferStage ? 350 : 250;
  check(`Body word count in range (120–${maxWords})`, wc >= 120 && wc <= maxWords);
  const grade = fleschKincaidGrade(text);
  check("Grade-8 readability or lower", grade <= 8.5);
  const paragraphs = input.body.blocks.filter((b): b is Extract<EmailBlock, { kind: "paragraph" }> => b.kind === "paragraph");
  const longParagraph = paragraphs.some((p) => words(p.text).length > 45);
  check("Paragraphs stay short (≤ ~3 lines)", !longParagraph);

  // Problem-before-product + at least one concrete course detail.
  const lower = text.toLowerCase();
  const moduleMentioned = input.course.modules.some((m) => m.title && lower.includes(m.title.toLowerCase()));
  const outcomeMentioned = input.course.outcomes.some((o) => o && lower.includes(o.toLowerCase().slice(0, 24)));
  check("Cites a concrete course detail (module/outcome), not generic copy", moduleMentioned || outcomeMentioned, 2);

  // Framework label — informational, always "passes" (there's no mechanical
  // check for narrative structure), but surfaced so the creator sees which
  // framework this stage was written against.
  passed.push(`Framework: ${FRAMEWORK_LABEL[input.framework]}`);

  // Spam-exposure lint (advisory — feeds the "spammy language" compliance
  // check with concrete criteria rather than blocking on its own).
  const spamHits = SPAM_TRIGGER_WORDS.filter((w) => lower.includes(w));
  check("No spam-trigger vocabulary", spamHits.length === 0, 1.5);
  check("Link count reasonable (≤ 3)", ctas <= 3);

  const total = weights.reduce((a, b) => a + b, 0);
  const earned = hits.reduce((a, b) => a + b, 0);
  const score = total > 0 ? Math.round((earned / total) * 100) : 100;

  return { score, failedCriteria: failed, passedCriteria: passed };
}
