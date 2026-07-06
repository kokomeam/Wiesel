import Image from "next/image";
import { cn } from "@/lib/cn";

/**
 * WiseSelLogo — the single source of truth for placing the WiseSel brand.
 *
 * Two real assets live under /public/brand:
 *   - wisesel-wordmark.png  → the "WiseSel" serif wordmark (navy + orange)
 *   - wisesel-mark.png      → the otter-in-circle icon-only mark
 *   - wisesel-app-icon.png  → the square app-icon (same artwork as the mark)
 *
 * Variants:
 *   - "horizontal" → mark + wordmark lockup (landing/educators navbars, big moments)
 *   - "wordmark"   → text-only wordmark (footers, inline brand)
 *   - "mark"       → icon-only otter (compact UI, collapsed sidebar, loading states)
 *   - "appIcon"    → square otter for app-icon / empty-state / auth contexts
 *
 * Sizing is height-driven: pass `h-*` via className and width auto-fits
 * (`w-auto object-contain`) so the artwork never stretches. Intrinsic
 * width/height are passed to next/image purely to reserve aspect ratio.
 */

type LogoVariant = "horizontal" | "wordmark" | "mark" | "appIcon";

const ASSETS = {
  wordmark: { src: "/brand/wisesel-wordmark.png", width: 699, height: 194 },
  mark: { src: "/brand/wisesel-mark.png", width: 317, height: 288 },
  appIcon: { src: "/brand/wisesel-app-icon.png", width: 317, height: 288 },
} as const;

export function WiseSelLogo({
  variant = "horizontal",
  className,
  priority = false,
}: {
  variant?: LogoVariant;
  /** Sets the rendered HEIGHT (e.g. `h-8 w-auto`). For `horizontal`, sizes the wrapper row. */
  className?: string;
  priority?: boolean;
}) {
  if (variant === "horizontal") {
    return (
      <span className={cn("inline-flex items-center gap-2.5", className)}>
        <Image
          src={ASSETS.mark.src}
          alt=""
          width={ASSETS.mark.width}
          height={ASSETS.mark.height}
          priority={priority}
          className="h-8 w-auto object-contain"
        />
        <Image
          src={ASSETS.wordmark.src}
          alt="WiseSel"
          width={ASSETS.wordmark.width}
          height={ASSETS.wordmark.height}
          priority={priority}
          className="h-[22px] w-auto object-contain"
        />
      </span>
    );
  }

  const asset = ASSETS[variant];
  const fallbackSize =
    variant === "wordmark" ? "h-6 w-auto" : "h-8 w-auto";

  return (
    <Image
      src={asset.src}
      alt="WiseSel"
      width={asset.width}
      height={asset.height}
      priority={priority}
      className={cn("object-contain", className ?? fallbackSize)}
    />
  );
}

export default WiseSelLogo;
