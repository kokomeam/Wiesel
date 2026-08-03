/**
 * Few-shot exemplars for the moment-selection static prefix (PRD §8.1) —
 * 3 strong candidates (with rubric scores + rationale) and 3 rejected ones
 * (incoherent span · charisma-over-content · hook overclaim).
 *
 * These are FIXTURES IN THE REPO, not inline prose: they're injected into the
 * static prefix at module load, so they version with CLIP_PROMPT_VERSION —
 * any edit here is a prompt change and must beat the incumbent on the eval
 * harness (scripts/eval-clips.ts) before merging. Rendered text is byte-stable.
 */

export interface StrongExemplar {
  transcriptExcerpt: string;
  momentType: string;
  hookText: string;
  funnelStage: string;
  rubricLine: string;
  rationale: string;
}

export interface RejectedExemplar {
  transcriptExcerpt: string;
  reason: string;
  lesson: string;
}

export const STRONG_EXEMPLARS: StrongExemplar[] = [
  {
    transcriptExcerpt:
      "Everyone indexes the column they filter on. So why is this query still slow? Because the index you made is invisible to this WHERE clause — you wrapped the column in a function, and the planner can't use an index on lower(email) unless the index IS on lower(email). Watch: same query, expression index, four hundred milliseconds to two.",
    momentType: "misconception_buster",
    hookText: "Your database index is being ignored",
    funnelStage: "tofu",
    rubricLine:
      "hook_potential 5 · standalone 5 · specificity 5 · curiosity_gap 4 · pedagogical_value 5 · visual_interest 3 · brand_safety 5 (total 32)",
    rationale:
      "Names a belief the audience holds (indexing the filtered column always helps), overturns it, and shows the fix with a concrete before/after inside one span. No context debt: the span itself defines the problem and resolves it.",
  },
  {
    transcriptExcerpt:
      "Here's the two-minute version of what took me years: when you mix on wet paper, you don't control the paint — you control the water. Tilt the board eight degrees, load the brush half as much, and the bloom you've been fighting becomes the texture you wanted. Try it on scrap paper today.",
    momentType: "concrete_win",
    hookText: "Stop fighting watercolor blooms — steer them",
    funnelStage: "tofu",
    rubricLine:
      "hook_potential 4 · standalone 5 · specificity 5 · curiosity_gap 3 · pedagogical_value 5 · visual_interest 5 · brand_safety 5 (total 32)",
    rationale:
      "A do-X-get-Y-today technique with visible payoff and exact parameters (eight degrees, half load). Demo-friendly footage makes it visually strong on Reels/TikTok.",
  },
  {
    transcriptExcerpt:
      "In week two you'll build the greedy solution first — on purpose. It fails the third sample case, and THAT failure is the lesson: you'll see exactly which assumption breaks, and the dynamic-programming fix will feel obvious instead of memorized. That's how this course teaches every algorithm.",
    momentType: "before_after",
    hookText: "Inside week 2: we break greedy on purpose",
    funnelStage: "bofu",
    rubricLine:
      "hook_potential 4 · standalone 4 · specificity 4 · curiosity_gap 4 · pedagogical_value 4 · visual_interest 3 · brand_safety 5 (total 28)",
    rationale:
      "A course-preview moment that demonstrates the teaching METHOD, not just a fact — exactly what a BOFU viewer deciding to enroll needs. The span states its own premise and resolution.",
  },
];

export const REJECTED_EXEMPLARS: RejectedExemplar[] = [
  {
    transcriptExcerpt:
      "…and that's why it fails. So building on what we derived earlier, this second term dominates, which — as I said before — is the same trap as the cache example, so the fix follows directly.",
    reason: "incoherent span (context debt)",
    lesson:
      "Three unresolved references ('what we derived earlier', 'as I said before', 'the cache example') point outside the span. A viewer joining here learns nothing. REJECT — do not repair into incoherence; pick a span that states its own premise.",
  },
  {
    transcriptExcerpt:
      "Oh WOW okay this is my FAVORITE part, you guys are going to LOVE this, honestly I get chills every single time, are you ready? Okay. Okay okay okay. Here we go. This is SO good.",
    reason: "charisma-over-content",
    lesson:
      "High vocal energy, zero standalone insight — the payoff lies outside the span. Energy without insight scores 0 on pedagogical_value and is exactly what generic virality tools select. REJECT.",
  },
  {
    transcriptExcerpt:
      "One thing a lot of people get wrong with sourdough starters is feeding on a rigid clock instead of watching the rise-and-fall cycle. Watch the peak, not the clock.",
    reason: "hook overclaim",
    lesson:
      "Proposed hook 'The mistake 90% of bakers make' FAILS hook integrity: the transcript says 'a lot of people', never 90%. Every factual claim in a hook must be supported by the span verbatim. The honest hook 'Feed your starter at the peak, not the clock' passes.",
  },
];

/** Byte-stable rendering — part of the static prefix. */
export function renderExemplars(): string {
  const strong = STRONG_EXEMPLARS.map((e, i) =>
    [
      `STRONG EXAMPLE ${i + 1} (${e.momentType} · ${e.funnelStage}):`,
      `  transcript: "${e.transcriptExcerpt}"`,
      `  hook: "${e.hookText}"`,
      `  rubric: ${e.rubricLine}`,
      `  why it works: ${e.rationale}`,
    ].join("\n")
  );
  const rejected = REJECTED_EXEMPLARS.map((e, i) =>
    [
      `REJECTED EXAMPLE ${i + 1} (${e.reason}):`,
      `  transcript: "${e.transcriptExcerpt}"`,
      `  why rejected: ${e.lesson}`,
    ].join("\n")
  );
  return [...strong, ...rejected].join("\n\n");
}
