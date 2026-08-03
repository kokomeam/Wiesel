"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wand2 } from "lucide-react";
import { IntentLink } from "@/components/perf/IntentLink";
import { learnerNav, type NavItem } from "@/lib/nav";
import { cn } from "@/lib/cn";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";
import { SignOutButton } from "./SignOutButton";

/**
 * Student-portal sidebar. Deliberately does NOT reuse the creator Sidebar:
 * that component drags in editor stores (uiStore), studio server actions and
 * data-ai tooling the learner bundle should never pay for. Learner accent =
 * the learn-* ramp (globals.css); brand orange stays reserved for primary
 * actions inside pages.
 */

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, compact = false }: { item: NavItem; compact?: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <IntentLink
      href={item.href}
      className={cn(
        "group flex items-center gap-3 rounded-lg text-sm font-medium transition-colors",
        compact ? "px-3 py-1.5" : "px-3 py-2",
        active
          ? "bg-learn-50 text-learn-800"
          : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      )}
    >
      <Icon
        className={cn(
          "size-[18px] shrink-0",
          active ? "text-learn-600" : "text-stone-400 group-hover:text-stone-600"
        )}
      />
      {item.label}
    </IntentLink>
  );
}

export function StudentSidebar({
  user,
}: {
  user: { name: string; email: string; initials: string };
}) {
  return (
    <>
      {/* Desktop rail */}
      <aside
        data-ai-component="student-sidebar"
        className="hidden h-full w-64 shrink-0 flex-col border-r border-stone-200 bg-white md:flex"
      >
        <Link
          href="/home"
          aria-label="WiseSel home"
          className="flex h-16 items-center gap-2.5 px-5"
        >
          <WiseSelLogo variant="mark" className="h-8 w-auto shrink-0" />
          <WiseSelLogo variant="wordmark" className="h-[18px] w-auto" />
        </Link>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
          {learnerNav.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </nav>

        {/* Portal switch — every account can teach; role only picks the default. */}
        <div className="px-3 pb-3">
          <IntentLink
            href="/dashboard"
            className="group flex items-start gap-2.5 rounded-xl border border-stone-200/80 bg-stone-50/60 px-3.5 py-3 transition-colors hover:border-brand-200 hover:bg-brand-50/50"
          >
            <Wand2 className="mt-0.5 size-4 shrink-0 text-stone-400 transition-colors group-hover:text-brand-600" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-stone-700 group-hover:text-brand-800">
                Switch to creator studio
              </span>
              <span className="block text-[11px] leading-snug text-stone-400">
                Teach, create, and grow your audience
              </span>
            </span>
          </IntentLink>
        </div>

        <div className="flex items-center gap-3 border-t border-stone-100 px-4 py-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-full learn-gradient text-xs font-semibold text-white">
            {user.initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-stone-900">{user.name}</p>
            <p className="truncate text-xs text-stone-400">{user.email}</p>
          </div>
          <SignOutButton />
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex flex-col border-b border-stone-200 bg-white/95 backdrop-blur md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/home" aria-label="WiseSel home" className="flex items-center gap-2">
            <WiseSelLogo variant="mark" className="h-7 w-auto" />
            <WiseSelLogo variant="wordmark" className="h-4 w-auto" />
          </Link>
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-full learn-gradient text-[11px] font-semibold text-white">
              {user.initials}
            </div>
            <SignOutButton />
          </div>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto px-2 pb-2">
          {learnerNav.map((item) => (
            <NavLink key={item.href} item={item} compact />
          ))}
        </nav>
      </div>
    </>
  );
}
