/**
 * Typed error taxonomy for the clips pipeline — routes map these onto HTTP
 * statuses (400 / 422 / 502-with-stage / 503), the tools map them onto
 * agent-teachable MarketingToolError messages, and the UI renders each kindly
 * with parameters retained for Retry (the Phase 1 error contract).
 */

/** The lesson has no usable transcript source: no ready video with captions
 *  AND no transcription provider configured. Routes → HTTP 422. */
export class ClipTranscriptUnavailableError extends Error {
  constructor(lessonId: string, reason: string) {
    super(
      `Lesson ${lessonId} has no transcript source: ${reason}. Record or upload a lesson video (captions generate automatically), or configure the render provider for transcription.`
    );
    this.name = "ClipTranscriptUnavailableError";
  }
}

export type ClipFailureStage = "transcript" | "model" | "zod" | "repair" | "validation" | "timeout";

/** Moment selection failed after the repair budget — NOTHING was persisted;
 *  the UI keeps the request parameters and offers Retry. */
export class ClipGenerationError extends Error {
  readonly stage: ClipFailureStage;
  constructor(stage: ClipFailureStage, message: string) {
    super(message);
    this.name = "ClipGenerationError";
    this.stage = stage;
  }
}

/** Moment selection is model-required (there is no deterministic fallback
 *  that could honestly rank teachable moments). Routes → HTTP 503. */
export class ClipModelUnavailableError extends Error {
  constructor() {
    super(
      "Finding clip moments needs the AI model — set OPENAI_API_KEY. (Transcript acquisition and the candidate queue keep working without it.)"
    );
    this.name = "ClipModelUnavailableError";
  }
}
