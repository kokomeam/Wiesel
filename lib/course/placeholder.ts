/**
 * Deterministic empty course used as the store's INITIAL state.
 *
 * The studio always hydrates the real (loaded) course on mount, so this is
 * never shown to the user — but a fixed id + fixed timestamps keep the very
 * first server/client render identical (no hydration mismatch) and give any
 * non-studio consumer of the store a valid, empty document.
 */

import { defaultCourseTheme } from "./persistence";
import type { CourseDocument } from "./types";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

export const PLACEHOLDER_COURSE: CourseDocument = {
  id: "00000000-0000-0000-0000-000000000000",
  title: "Untitled course",
  plan: { outcomes: [], prerequisites: [] },
  modules: [],
  theme: defaultCourseTheme(),
  metadata: {
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    aiReadableVersion: "1.0",
  },
};
