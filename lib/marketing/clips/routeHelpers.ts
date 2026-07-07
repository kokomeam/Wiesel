/**
 * Typed error → HTTP mapping for the clips REST surface (PRD §14): 422
 * transcript-unavailable · 502-with-stage generation failure · 503 model
 * unavailable · 400 tool errors. Direct service throws keep their types;
 * gate-path throws arrive as MarketingToolError (message preserved) — the
 * same trade Phase 1 made for the single-seam invariant.
 */

import { NextResponse } from "next/server";
import { MarketingToolError } from "@/lib/marketing/tools";
import {
  ClipGenerationError,
  ClipModelUnavailableError,
  ClipTranscriptUnavailableError,
} from "./errors";

export function clipErrorResponse(err: unknown): NextResponse {
  if (err instanceof ClipTranscriptUnavailableError) {
    return NextResponse.json({ error: err.message, code: "transcript_unavailable" }, { status: 422 });
  }
  if (err instanceof ClipGenerationError) {
    return NextResponse.json(
      { error: err.message, code: "generation_failed", stage: err.stage },
      { status: 502 }
    );
  }
  if (err instanceof ClipModelUnavailableError) {
    return NextResponse.json({ error: err.message, code: "model_unavailable" }, { status: 503 });
  }
  if (err instanceof MarketingToolError) {
    return NextResponse.json({ error: err.message, code: "bad_request" }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  return NextResponse.json({ error: message, code: "internal" }, { status: 500 });
}
