/**
 * Clip-specific deterministic lints (PRD 1.5 §7.4) — code, not model, run
 * BEFORE the model validation call (free checks first) and after it (bounds
 * of proposed adjustments). Two layers:
 *
 *   1. SAFETY (§7.4.4): the Phase 1 §17.2 rule table via the SHARED
 *      lintFreeText (one rule table, two features) over hook + caption + CTA,
 *      plus the engagement-bait rule (§8.6) — "comment YES if…" is banned
 *      outside the designed comment-keyword CTA (which is M-D's, code-built).
 *   2. HOOK-INTEGRITY HEURISTICS (§7.4.3, the deterministic half): every
 *      NUMERIC claim in a hook (90%, $500, "3 signs") must appear in the
 *      span's own transcript. The model half of hook integrity (unsupported
 *      qualitative claims) rides the ONE validation call.
 */

import { lintFreeText, type LintViolation } from "../social/lint";

export type { LintViolation } from "../social/lint";

/** Engagement-bait (§8.6) — banned in clip text surfaces. The legitimate
 *  comment-keyword CTA (M-D) is code-generated, single-word, and never
 *  phrased as "comment YES". */
const ENGAGEMENT_BAIT_RE =
  /comment\s+["“]?(?:yes|yas|me|this|below)["”]?\s*(?:if|to|for|and)/iu;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Numeric tokens that constitute factual claims: percentages, currency,
 * multipliers, and bare integers ≥ 2 (a "3 signs" listicle number is a claim;
 * "one thing" is rhetoric). Ordinals in time ("week 2") count — if the hook
 * says week 2, the span must be about week 2.
 */
export function numericClaims(text: string): string[] {
  const matches = text.match(/\$?\d+(?:[.,]\d+)?\s*(?:%|x)?/gu) ?? [];
  return matches
    .map((m) => m.trim())
    .filter((m) => {
      const n = Number(m.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(n)) return false;
      if (/[%$x]/.test(m)) return true;
      return n >= 2;
    });
}

/** Deterministic hook-integrity check: each numeric claim in the hook must
 *  appear (normalized) in the span transcript. */
export function lintHookNumbers(hook: string, spanTranscript: string): LintViolation[] {
  const span = normalize(spanTranscript);
  const violations: LintViolation[] = [];
  for (const claim of numericClaims(hook)) {
    // Match the number itself; "90%" is supported by "90 percent" too.
    const bare = claim.replace(/[^0-9.,]/g, "");
    if (span.includes(normalize(claim)) || (bare && span.includes(bare))) continue;
    violations.push({
      rule: "hook_number_unsupported",
      reason: `the hook claims "${claim}" but the clip's transcript never says it`,
      excerpt: hook.slice(0, 80),
    });
  }
  return violations;
}

/* ─────────────── slide-reference hook integrity (FR-4) ─────────────────── */

/** A hook that points the viewer at an on-screen visual ("this diagram…"). */
const SLIDE_REF_RE =
  /\b(?:this|that|the)\s+(?:one\s+)?(?:diagram|chart|graph|slide|table|figure)\b/iu;

export function hookCitesSlideVisual(hook: string): boolean {
  return SLIDE_REF_RE.test(hook);
}

/**
 * FR-4: a hook citing a diagram/slide must correspond to a slide actually
 * within the span's sync window. Only decidable when the lesson HAS
 * slide-sync data (`hasSlideWithinSpan` from routing.ts) — when sync data
 * exists and no slide falls inside the span, the hook promises a visual the
 * clip never shows. With NO sync data the claim is unverifiable (the visual
 * may be on camera or on an untracked screen) and this lint stays silent —
 * the model-side hook-integrity verdict still judges the substance.
 */
export function lintHookSlideRef(
  hook: string,
  ctx: { syncAvailable: boolean; slideWithinSpan: boolean }
): LintViolation[] {
  if (!ctx.syncAvailable || !hookCitesSlideVisual(hook)) return [];
  if (ctx.slideWithinSpan) return [];
  return [
    {
      rule: "hook_slide_ref_unsupported",
      reason: "the hook points at a slide/diagram but no slide is on screen during the clip's span",
      excerpt: hook.slice(0, 80),
    },
  ];
}

/** Safety lint over one candidate's text surfaces (hook + caption + CTA). */
export function lintClipTextSurfaces(
  surfaces: { hookText: string; captionDraft: string | null; endCardCta: string | null },
  sourceContext: string
): LintViolation[] {
  const text = [surfaces.hookText, surfaces.captionDraft ?? "", surfaces.endCardCta ?? ""].join("\n");
  const violations = lintFreeText(text, sourceContext);
  const bait = text.match(ENGAGEMENT_BAIT_RE);
  if (bait) {
    violations.push({
      rule: "engagement_bait",
      reason: "it uses an engagement-bait formula outside the designed comment-keyword CTA",
      excerpt: bait[0].trim(),
    });
  }
  return violations;
}
