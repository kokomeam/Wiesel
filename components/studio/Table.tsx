/**
 * Shared studio TABLE shell (TUTOR-1 Wave 5, P5.3). Promoted from the private
 * `Table` in components/studio/analytics/ContentHealthTab.tsx so the tutor
 * Analytics tab reuses the exact CSS-containment scroll wrapper (the stacked
 * below-the-fold tables skip layout/paint until scrolled to).
 *
 * PERF (PERF-1 D2, A6 #23): CSS containment has no effect on <tr>, so each table's
 * scroll WRAPPER is the skippable unit. `estimateRows` sizes the `--cv-size`
 * placeholder (~45px/row + header) so off-screen tables are correctly reserved.
 *
 * Pure presentational component — no store, no client hooks. `Td` is exported as a
 * convenience cell with the shared padding/typography so call sites don't re-derive it.
 */

import type React from "react";
import { cn } from "@/lib/cn";

export function Table({
  head,
  estimateRows = 8,
  children,
}: {
  head: string[];
  estimateRows?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="cv-row overflow-x-auto"
      style={{ "--cv-size": `${40 + estimateRows * 45}px` } as React.CSSProperties}
    >
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={`${h}-${i}`}
                className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A table cell with the shared studio padding + muted body type. */
export function Td({ className, children }: { className?: string; children: React.ReactNode }) {
  return <td className={cn("px-5 py-3 text-sm text-stone-600", className)}>{children}</td>;
}
