/**
 * Merge-variable catalog — the ONLY variables allowed in MVP copy (Amendment
 * 3b). Every variable declares a fallback, or is REQUIRED (no fallback means a
 * missing value for any eligible lead blocks launch — see the compliance check
 * in tools/compliance.ts). Rendering happens at SEND TIME in the scheduler, so
 * mock and Resend see byte-identical rendered bodies.
 *
 * Syntax: `{{var}}` (required, or default if the catalog declares one) or
 * `{{var|"fallback"}}` (explicit per-use fallback, wins over the catalog
 * default). Unknown `{{var}}` tokens are left untouched (fails Zod at the tool
 * boundary before they'd ever reach here in practice).
 */

export const MERGE_VARS = [
  "firstName",
  "courseName",
  "creatorName",
  "freeLessonUrl",
  "ctaUrl",
  "offerDeadline",
] as const;

export type MergeVar = (typeof MERGE_VARS)[number];

/** Catalog-level fallbacks. A var absent here has NO fallback — every eligible
 *  lead must resolve a real value or the campaign is blocked at compliance
 *  review (Amendment 3b's "data-hygiene check"). */
export const MERGE_VAR_FALLBACKS: Partial<Record<MergeVar, string>> = {
  firstName: "there",
};

const TOKEN_RE = /\{\{\s*(\w+)\s*(?:\|\s*"([^"]*)")?\s*\}\}/g;

export interface MergeVarContext {
  firstName?: string | null;
  courseName?: string | null;
  creatorName?: string | null;
  freeLessonUrl?: string | null;
  ctaUrl?: string | null;
  offerDeadline?: string | null;
}

/** Render every `{{var}}` / `{{var|"fallback"}}` token in `text` against
 *  `ctx`. Resolution order: real value → per-use fallback → catalog fallback →
 *  the literal token (should never happen post-compliance-gate, but rendering
 *  must never throw on a live send). */
export function renderMergeVars(text: string, ctx: MergeVarContext): string {
  return text.replace(TOKEN_RE, (whole, name: string, inlineFallback?: string) => {
    const value = (ctx as Record<string, string | null | undefined>)[name];
    if (value) return value;
    if (inlineFallback !== undefined) return inlineFallback;
    const catalogFallback = MERGE_VAR_FALLBACKS[name as MergeVar];
    if (catalogFallback !== undefined) return catalogFallback;
    return whole;
  });
}

export interface MissingFallbackFinding {
  varName: string;
  /** True when at least one eligible lead is missing the field AND there is no
   *  fallback anywhere (catalog or inline) — this is the BLOCKING condition. */
  blocking: boolean;
}

/** Scan a set of touch bodies (already flattened to text) for `{{var}}` tokens
 *  with no fallback, then check whether ANY eligible lead is missing that
 *  field. Used by the compliance gate (Amendment 3b: "merge variable with no
 *  fallback and missing data for ≥ 1 eligible lead" blocks launch). */
export function findMissingFallbacks(
  texts: string[],
  eligibleLeads: MergeVarContext[]
): MissingFallbackFinding[] {
  const varsUsedWithoutFallback = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(TOKEN_RE)) {
      const [, name, inlineFallback] = m;
      if (inlineFallback !== undefined) continue;
      if (MERGE_VAR_FALLBACKS[name as MergeVar] !== undefined) continue;
      varsUsedWithoutFallback.add(name);
    }
  }
  const findings: MissingFallbackFinding[] = [];
  for (const name of varsUsedWithoutFallback) {
    const missingForSomeone = eligibleLeads.some((lead) => !(lead as Record<string, string | null | undefined>)[name]);
    findings.push({ varName: name, blocking: missingForSomeone });
  }
  return findings;
}
