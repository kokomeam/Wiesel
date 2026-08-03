import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * A tokenized list row (nav rows, permission rows, feed shells): leading
 * slot · title/sub · trailing slot, min-height from the one row token.
 * Renders a Link when `href` is given, a button when `onClick` is, else a div.
 */
export function ListRow({
  leading,
  title,
  sub,
  trailing,
  href,
  onClick,
  className,
  "data-testid": testId,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  trailing?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
  "data-testid"?: string;
}) {
  const inner = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-stone-800">{title}</span>
        {sub ? <span className="block truncate text-meta text-stone-500">{sub}</span> : null}
      </span>
      {trailing}
    </>
  );
  const cls = cn(
    "flex min-h-row-h w-full items-center gap-3 rounded-panel px-3 py-1.5 text-left transition-colors",
    (href || onClick) && "hover:bg-stone-50",
    className
  );
  if (href) {
    return (
      <Link href={href} className={cn("group", cls)} data-testid={testId}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn("group", cls)} data-testid={testId}>
        {inner}
      </button>
    );
  }
  return (
    <div className={cls} data-testid={testId}>
      {inner}
    </div>
  );
}
