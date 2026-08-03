import { cn } from "@/lib/cn";

type CardVariant = "default" | "elevated" | "interactive" | "tinted";
type CardTone = "brand" | "learn";

const ELEVATED_SHADOW =
  "shadow-[0_1px_2px_rgba(68,48,28,0.05),0_8px_24px_-12px_rgba(68,48,28,0.12)]";

export function Card({
  variant = "default",
  tone = "brand",
  className,
  children,
  ...props
}: {
  variant?: CardVariant;
  tone?: CardTone;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-card border border-stone-200/80 bg-white",
        variant === "default" && "shadow-card",
        variant === "elevated" && ELEVATED_SHADOW,
        variant === "interactive" &&
          cn(
            "shadow-card transition-all",
            "hover:-translate-y-0.5 hover:border-stone-300",
            "hover:shadow-[0_1px_2px_rgba(68,48,28,0.05),0_8px_24px_-12px_rgba(68,48,28,0.12)]",
            tone === "brand"
              ? "hover:ring-1 hover:ring-brand-200/60"
              : "hover:ring-1 hover:ring-learn-200/60"
          ),
        variant === "tinted" &&
          cn(
            "shadow-card bg-gradient-to-b from-white",
            tone === "brand" ? "to-brand-50/40" : "to-learn-50/40"
          ),
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
  as: Heading = "h3",
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** Heading level — pass "h2" when the card is a page-level section so the
   *  document outline never skips a level (axe heading-order). */
  as?: "h2" | "h3" | "h4";
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-stone-200/70 px-card-pad py-4",
        className
      )}
    >
      <div>
        <Heading className="text-sm font-semibold text-stone-900">{title}</Heading>
        {subtitle && <p className="mt-0.5 text-xs text-stone-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
