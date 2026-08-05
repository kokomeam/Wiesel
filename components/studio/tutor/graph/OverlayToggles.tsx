"use client";

/**
 * Overlay toggles (TUTOR-1 Wave 5, P5.2 · step 4). Two switches over the canvas:
 * the confusion heatmap and mastery shading. BOTH are cohort-floored upstream (the
 * RPC already suppressed below-floor nodes/blocks); a suppressed node renders
 * NEUTRAL regardless of the toggle (there is no number to reveal). These toggles
 * are pure view state — controlled by the parent GraphTabClient (no store, no
 * server round trip).
 *
 * Uses the shared Toggle primitive (components/ui/Toggle) — accessible role=switch.
 * No editor-store imports.
 */

import { Toggle } from "@/components/ui/Toggle";

export interface OverlayTogglesProps {
  showMastery: boolean;
  showConfusion: boolean;
  onToggleMastery: (next: boolean) => void;
  onToggleConfusion: (next: boolean) => void;
}

export function OverlayToggles({
  showMastery,
  showConfusion,
  onToggleMastery,
  onToggleConfusion,
}: OverlayTogglesProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-4 rounded-2xl border border-stone-200/80 bg-white px-4 py-2.5"
      role="group"
      aria-label="Graph overlays"
    >
      <ToggleRow
        id="tutor-overlay-mastery"
        label="Mastery shading"
        hint="Green → strong, amber/red → weaker (cohorts of 5+ only)"
        checked={showMastery}
        onChange={onToggleMastery}
      />
      <span className="h-4 w-px bg-stone-200" aria-hidden />
      <ToggleRow
        id="tutor-overlay-confusion"
        label="Confusion heatmap"
        hint="Rings concepts learners flag as confusing (cohorts of 5+ only)"
        checked={showConfusion}
        onChange={onToggleConfusion}
      />
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Toggle checked={checked} onChange={onChange} aria-labelledby={`${id}-label`} />
      <div className="leading-tight">
        <span id={`${id}-label`} className="block text-[13px] font-medium text-stone-800">
          {label}
        </span>
        <span className="block text-[11px] text-stone-500">{hint}</span>
      </div>
    </div>
  );
}
