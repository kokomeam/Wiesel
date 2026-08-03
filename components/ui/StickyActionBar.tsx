import { cn } from "@/lib/cn";

/**
 * The pinned action bar at the bottom of a Drawer/sheet: a status note on the
 * left, actions on the right. Rendered via the Drawer's `footer` slot so it
 * never scrolls away from the form it commits.
 */
export function StickyActionBar({
  note,
  children,
  className,
  "data-testid": testId,
}: {
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex items-center gap-3 border-t border-stone-200/80 bg-white/95 px-card-pad py-3 backdrop-blur",
        className
      )}
    >
      <div className="min-w-0 flex-1 truncate text-meta text-stone-500">{note}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
