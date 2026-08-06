/**
 * Escalation dossier + clustering tunables (TUTOR-1 Wave 6 · P6.2).
 *
 * The ONE place the escalation-synthesis numeric knobs live. Every value is
 * env-overridable so a deployment can dial the clustering tightness without a
 * code change; each falls back to the documented default when unset or malformed.
 * Read these instead of literal numbers anywhere in the escalation pipeline.
 *
 * The `ratio()` helper is a LOCAL copy of the graph/config.ts idiom (no
 * cross-config coupling) so this module owns its own env parsing.
 */

/** Parse a finite float env value in [0,1], falling back otherwise. */
function ratio(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * The cosine-similarity threshold at/above which a newly-synthesized escalation
 * question JOINS the nearest OPEN cluster on the SAME concept node (rather than
 * seeding a new cluster). DEFAULT 0.83 — deliberately a touch looser than the
 * graph canonicalization threshold (0.85): two learners rarely phrase the same
 * confusion identically, so the cluster should tolerate more paraphrase than a
 * concept-title merge does, while staying tight enough that genuinely different
 * questions on one node stay separate. Env-overridable: TUTOR_ESCALATION_CLUSTER_THRESHOLD.
 */
export const TUTOR_ESCALATION_CLUSTER_THRESHOLD = ratio(
  "TUTOR_ESCALATION_CLUSTER_THRESHOLD",
  0.83
);
