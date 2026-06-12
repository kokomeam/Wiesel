import { cn } from "@/lib/cn";

/** Simple CSS bar chart for retention / distribution views. */
export function BarChart({
  data,
  labels,
  color = "bg-brand-500",
  className,
}: {
  data: number[];
  labels?: string[];
  color?: string;
  className?: string;
}) {
  const max = Math.max(...data);
  return (
    <div className={cn("flex h-full items-end gap-1.5", className)}>
      {data.map((v, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full flex-1 items-end">
            <div
              className={cn("w-full rounded-t-md transition-all", color)}
              style={{ height: `${(v / max) * 100}%` }}
              title={`${v}`}
            />
          </div>
          {labels && (
            <span className="text-[10px] text-stone-400">{labels[i]}</span>
          )}
        </div>
      ))}
    </div>
  );
}
