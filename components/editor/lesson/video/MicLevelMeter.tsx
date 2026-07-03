"use client";

/** A compact segmented microphone level meter. `level` is 0..1 (live RMS from
 *  useVideoRecorder). Segments light green → amber → red as the level rises. */

import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/cn";

const SEGMENTS = 16;

export function MicLevelMeter({
  level,
  active = true,
  className,
}: {
  level: number;
  active?: boolean;
  className?: string;
}) {
  const lit = active ? Math.round(Math.min(1, Math.max(0, level)) * SEGMENTS) : 0;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-stone-100 text-stone-500">
        {active ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
      </span>
      <div className="flex h-3 flex-1 items-center gap-0.5" role="meter" aria-label="Microphone level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
        {Array.from({ length: SEGMENTS }).map((_, i) => {
          const on = i < lit;
          const tone =
            i < SEGMENTS * 0.7 ? "bg-emerald-500" : i < SEGMENTS * 0.9 ? "bg-amber-500" : "bg-rose-500";
          return (
            <span
              key={i}
              className={cn(
                "h-full flex-1 rounded-[1px] transition-colors",
                on ? tone : "bg-stone-200"
              )}
            />
          );
        })}
      </div>
    </div>
  );
}
