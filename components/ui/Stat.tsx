import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card } from "./Card";
import { cn } from "@/lib/cn";

export function Stat({
  label,
  value,
  delta,
  trend,
  sub,
}: {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down";
  sub?: string;
}) {
  const up = trend === "up";
  return (
    <Card className="p-5">
      <p className="text-sm font-medium text-stone-500">{label}</p>
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
