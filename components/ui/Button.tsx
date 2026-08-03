import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "learn";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "brand-gradient text-white hover:opacity-95 shadow-sm shadow-brand-600/25 hover:shadow-md hover:shadow-brand-600/25 hover:-translate-y-px active:scale-[0.98] focus-visible:ring-brand-500/40",
  secondary:
    "bg-stone-900 text-white hover:bg-stone-800 shadow-sm hover:shadow-md hover:-translate-y-px active:scale-[0.98] focus-visible:ring-stone-500/40",
  outline:
    "border border-stone-300/80 bg-white text-stone-700 hover:border-stone-400 hover:bg-stone-50 focus-visible:ring-brand-500/40",
  ghost:
    "text-stone-600 hover:bg-stone-900/[0.06] hover:text-stone-900 focus-visible:ring-brand-500/40",
  // Student-portal primary (see the --color-learn-* ramp in globals.css).
  learn:
    "learn-gradient text-white hover:opacity-95 shadow-sm shadow-learn-600/25 hover:shadow-md hover:shadow-learn-600/25 hover:-translate-y-px active:scale-[0.98] focus-visible:ring-learn-500/40",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3.5 text-xs gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  lg: "h-11 px-6 text-sm gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: {
  variant?: Variant;
  size?: Size;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-full font-medium transition-all focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
