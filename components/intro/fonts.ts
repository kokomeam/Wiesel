/**
 * Display serif for the new introduction page's editorial identity.
 * Loaded only where used; exposed as a CSS variable so components can opt in
 * with `[font-family:var(--font-display)]`.
 */

import { Fraunces } from "next/font/google";

export const displayFont = Fraunces({
  subsets: ["latin"],
  // Normal only — no display-font call site uses italics (grep-verified: the
  // one <em> inside a --font-display heading is `not-italic`), and the italic
  // face preloaded ~29 KB on EVERY route (PERF-1 diagnosis A6 #29 / §A4).
  style: ["normal"],
  variable: "--font-display",
});
