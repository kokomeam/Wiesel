"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeft, Plus } from "lucide-react";
import { mainNav, secondaryNav } from "@/lib/nav";
import { createNewCourse } from "@/app/(app)/studio/actions";
import { cn } from "@/lib/cn";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { useUIStore } from "@/lib/editor/uiStore";
import type { NavItem } from "@/lib/nav";
import { SignOutButton } from "./SignOutButton";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-lg text-sm font-medium transition-colors",
        collapsed ? "justify-center px-0 py-2" : "px-3 py-2",
        active
          ? "bg-brand-50 text-brand-700"
          : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      )}
    >
      <Icon
        className={cn(
          "size-[18px] shrink-0",
          active ? "text-brand-600" : "text-stone-400 group-hover:text-stone-600"
        )}
      />
      {!collapsed && item.label}
      {!collapsed && item.badge && (
        <span className="ml-auto rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
          {item.badge}
        </span>
      )}
    </Link>
  );
}

export function Sidebar({
  user,
}: {
  user: { name: string; email: string; initials: string };
}) {
  const collapsed = useUIStore((s) => s.collapsed.appSidebar);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const displayName = user.name;
  const initials = user.initials;
  const subtitle = user.email;

  return (
    <aside
      data-ai-component="app-sidebar"
      data-ai-state={collapsed ? "collapsed" : "expanded"}
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-stone-200 bg-white transition-[width] duration-200",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Brand */}
      <Link
        href="/"
        aria-label="WiseSel home"
        className={cn("flex h-16 items-center gap-2.5", collapsed ? "justify-center px-0" : "px-5")}
      >
        <WiseSelLogo variant="mark" className="h-8 w-auto shrink-0" />
        {!collapsed && <WiseSelLogo variant="wordmark" className="h-[18px] w-auto" />}
      </Link>

      {/* New course CTA — server action (avoids prefetch-on-hover creates) */}
      <div className={cn("pb-2", collapsed ? "px-2.5" : "px-3")}>
        <form action={createNewCourse}>
          <button
            type="submit"
            title={collapsed ? "New Course" : undefined}
            className={cn(
              "flex h-9 w-full items-center justify-center gap-2 rounded-full brand-gradient text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-opacity hover:opacity-95"
            )}
          >
            <Plus className="size-4" />
            {!collapsed && "New Course"}
          </button>
        </form>
      </div>

      {/* Primary nav */}
      <nav className={cn("flex-1 space-y-0.5 overflow-y-auto py-2", collapsed ? "px-2.5" : "px-3")}>
        {mainNav.map((item) => (
          <NavLink key={item.href} item={item} collapsed={collapsed} />
        ))}
        <div className="my-3 h-px bg-stone-100" />
        {secondaryNav.map((item) => (
          <NavLink key={item.href} item={item} collapsed={collapsed} />
        ))}
      </nav>

      {/* User + collapse toggle */}
      <div
        className={cn(
          "flex items-center border-t border-stone-100 py-3",
          collapsed ? "flex-col gap-2 px-0" : "gap-3 px-4"
        )}
      >
        <div
          className="grid size-9 shrink-0 place-items-center rounded-full bg-stone-900 text-xs font-semibold text-white"
          title={collapsed ? displayName : undefined}
        >
          {initials}
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-stone-900">{displayName}</p>
            <p className="truncate text-xs text-stone-400">{subtitle}</p>
          </div>
        )}
        <SignOutButton />
        <button
          type="button"
          {...toolAttrs({
            tool: "toggle-app-sidebar",
            action: "TOGGLE_PANEL",
            targetType: "panel",
            label: collapsed ? "Expand the app sidebar" : "Collapse the app sidebar to icons",
          })}
          onClick={() => togglePanel("appSidebar")}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600"
        >
          {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>
    </aside>
  );
}
