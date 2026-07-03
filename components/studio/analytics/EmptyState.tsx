import type { LucideIcon } from "lucide-react";

/** First-class empty state — a just-published course has ZERO data and every
 *  tab must still feel intentional, never like a broken chart. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-stone-300/80 bg-stone-50/50 px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-white text-stone-400 shadow-[0_1px_2px_rgba(68,48,28,0.05)] ring-1 ring-stone-200/80">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-semibold text-stone-700">{title}</p>
      <p className="max-w-sm text-sm leading-relaxed text-stone-500">{hint}</p>
      {action}
    </div>
  );
}
