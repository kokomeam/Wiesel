"use client";

/** Full-cover countdown number shown over the live preview just before capture. */

export function CountdownOverlay({ value }: { value: number }) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-stone-950/55 backdrop-blur-[1px]">
      <div
        key={value}
        className="grid size-28 animate-[ping_0.9s_ease-out] place-items-center rounded-full bg-white/10 text-6xl font-light tabular-nums text-white ring-2 ring-white/40"
        style={{ animationIterationCount: 1 }}
      >
        {value}
      </div>
    </div>
  );
}
