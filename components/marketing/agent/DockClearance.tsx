"use client";

/**
 * Reserved dock clearance (UI-1 W2.5): every marketing scroll surface gets
 * bottom padding matching the FAB's footprint, so no interactive element can
 * sit beneath it. Mirrors AgentDock's own hidden-surface logic — pages that
 * embed their own chat get no FAB and need no clearance.
 */

import { usePathname } from "next/navigation";

export function DockClearance({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hidden =
    pathname === "/marketing/agent" ||
    (/^\/marketing\/email\/[^/]+$/.test(pathname) && !pathname.endsWith("/new"));
  return <div className={hidden ? undefined : "pb-fab-clearance"}>{children}</div>;
}
