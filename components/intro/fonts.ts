/**
 * Display serif for the new introduction page's editorial identity.
 * Loaded only where used; exposed as a CSS variable so components can opt in
 * with `[font-family:var(--font-display)]`.
 */

import { Fraunces } from "next/font/google";

export const displayFont = Fraunces({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-display",
});
