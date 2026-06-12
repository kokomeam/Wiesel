import Link from "next/link";
import { cn } from "@/lib/cn";

const base =
  "group inline-flex h-11 items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 active:translate-y-0 active:scale-[0.98]";

export function CtaPrimary({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        base,
        "bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm shadow-orange-600/25 hover:-translate-y-px hover:shadow-lg hover:shadow-orange-600/30",
        className
      )}
    >
      {children}
    </Link>
  );
}

export function CtaSecondary({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        base,
        "border border-stone-200 bg-white text-stone-700 hover:-translate-y-px hover:border-stone-300 hover:shadow-md",
        className
      )}
    >
      {children}
    </Link>
  );
}
