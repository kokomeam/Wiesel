/**
 * LLM-grounded sequence generation — closes the "Phase 1: LLM-backed
 * generation, deferred" gap that generators.ts's docblock had left open. Same
 * seam as everywhere else in the codebase: `ModelClient` is provider-agnostic
 * (lib/ai/modelClient.ts), the OpenAI SDK lives in exactly one file, and a
 * structured-output turn (json_schema) mirrors the studio's PLAN pattern
 * (lib/ai/outline.ts) — validate→repair via Zod, never a hard failure.
 *
 * The Copywriter is grounded in THREE sources: the auto-pulled course plan,
 * the optional Campaign Brief (Amendment 3a), and the creator's persistent
 * Voice Profile (Amendment 3c) + its accepted/rejected ledger signal. Content
 * is scored by the SAME mechanical rubric (quality.ts) whether it came from
 * the model or the deterministic fallback — the rubric doesn't grade on trust,
 * it grades the text.
 *
 * When no model is configured (or the call fails validation twice), this
 * degrades to the deterministic per-stage templates below — the whole engine
 * keeps working with zero external config, per the mock-first contract.
 */

import { z } from "zod";
import type { ModelClient } from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import type { BlueprintStage, CopyFramework } from "../blueprints";
import { localeLabel, resolveCopyLocale } from "../language";
import { EmailBodySchema } from "../schemas";
import type { CampaignBrief, CourseMarketingContext, EmailBody } from "../types";
import type { VoiceLedgerSignal } from "../tools/voice";

const GeneratedTouchSchema = z.object({
  stageKey: z.string().describe("Must match one of the provided blueprint stage keys, in order."),
  subject: z.string().min(1).max(120).describe("Sentence case, no emoji, no ALL CAPS, at most one punctuation mark, concrete."),
  previewText: z.string().min(1).max(160).describe("40-90 characters, extends the subject, never repeats it."),
  body: EmailBodySchema.describe("Exactly one button block (the single CTA); 120-250 words for drip steps, up to 350 for an offer/final step; short paragraphs; at least one concrete detail from the course (a real module name or outcome)."),
  personalizationVariables: z.array(z.string()).describe("Which of {{firstName}} {{courseName}} {{creatorName}} {{freeLessonUrl}} {{ctaUrl}} {{offerDeadline}} this step uses."),
  aiRationale: z.string().max(300).describe("One sentence: why this angle, for this stage's framework."),
});

const GeneratedSequenceSchema = z.object({ touches: z.array(GeneratedTouchSchema) });

const FRAMEWORK_INSTRUCTIONS: Record<CopyFramework, string> = {
  PAS: "Structure: Problem (name the reader's real problem) → Agitate (why it matters / costs them) → Solve (how this course solves it).",
  claim_mechanism_proof: "Structure: Claim (what they'll be able to do) → Mechanism (how the course gets them there) → Proof (a real, specific course detail as evidence).",
  objection_reframe_evidence: "Structure: Objection (name the real hesitation) → Reframe (why it's not the blocker they think) → Evidence (a concrete course detail that resolves it).",
  offer_transformation_deadline: "Structure: Offer (what's included) → Transformation (the outcome) → Deadline (truthful — only if a REAL deadline exists) → single clear CTA. NEVER invent urgency or scarcity.",
};

function buildSystemPrompt(): string {
  return [
    "You are the Email Copywriter for WiseSel, writing a course launch email sequence.",
    "You write ONLY from the course context and campaign brief you are given — never invent testimonials, stats, results, or a deadline that wasn't provided.",
    "RUBRIC (every step must satisfy this):",
    "- Subject: sentence case, no emoji, no ALL CAPS, at most one punctuation mark, concrete (never vague).",
    "- Preview text: 40-90 characters, extends the subject, never repeats it.",
    "- Exactly ONE button block (the single primary CTA) per email; the button label is a verb-first outcome (e.g. \"Get the free first lesson\"), never \"Click here\".",
    "- Body: 120-250 words for drip steps (350 max for an offer/final-CTA step); grade-8 readability or lower; short paragraphs (≤3 lines); the reader's problem appears before the product; include at least one concrete detail drawn from the ACTUAL course (a real module name or outcome) — generic copy that could describe any course fails the rubric.",
    "- Mobile-first: single column, meaning survives with images off (there are no images — text and one button only).",
    "- Never use fake urgency, guaranteed outcomes, or invented scarcity.",
    "Follow the VOICE PROFILE rules exactly — they are the creator's durable style preferences.",
  ].join("\n");
}

