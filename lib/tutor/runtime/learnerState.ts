/**
 * TUTOR-1 W3.3 — prompt layer L3: the COMPACT learner state.
 *
 * PURE formatting over inputs the caller gathered on the LEARNER-SCOPED
 * client (privacy-correct by construction — the learner can only read their
 * own mastery/queue; the route/loop never touches another learner's rows):
 * the titled review queue (my_review_queue), the learner's own mastery over
 * the current lesson's anchored concepts (below-threshold flagged), the
 * root-cause candidate (lib/tutor/mastery/queries.ts rootCause over the
 * learner's OWN rows + the course edges), and a recent-session synopsis.
 *
 * L3 is per-learner by nature — it sits AFTER the byte-stable L0/L1/L2
 * cache prefix in the prompt assembly, so its variability never breaks the
 * cache line (AC-T3.2's layer discipline).
 */

export interface LearnerStateInputs {
  /** my_review_queue top rows (titled), rank-ordered. */
  reviewQueue: Array<{ nodeId: string; title: string; rank: number }>;
  /** The learner's OWN mastery rows for the current lesson's anchored nodes. */
  masteryRows: Array<{ nodeId: string; title?: string | null; decayedP: number }>;
  /** Node ids anchored to the current lesson (scopes the mastery section). */
  lessonNodeIds: string[];
  /** rootCause() over the learner's own mastery + course edges — null when none. */
  rootCauseNodeId: string | null;
  /** Title lookup for the root-cause line (falls back to the id). */
  nodeTitleById?: Map<string, string>;
  /** One-line summaries of the most recent turns, oldest → newest (≤6 used). */
  recentSynopsis: string[];
}

/**
 * Assemble the L3 text. Deterministic (inputs are pre-sorted by the caller's
 * queries; this function re-sorts defensively), capped to `budgetChars`
 * (default 3_200 ≈ the 800-token L3 budget) with whole-line truncation.
 */
export function assembleLearnerState(
  inputs: LearnerStateInputs,
  cfg: { threshold: number; budgetChars?: number }
): string {
  const budget = cfg.budgetChars ?? 3_200;
  const lines: string[] = ["LEARNER STATE (private to this learner):"];

  const lessonSet = new Set(inputs.lessonNodeIds);
  const lessonMastery = inputs.masteryRows
    .filter((r) => lessonSet.has(r.nodeId))
    .sort((a, b) => a.decayedP - b.decayedP || a.nodeId.localeCompare(b.nodeId));
  if (lessonMastery.length > 0) {
    lines.push("This lesson's concepts (current mastery):");
    for (const r of lessonMastery.slice(0, 8)) {
      const pct = Math.round(r.decayedP * 100);
      const flag = r.decayedP < cfg.threshold ? " — BELOW MASTERY" : "";
      lines.push(`  • ${r.title ?? r.nodeId}: ${pct}%${flag}`);
    }
  } else {
    lines.push("No mastery signal yet for this lesson's concepts (treat as new).");
  }

  if (inputs.rootCauseNodeId) {
    const title =
      inputs.nodeTitleById?.get(inputs.rootCauseNodeId) ?? inputs.rootCauseNodeId;
    lines.push(
      `Likely upstream gap: "${title}" — the deepest below-mastery prerequisite of this lesson's concepts. Prefer checking it before drilling the surface question.`
    );
  }

  if (inputs.reviewQueue.length > 0) {
    lines.push("Their review queue (worst first):");
    for (const q of [...inputs.reviewQueue].sort((a, b) => a.rank - b.rank).slice(0, 5)) {
      lines.push(`  ${q.rank}. ${q.title}`);
    }
  }

  const synopsis = inputs.recentSynopsis.slice(-6);
  if (synopsis.length > 0) {
    lines.push("Recent session:");
    for (const s of synopsis) lines.push(`  – ${s}`);
  }

  // Whole-line truncation to the budget, keeping the header.
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) {
      out.push("…[learner state truncated]");
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}
