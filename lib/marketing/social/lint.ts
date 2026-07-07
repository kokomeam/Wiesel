/**
 * Deterministic safety lint (PRD §17.2) — code, not model, run AFTER the Zod
 * gate. A flagged post either gets one targeted repair instruction (inside the
 * single repair budget) or is DROPPED with a surfaced reason; clean posts in
 * the batch survive.
 *
 * Escape hatch: creator-supplied context whitelists its own claims — a rule
 * only fires when the offending excerpt does NOT appear (normalized) in the
 * source context. Rules are table-driven; each row has a matching test in
 * verify-social.ts.
 */

import { PLATFORM_LIMITS, type SocialPlatform } from "./constants";

export interface LintViolation {
  rule: string;
  /** Creator-facing reason ("it invented a student result"). */
  reason: string;
  /** The offending text, for the inline drop notice + the repair instruction. */
  excerpt: string;
}

export interface LintablePost {
  platform: SocialPlatform;
  body: string;
  cta: string | null;
  hashtags: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when the excerpt (normalized) appears in the creator-supplied source
 *  context — the creator's own claims are never flagged. */
function whitelisted(excerpt: string, sourceContext: string): boolean {
  if (!excerpt) return false;
  const src = normalize(sourceContext);
  return src.length > 0 && src.includes(normalize(excerpt));
}

interface PatternRule {
  rule: string;
  reason: string;
  pattern: RegExp;
  /** Whether the source-context whitelist applies (hashtag/caps rules are
   *  mechanical — nothing to whitelist). */
  whitelistable: boolean;
}

const PATTERN_RULES: PatternRule[] = [
  {
    rule: "earnings_claim",
    reason: "it makes an income/earnings claim",
    pattern:
      /(?:(?:made|makes?|making|earn(?:ed|s|ing)?|profit(?:ed|s)?)\s*\$\s*[\d,.]+|\$\s*[\d,.]+\s*(?:per|a|\/)\s*(?:day|week|month|year|hour))[^.!?\n]*/iu,
    whitelistable: true,
  },
  {
    rule: "student_result_claim",
    reason: "it invented a student result",
    pattern:
      /students?\s+(?:got|achieved|reached|scored|earned|passed|doubled|tripled|landed|won)\s+[^.!?\n]*\d[^.!?\n]*/iu,
    whitelistable: true,
  },
  {
    rule: "fake_scarcity",
    reason: "it manufactures urgency/scarcity not present in your context",
    pattern:
      /(?:only\s+\d+\s+(?:spots?|seats?|places?|copies|hours?|days?)\s+(?:left|remaining)|(?:enrollment|doors?|offer)\s+clos(?:es|ing)\s+(?:tonight|today|soon)|last\s+chance\s+to)[^.!?\n]*/iu,
    whitelistable: true,
  },
  {
    rule: "fabricated_testimonial",
    reason: "it quotes a testimonial that isn't in your context",
    pattern: /["“][^"”\n]{12,}["”]\s*[—–-]\s*[A-Z][\p{L}.]+/u,
    whitelistable: true,
  },
];

/** Uppercase-letter ratio over alphabetic chars; short strings are exempt. */
function allCapsRatioViolation(text: string): LintViolation | null {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 40) return null;
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  if (upper / letters.length <= 0.3) return null;
  return {
    rule: "all_caps_ratio",
    reason: "more than 30% of it is ALL CAPS",
    excerpt: text.slice(0, 80),
  };
}

/**
 * Lint free text (any platform surface) against the §17.2 pattern rules +
 * the ALL-CAPS ratio. This is the SHARED core — the social pipeline wraps it
 * with platform hashtag caps below, and the clips pipeline (Phase 1.5) runs
 * it over hooks/captions/CTAs (PRD 1.5 §7.4.4: "Phase 1 §17.2 rules apply").
 * One rule table, two features — never copied.
 */
export function lintFreeText(text: string, sourceContext: string): LintViolation[] {
  const violations: LintViolation[] = [];
  for (const rule of PATTERN_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const excerpt = match[0].trim();
    if (rule.whitelistable && whitelisted(excerpt, sourceContext)) continue;
    violations.push({ rule: rule.rule, reason: rule.reason, excerpt });
  }
  const caps = allCapsRatioViolation(text);
  if (caps) violations.push(caps);
  return violations;
}

/**
 * Lint one generated post against the creator-supplied source context.
 * Returns every violation (the pipeline drops the post if any survive the
 * repair pass).
 */
export function lintGeneratedPost(post: LintablePost, sourceContext: string): LintViolation[] {
  const text = [post.body, post.cta ?? ""].join("\n");
  const violations = lintFreeText(text, sourceContext);

  const limits = PLATFORM_LIMITS[post.platform];
  if (post.hashtags.length > limits.hashtagMax) {
    violations.push({
      rule: "hashtag_overflow",
      reason: `it stuffs ${post.hashtags.length} hashtags (${limits.label} max is ${limits.hashtagMax})`,
      excerpt: post.hashtags.join(" "),
    });
  }

  return violations;
}

/** One targeted repair instruction for a flagged post (fed to the single
 *  repair call — PRD §9.1 step 6). */
export function lintRepairInstruction(violations: LintViolation[]): string {
  const lines = violations.map((v) => `- ${v.reason}: remove or rewrite "${v.excerpt}"`);
  return [
    "The draft below violates WiseSel's safety rules. Rewrite it keeping the topic, tone, and platform format, but:",
    ...lines,
    "Never invent results, testimonials, numbers, or urgency that are not in the provided context.",
  ].join("\n");
}
