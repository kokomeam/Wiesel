import { cn } from "@/lib/cn";

type Tone = "brand" | "green" | "amber" | "sky" | "rose" | "slate";

const tones: Record<Tone, string> = {
  brand: "bg-brand-50 text-brand-700 ring-brand-100",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  sky: "bg-sky-50 text-sky-700 ring-sky-100",
  rose: "bg-rose-50 text-rose-700 ring-rose-100",
  slate: "bg-stone-100 text-stone-600 ring-stone-200",
};

export function Badge({
  children,
  tone = "slate",
  dot = false,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}

/** Maps a course/lesson status to a sensible badge tone. */
export function statusTone(status: string): Tone {
  switch (status) {
    case "Published":
      return "green";
    case "In Progress":
    case "Generating":
      return "brand";
    case "Draft":
      return "amber";
    case "Planned":
      return "slate";
    default:
      return "slate";
  }
}
