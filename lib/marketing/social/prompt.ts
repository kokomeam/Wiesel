/**
 * Prompt assembly (PRD §9.1 step 3) — cache-friendly order:
 *   [static system: role + platform style guides + safety rules]  ← byte-stable
 *   [voice profile block] [source context block] [request block]  ← developer msg
 *
 * The static prefix is built ONCE at module load from PLATFORM_LIMITS and
 * never varies per request (verify-social.ts asserts byte-stability across
 * calls). Bump PROMPT_VERSION whenever the static prefix or the output
 * contract changes — it's recorded in ai_metadata on every batch and post, so
 * output quality can be compared across prompt revisions.
 */

import { PLATFORMS, PLATFORM_LIMITS, platformLimitsFor, type SocialPlatform, type SocialPostPlatform } from "./constants";
import type { BatchPlanSlot } from "./constants";
import type { SocialVoiceProfile } from "./schemas";

export const PROMPT_VERSION = "social-v1";

function styleGuideLines(): string[] {
  return PLATFORMS.flatMap((p) => {
    const l = PLATFORM_LIMITS[p];
    return [
      `${l.label.toUpperCase()} STYLE GUIDE:`,
      `- Register: ${l.register}.`,
      `- Length: ${l.targetWords[0]}-${l.targetWords[1]} words (hard cap ${l.charCap} characters).`,
      `- Structure: ${l.structure}.`,
      `- Hashtags: ${l.hashtagMin}-${l.hashtagMax}, relevant and specific, never stuffed.`,
      `- Emoji: ${l.emojiPolicy}.`,
    ];
  });
}

/** STATIC system prompt — the prompt-cache-eligible prefix. Never put
 *  course/voice/request content in here (the studio's caching lesson). */
export const SOCIAL_SYSTEM_PROMPT: string = [
  "You are the Social Post Writer for WiseSel, an AI co-pilot for course creators.",
  "You turn REAL course content into specific, useful, natural social posts the creator will publish MANUALLY on the platform themselves. WiseSel never posts, schedules, or connects to any social platform — never imply otherwise.",
  "",
  ...styleGuideLines(),
  "",
  "CONTENT RULES:",
  "- Use the actual course title, real module/lesson names, real outcomes from the provided context. NEVER invent course facts.",
  "- Specific, useful, natural, non-cringe. No \"🚀 Exciting news!!!\" openers unless tone=casual, and even then sparingly. No LinkedIn-broetry unless the voice profile shows the creator writes that way.",
  "- ABSOLUTE BANS: fake student results, fake testimonials, fake urgency or scarcity, fake credentials, fabricated enrollment numbers, fabricated reviews, income or result promises. Scarcity/urgency ONLY if present verbatim in the provided context.",
  "- No engagement-bait formulas (\"comment YES if…\") unless tone=casual AND the voice profile shows the creator uses them.",
  "- CTA is optional and goal-appropriate: tofu posts get a soft CTA or none (\"follow for more\"); bofu posts carry the direct ask.",
  "- Every post includes a suggestedImageIdea: ONE sentence describing a photo the creator can shoot or already owns (\"photo of your palette mid-lesson\"). Never suggest generating an image.",
  "- Write every post to sound like the CREATOR (the voice profile), not like an AI.",
  "",
  "OUTPUT: return JSON matching the provided schema exactly — one entry per requested slot, in slot order, each honoring its slot's goal, funnel stage, and tone.",
].join("\n");

/** Static system prompt for single-post revisions (retone, punch-up,
 *  platform rewrite, regenerate). Also byte-stable. */
export const SOCIAL_REVISION_SYSTEM_PROMPT: string = [
  "You are the Social Post Editor for WiseSel. You revise ONE existing social post per the creator's instruction.",
  "Keep what works; change only what the instruction requires. Never invent course facts, results, testimonials, or urgency — everything factual must come from the provided context or the existing post.",
  "The creator publishes manually — never imply WiseSel posts or schedules anything.",
  "",
  ...styleGuideLines(),
  "",
  "OUTPUT: return JSON matching the provided schema exactly.",
].join("\n");

export function voiceBlock(voice: SocialVoiceProfile): string {
  const lines = [
    "VOICE PROFILE (write in THIS voice):",
    `- Style: ${voice.summary}`,
    `- Register: ${voice.register} · sentences: ${voice.sentenceLength} · emoji tolerance: ${voice.emojiTolerance}`,
  ];
  if (voice.signatureMoves.length) lines.push(`- Signature moves: ${voice.signatureMoves.join("; ")}`);
  if (voice.bannedPhrases.length) lines.push(`- NEVER use these phrases: ${voice.bannedPhrases.join(", ")}`);
  for (const s of voice.sampleExcerpts) lines.push(`- Sample of the creator's own writing: "${s}"`);
  return lines.join("\n");
}

export interface GenerationRequestBlock {
  platform: SocialPlatform;
  slots: BatchPlanSlot[];
  tone: string;
}

/** The variable developer message for a batch generation call. */
export function buildGenerationInput(args: {
  voice: SocialVoiceProfile;
  sourceContext: string;
  request: GenerationRequestBlock;
}): string {
  const { voice, sourceContext, request } = args;
  const slotLines = request.slots.map(
    (s, i) =>
      `- slot ${i + 1}: goal=${s.goal} · funnelStage=${s.funnelStage} · tone=${request.tone}`
  );
  return [
    voiceBlock(voice),
    "",
    "SOURCE CONTEXT (the ONLY facts you may use):",
    sourceContext,
    "",
    `REQUEST: write ${request.slots.length} ${PLATFORM_LIMITS[request.platform].label} post(s), one per slot, in order:`,
    ...slotLines,
  ].join("\n");
}

/** The single repair call's input: the invalid JSON + the exact issues. */
export function buildRepairInput(args: {
  originalInput: string;
  invalidJson: string;
  issues: string[];
}): string {
  return [
    args.originalInput,
    "",
    "YOUR PREVIOUS RESPONSE WAS INVALID. Fix it and return corrected JSON matching the schema exactly.",
    "Previous response:",
    args.invalidJson.slice(0, 8000),
    "",
    "Problems to fix:",
    ...args.issues.map((i) => `- ${i}`),
  ].join("\n");
}

/** The variable developer message for a single-post revision call. */
export function buildRevisionInput(args: {
  voice: SocialVoiceProfile;
  sourceContext: string;
  post: { platform: SocialPostPlatform; body: string; cta: string | null; hashtags: string[]; tone: string };
  instruction: string;
  targetPlatform?: SocialPlatform;
}): string {
  const platform = args.targetPlatform ?? args.post.platform;
  return [
    voiceBlock(args.voice),
    "",
    "SOURCE CONTEXT (the ONLY facts you may use):",
    args.sourceContext,
    "",
    "EXISTING POST:",
    `platform: ${args.post.platform} · tone: ${args.post.tone}`,
    args.post.body,
    args.post.cta ? `CTA: ${args.post.cta}` : "CTA: (none)",
    `hashtags: ${args.post.hashtags.join(" ") || "(none)"}`,
    "",
    `INSTRUCTION: ${args.instruction}`,
    `Target platform: ${platformLimitsFor(platform).label} — follow its style guide.`,
  ].join("\n");
}
