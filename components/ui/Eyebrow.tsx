import { cn } from "@/lib/cn";

/**
 * The mono-uppercase micro label ("eyebrow") — previously re-typed dozens of
 * times as `font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500`.
 * Now 12px stone-500 (AA contrast on white) from the type-scale tokens.
 */
export function Eyebrow({
  children,
  className,
  as: Comp = "span",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "span" | "p" | "div" | "h2" | "h3" | "legend";
}) {
  return (
    <Comp className={cn("font-mono text-meta uppercase tracking-eyebrow text-stone-500", className)}>
      {children}
    </Comp>
  );
}
