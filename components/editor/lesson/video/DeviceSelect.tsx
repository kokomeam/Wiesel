"use client";

/** A labeled device dropdown (camera / microphone). Falls back to a friendly
 *  "Camera 1" label when the browser withholds device labels (pre-permission). */

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function DeviceSelect({
  label,
  icon,
  value,
  devices,
  onChange,
  disabled,
  fallbackLabel,
}: {
  label: string;
  icon: ReactNode;
  value: string | null;
  devices: MediaDeviceInfo[];
  onChange: (deviceId: string) => void;
  disabled?: boolean;
  fallbackLabel: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
        {icon}
        {label}
      </span>
      <div className="relative">
        <select
          value={value ?? ""}
          disabled={disabled || devices.length === 0}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full appearance-none rounded-xl border border-stone-200 bg-white px-3 py-2 pr-8 text-sm text-stone-800 transition-colors hover:border-stone-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
            "disabled:cursor-not-allowed disabled:bg-stone-50 disabled:text-stone-400"
          )}
        >
          {devices.length === 0 && <option value="">No device found</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${fallbackLabel} ${i + 1}`}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
      </div>
    </label>
  );
}
