/**
 * Brand tokens — the ONE shared brand-constant module (continuation
 * directive D-1). Both render paths consume it and NOTHING else defines a
 * brand value:
 *   - the in-house FFmpeg compositions (M-B: stacked_split / zoom /
 *     audiogram) — colors as 0xRRGGBB filter literals via `ffmpegColor`
 *   - the Remotion slide-short composition (M-F) — CSS values as-is
 *   - the Reap payload builder (M-C packaging) — watermark/handle text
 *     (Task 0 (c): Reap has NO brand-template API; WiseSel branding is
 *     applied on OUR side)
 *
 * Values MIRROR the product's single-sourced tokens: `app/globals.css`
 * `@theme` (the warm-orange ramp, paper canvas, stone ink) and
 * `public/brand/*` via `components/brand/WiseSelLogo.tsx`. If globals.css
 * changes, change THIS file in the same commit — verify-clips-render's
 * divergence check fails when a second brand-constant definition appears
 * under lib/marketing/** or the render compositions.
 *
 * Per-creator brand kits are [FWD]: `creatorBrandOverrides` threads through
 * ResolvedPackaging (M-C) and is ALWAYS undefined in MVP — the future
 * feature is a data change, not a refactor. Clips ship WiseSel-branded with
 * the creator handle as watermark text.
 */

export interface BrandTokens {
  colors: {
    /** brand-500 — the warm orange accent (globals.css --color-brand-500). */
    brand: string;
    /** brand-600 — the deeper accent for gradients. */
    brandDeep: string;
    /** Warm paper canvas (--color-canvas). */
    canvas: string;
    /** Warm hairline (--color-line). */
    line: string;
    /** Stone ink — dark surfaces / text on light (stone-900). */
    ink: string;
    /** Near-black backdrop for video caption/pad bands (stone-950). */
    backdrop: string;
  };
  fonts: {
    /** UI/body family stack (Geist Sans). */
    sans: string;
    /** Display serif (Fraunces) — headlines only. */
    display: string;
    /** Mono (Geist Mono) — eyebrows/labels. */
    mono: string;
  };
  logo: {
    /** repo-relative asset paths (public/brand/*). */
    wordmarkPath: string;
    markPath: string;
    appIconPath: string;
  };
}

export const BRAND_TOKENS: BrandTokens = {
  colors: {
    brand: "#f97316",
    brandDeep: "#ea580c",
    canvas: "#faf7f1",
    line: "#ece7de",
    ink: "#1c1917",
    backdrop: "#0c0a09",
  },
  fonts: {
    sans: "Geist Sans, system-ui, sans-serif",
    display: "Fraunces, Georgia, serif",
    mono: "Geist Mono, ui-monospace, monospace",
  },
  logo: {
    wordmarkPath: "public/brand/wisesel-wordmark.png",
    markPath: "public/brand/wisesel-mark.png",
    appIconPath: "public/brand/wisesel-app-icon.png",
  },
};

/** [FWD] per-creator brand kit — ALWAYS undefined in MVP; threaded through
 *  ResolvedPackaging so the future feature is a data change. */
export type CreatorBrandOverrides = Partial<BrandTokens>;

/** Merge creator overrides over the product tokens (deep, per group). */
export function resolveBrandTokens(overrides?: CreatorBrandOverrides): BrandTokens {
  if (!overrides) return BRAND_TOKENS;
  return {
    colors: { ...BRAND_TOKENS.colors, ...overrides.colors },
    fonts: { ...BRAND_TOKENS.fonts, ...overrides.fonts },
    logo: { ...BRAND_TOKENS.logo, ...overrides.logo },
  };
}

/** `#rrggbb` → the `0xRRGGBB` literal FFmpeg filter args expect. */
export function ffmpegColor(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`brand color must be #rrggbb, got "${hex}"`);
  return `0x${m[1]}`;
}

/** The watermark line rendered on clips (MVP: WiseSel brand + creator handle). */
export function watermarkText(creatorHandle: string | null): string {
  const handle = creatorHandle?.trim();
  return handle ? `${handle} · WiseSel` : "WiseSel";
}