function buildContext(
  course: CourseMarketingContext,
  brief: CampaignBrief | undefined,
  voiceRules: string[],
  ledgerSignal: VoiceLedgerSignal | null,
  stages: BlueprintStage[],
  locale: string
): string {
  const lines = [
    `COURSE: "${course.title}" — ${course.description ?? "(no description)"}`,
    `Audience: ${course.audience ?? "not specified"} · Level: ${course.level ?? "not specified"}`,
    `Outcomes: ${course.outcomes.join("; ") || "not specified"}`,
    `Modules: ${course.modules.map((m) => m.title).join("; ") || "not specified"}`,
  ];
  if (brief) {
    lines.push("CAMPAIGN BRIEF (creator-supplied, use it):");
    if (brief.audienceNotes) lines.push(`- Audience notes: ${brief.audienceNotes}`);
    if (brief.proofPoints) lines.push(`- Proof / credibility: ${brief.proofPoints}`);
    if (brief.offerDetails) lines.push(`- Offer details: ${brief.offerDetails}`);
    if (brief.thingsToAvoid) lines.push(`- NEVER say: ${brief.thingsToAvoid}`);
    if (brief.offerDeadlineIso) lines.push(`- Real offer deadline: ${brief.offerDeadlineIso} (only mention this exact date — never invent urgency beyond it)`);
    if (brief.freeform) lines.push(`- Additional context: ${brief.freeform}`);
  }
  lines.push(`VOICE PROFILE (follow exactly): ${voiceRules.join(" | ")}`);
  lines.push(`LANGUAGE: write ALL copy (subjects, previews, bodies, button labels) in ${localeLabel(locale)}.`);
  if (ledgerSignal && (ledgerSignal.acceptedEdits > 0 || ledgerSignal.revertedEdits > 0)) {
    lines.push(
      `EDIT HISTORY SIGNAL: the creator has accepted ${ledgerSignal.acceptedEdits} prior edits and reverted ${ledgerSignal.revertedEdits}. Lean toward what was accepted; avoid patterns that were reverted.`
    );
  }
  lines.push("STAGES TO WRITE, IN ORDER:");
  for (const s of stages) {
    lines.push(`- stageKey="${s.key}" (${s.name}): ${FRAMEWORK_INSTRUCTIONS[s.framework]}`);
  }
  return lines.join("\n");
}

export interface LlmTouchDraft {
  stageKey: string;
  subject: string;
  previewText: string;
  body: EmailBody;
  personalizationVariables: string[];
  aiRationale: string;
}

/** Returns null on any failure (no model, bad response, validation failure
 *  after one repair attempt) — the caller falls back to deterministic
 *  templates. Never throws. */
export async function generateSequenceWithModel(
  model: ModelClient,
  args: {
    course: CourseMarketingContext;
    brief: CampaignBrief | undefined;
    voiceRules: string[];
    ledgerSignal: VoiceLedgerSignal | null;
    stages: BlueprintStage[];
  }
): Promise<LlmTouchDraft[] | null> {
  const system = buildSystemPrompt();
  const locale = resolveCopyLocale(args.course, args.brief);
  const context = buildContext(args.course, args.brief, args.voiceRules, args.ledgerSignal, args.stages, locale);
  const schema = toStrictJsonSchema(GeneratedSequenceSchema);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await model.runTurn(
        {
          system,
          input: [{ role: "developer", content: context }],
          tools: [],
          effort: "medium",
          responseFormat: { name: "email_sequence", schema },
        },
        () => {}
      );
      const parsed = GeneratedSequenceSchema.safeParse(JSON.parse(result.text));
      if (!parsed.success) continue;
      if (parsed.data.touches.length === 0) continue;
      return parsed.data.touches;
    } catch {
      continue;
    }
  }
  return null;
}
