"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  HelpCircle,
  PanelLeftClose,
  PanelLeft,
  Plus,
} from "lucide-react";
import { mainNav, secondaryNav } from "@/lib/nav";
import { currentUser } from "@/lib/data";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { useUIStore } from "@/lib/editor/uiStore";
import type { NavItem } from "@/lib/nav";

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

export function Sidebar() {
  const collapsed = useUIStore((s) => s.collapsed.appSidebar);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const { credits } = currentUser;
  const creditPct = Math.round((credits.used / credits.total) * 100);

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
        className={cn("flex h-16 items-center gap-2.5", collapsed ? "justify-center px-0" : "px-5")}
      >
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-900 text-[17px] font-bold leading-none text-brand-400">
          *
        </div>
        {!collapsed && (
          <span className="text-[15px] font-semibold tracking-tight text-stone-900">
            CourseGen<span className="text-brand-500">*</span>
          </span>
        )}
      </Link>

      {/* New course CTA */}
      <div className={cn("pb-2", collapsed ? "px-2.5" : "px-3")}>
        <Link
          href="/studio"
          title={collapsed ? "New Course" : undefined}
          className={cn(
            "flex h-9 items-center justify-center gap-2 rounded-full brand-gradient text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-opacity hover:opacity-95"
          )}
        >
          <Plus className="size-4" />
          {!collapsed && "New Course"}
        </Link>
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

      {/* Credits widget */}
      {!collapsed && (
        <div className="px-3 pb-2">
          <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-stone-700">AI Credits</span>
              <span className="text-stone-400">{creditPct}%</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
              <div
                className="h-full rounded-full brand-gradient"
                style={{ width: `${creditPct}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-stone-400">
              {credits.used.toLocaleString()} / {credits.total.toLocaleString()} · resets{" "}
              {credits.resets}
            </p>
          </div>
        </div>
      )}

      {/* User + collapse toggle */}
      <div
        className={cn(
          "flex items-center border-t border-stone-100 py-3",
          collapsed ? "flex-col gap-2 px-0" : "gap-3 px-4"
        )}
      >
        <div
          className="grid size-9 shrink-0 place-items-center rounded-full bg-stone-900 text-xs font-semibold text-white"
          title={collapsed ? `${currentUser.name} · ${currentUser.plan}` : undefined}
        >
          {currentUser.initials}
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-stone-900">{currentUser.name}</p>
            <p className="truncate text-xs text-stone-400">
              {currentUser.plan} plan · {currentUser.role}
            </p>
          </div>
        )}
        {!collapsed && <HelpCircle className="size-4 shrink-0 text-stone-300" />}
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
