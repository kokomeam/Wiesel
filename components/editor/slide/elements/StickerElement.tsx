"use client";

/**
 * Sticker renderer: a lucide glyph referenced BY ID from the shared registry
 * (`lib/course/slide/stickers.ts`), drawn single-color in the slide accent
 * inside a soft tinted circle — the canonical, on-brand treatment. The icon
 * GEOMETRY map lives here (the only place lucide meets a sticker id); the
 * structured layouts reuse `StickerGlyph` so the treatment is single-sourced.
 */

import { createElement } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowRightLeft,
  Banknote,
  BarChart3,
  BrainCircuit,
  Check,
  Coins,
  FileText,
  HelpCircle,
  Info,
  Lightbulb,
  MessagesSquare,
  Search,
  Settings,
  SignpostBig,
  Split,
  Target,
  TrendingUp,
  UserStar,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { DEFAULT_STICKER_ID, findSticker } from "@/lib/course/slide/stickers";
import { findTheme } from "@/lib/course/slide/themes";
import type { SlideElement } from "@/lib/course/types";

type StickerEl = Extract<SlideElement, { type: "sticker" }>;

/** id → lucide component. Every STICKER_IDS entry must appear here (verified
 *  by scripts/verify-stickers.ts). */
export const STICKER_ICONS: Record<string, LucideIcon> = {
  "arrow-right": ArrowRight,
  "arrow-left-right": ArrowLeftRight,
  "trending-up": TrendingUp,
  split: Split,
  exchange: ArrowRightLeft,
  users: Users,
  discuss: MessagesSquare,
  cash: Banknote,
  coins: Coins,
  check: Check,
  x: X,
  target: Target,
  lightbulb: Lightbulb,
  info: Info,
  "bar-chart": BarChart3,
  search: Search,
  brain: BrainCircuit,
  signpost: SignpostBig,
  "user-star": UserStar,
  gear: Settings,
  document: FileText,
};

export function stickerIcon(id: string): LucideIcon {
  return STICKER_ICONS[id] ?? STICKER_ICONS[DEFAULT_STICKER_ID] ?? HelpCircle;
}

function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Reusable glyph: fills its container, square circle centered. `circleColor`
 *  null = bare icon (no circle). Shared by the sticker element + structured
 *  layouts so the icon treatment never drifts. */
export function StickerGlyph({
  id,
  accent,
  circleColor,
  iconRatio = 0.56,
  strokeWidth = 1.75,
  className,
}: {
  id: string;
  accent: string;
  /** Circle fill; `undefined` → soft accent tint; `null` → no circle. */
  circleColor?: string | null;
  iconRatio?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const fill = circleColor === null ? undefined : (circleColor ?? withAlpha(accent, 0.12));
  // createElement (not <Icon/>) so the per-id lucide component isn't flagged as
  // a component "created during render".
  const icon = createElement(stickerIcon(id), {
    "aria-hidden": true,
    color: accent,
    strokeWidth,
    style: { width: `${iconRatio * 100}%`, height: `${iconRatio * 100}%` },
  });
  return (
    <div className={cn("flex h-full w-full items-center justify-center", className)}>
      <div
        className="grid place-items-center rounded-full"
        style={{ height: "100%", maxWidth: "100%", aspectRatio: "1 / 1", backgroundColor: fill }}
      >
        {icon}
      </div>
    </div>
  );
}

export function StickerElement({ el, themeId }: { el: StickerEl; themeId: string }) {
  const theme = findTheme(themeId);
  const accent = el.style.color ?? theme.accentColor;
  const sticker = findSticker(el.stickerId);
  // An explicit "transparent" background means "no circle"; any other set
  // color is the circle fill; unset → the default accent tint.
  const circleColor =
    el.style.backgroundColor === "transparent" ? null : el.style.backgroundColor;
  return (
    <div
      className="h-full w-full"
      style={{ opacity: el.style.opacity }}
      role="img"
      aria-label={sticker ? `${sticker.label} icon` : "icon"}
    >
      <StickerGlyph id={el.stickerId} accent={accent} circleColor={circleColor} />
    </div>
  );
}
