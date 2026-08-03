import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import { Card } from "./Card";
import { cn } from "@/lib/cn";

type StatTone = "brand" | "learn" | "emerald" | "amber" | "rose";

// Tailwind can't interpolate class names — literal strings per tone.
const iconChip: Record<StatTone, string> = {
  brand: "bg-brand-50 text-brand-600",
  learn: "bg-learn-50 text-learn-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  rose: "bg-rose-50 text-rose-600",
};

export function Stat({
  label,
  value,
  delta,
  trend,
  sub,
  icon: Icon,
  tone = "brand",
}: {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down";
  sub?: string;
  icon?: LucideIcon;
  tone?: StatTone;
}) {
  const up = trend === "up";
  return (
    <Card className="p-5">
      {Icon ? (
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "grid size-9 place-items-center rounded-xl",
              iconChip[tone]
            )}
          >
            <Icon className="size-4.5" />
          </span>
          <p className="text-sm font-medium text-stone-500">{label}</p>
        </div>
      ) : (
        <p className="text-sm font-medium text-stone-500">{label}</p>
      )}
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="text-3xl font-semibold tracking-tight text-stone-900">
          {value}
        </span>
        {delta && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold",
              up ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
            )}
          >
            {up ? (
              <ArrowUpRight className="size-3" />
            ) : (
              <ArrowDownRight className="size-3" />
            )}
            {delta}
          </span>
        )}
      </div>
      {sub && <p className="mt-1 text-xs text-stone-400">{sub}</p>}
    </Card>
  );
}
