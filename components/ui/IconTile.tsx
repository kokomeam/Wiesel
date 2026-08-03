import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The square icon chip used beside titles and rows — one component instead of
 * the three ad-hoc size/radius pairs the surface had grown.
 */
export function IconTile({
  icon: Icon,
  size = "md",
  tone = "brand",
  className,
}: {
  icon: LucideIcon;
  size?: "sm" | "md";
  tone?: "brand" | "neutral" | "gradient";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center",
        size === "md" ? "size-9 rounded-panel" : "size-8 rounded-control",
        tone === "brand" && "bg-brand-50 text-brand-600 ring-1 ring-brand-100",
        tone === "neutral" && "bg-stone-100 text-stone-600",
        tone === "gradient" && "brand-gradient text-white",
        className
      )}
    >
      <Icon className={size === "md" ? "size-4.5" : "size-4"} />
    </span>
  );
}
