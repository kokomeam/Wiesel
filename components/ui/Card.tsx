import { cn } from "@/lib/cn";

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-card border border-stone-200/80 bg-white shadow-card",
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
