/**
 * Resolves the TYPED design tokens (LandingTheme) into renderer-owned Tailwind
 * class strings. The class strings are LITERAL (not built dynamically) so
 * Tailwind v4's scanner keeps them. The agent only ever sets the typed tokens;
 * this file owns every actual style decision.
 */

import type {
  ButtonStyle,
  ColorTheme,
  Density,
  LandingTheme,
  TypePairing,
} from "@/lib/marketing/types";

export interface Design {
  heroBg: string;
  accentText: string;
  accentGrad: string;
  check: string;
  sectionPad: string;
  btnRadius: string;
  headingFont: string;
}

const COLOR: Record<ColorTheme, Pick<Design, "heroBg" | "accentText" | "accentGrad" | "check">> = {
  warm: { heroBg: "from-brand-50 via-[#fef3e2] to-canvas", accentText: "text-brand-700", accentGrad: "brand-gradient", check: "text-emerald-600" },
  cool: { heroBg: "from-sky-50 via-indigo-50 to-white", accentText: "text-indigo-700", accentGrad: "bg-gradient-to-br from-sky-500 to-indigo-600", check: "text-sky-600" },
  mono: { heroBg: "from-stone-100 via-stone-50 to-white", accentText: "text-stone-900", accentGrad: "bg-stone-900", check: "text-stone-700" },
  bold: { heroBg: "from-orange-100 via-rose-50 to-white", accentText: "text-rose-700", accentGrad: "bg-gradient-to-br from-rose-500 to-orange-500", check: "text-rose-600" },
};
const DENSITY: Record<Density, string> = { compact: "py-10", normal: "py-16", airy: "py-24" };
const BTN: Record<ButtonStyle, string> = { pill: "rounded-full", rounded: "rounded-lg", square: "rounded-none" };
const HEADING: Record<TypePairing, string> = {
  editorial: "[font-family:var(--font-display)] font-light",
  modern: "font-semibold tracking-tight",
  classic: "[font-family:var(--font-display)] font-normal",
};

export function resolveDesign(theme: LandingTheme | undefined): Design {
  const t = theme ?? {};
  return {
    ...COLOR[t.colorTheme ?? "warm"],
    sectionPad: DENSITY[t.density ?? "normal"],
    btnRadius: BTN[t.buttonStyle ?? "pill"],
    headingFont: HEADING[t.typePairing ?? "editorial"],
  };
}
