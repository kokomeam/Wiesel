/**
 * Remotion root for the slide-short provider (FR-6). Duration/fps derive
 * from the input props via calculateMetadata — one composition, any span.
 */

import React from "react";
import { Composition } from "remotion";
import { SlideShortComposition } from "./SlideShortComposition";
import {
  SLIDE_SHORT_FPS,
  SLIDE_SHORT_H,
  SLIDE_SHORT_W,
  SlideShortSpecSchema,
} from "./spec";
import "./style.css";

const FALLBACK_MS = 20_000;

export function SlideShortRoot() {
  return (
    <Composition
      id="slide-short"
      component={SlideShortComposition}
      width={SLIDE_SHORT_W}
      height={SLIDE_SHORT_H}
      fps={SLIDE_SHORT_FPS}
      durationInFrames={Math.round((FALLBACK_MS / 1000) * SLIDE_SHORT_FPS)}
      defaultProps={{}}
      calculateMetadata={({ props }) => {
        const parsed = SlideShortSpecSchema.safeParse(props);
        const durationMs = parsed.success ? parsed.data.durationMs : FALLBACK_MS;
        return {
          durationInFrames: Math.max(1, Math.round((durationMs / 1000) * SLIDE_SHORT_FPS)),
          props,
        };
      }}
    />
  );
}
