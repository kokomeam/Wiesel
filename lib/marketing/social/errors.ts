/**
 * Typed error taxonomy for the social pipeline — routes map these onto HTTP
 * statuses (409 / 429 / 502-with-stage), the tools map them onto
 * MarketingToolError messages, and the UI renders each kindly (PRD §6.3).
 */

/** A stale expectedVersion — the caller re-reads and re-applies (never
 *  force-writes). Routes → HTTP 409. */
export class SocialVersionConflictError extends Error {
  constructor(postId: string) {
    super(`social_post ${postId}: version conflict — the post changed since you read it`);
    this.name = "SocialVersionConflictError";
  }
}

/** A per-creator daily budget was exhausted. Routes → HTTP 429. */
export class SocialRateLimitError extends Error {
  readonly limit: number;
  readonly kind: "batches" | "revisions";
  constructor(kind: "batches" | "revisions", limit: number) {
    super(
      kind === "batches"
        ? `Daily batch budget reached (${limit}/day). It resets at midnight UTC.`
        : `Daily revision budget reached (${limit}/day). It resets at midnight UTC.`
    );
    this.name = "SocialRateLimitError";
    this.kind = kind;
    this.limit = limit;
  }
}

export type GenerationFailureStage = "model" | "zod" | "repair" | "lint" | "timeout";

/** Generation failed after the repair budget — NOTHING was persisted; the UI
 *  keeps the batch parameters and offers Retry. */
export class SocialGenerationError extends Error {
  readonly stage: GenerationFailureStage;
  constructor(stage: GenerationFailureStage, message: string) {
    super(message);
    this.name = "SocialGenerationError";
    this.stage = stage;
  }
}

/** A model-backed operation was requested with no model configured and no
 *  deterministic fallback exists for it (revise/retone/rewrite/regenerate). */
export class SocialModelUnavailableError extends Error {
  constructor(op: string) {
    super(
      `${op} needs the AI model — set OPENAI_API_KEY (batch generation, hashtags, and alt text keep working without it via deterministic fallbacks).`
    );
    this.name = "SocialModelUnavailableError";
  }
}
