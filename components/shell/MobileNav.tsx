"use client";

/**
 * Mobile navigation (DEV-3 / D-17): below `md` the app sidebar hides
 * entirely; this hamburger in the Topbar opens the same navigation in a
 * left-hand Drawer. Links close the drawer on navigate.
 */

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";
import { Drawer } from "@/components/ui/Drawer";
import { mainNav, secondaryNav } from "@/lib/nav";
import { cn } from "@/lib/cn";
import type { NavItem } from "@/lib/nav";

function MobileNavLink({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const pathname = usePathname();
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "flex min-h-row-h items-center gap-3 rounded-panel px-3 py-2 text-body font-medium transition-colors",
        active ? "bg-brand-50 text-brand-700" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      )}
    >
      <Icon className={cn("size-4.5 shrink-0", active ? "text-brand-700" : "text-stone-500")} />
      {item.label}
    </Link>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
        className="grid size-9 place-items-center rounded-control text-stone-500 transition-colors hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <Menu className="size-5" />
      </button>
      <Drawer
        open={open}
        onClose={close}
        side="left"
        title={<WiseSelLogo variant="horizontal" className="h-6 w-auto" />}
        data-testid="mobile-nav-drawer"
      >
        <nav className="space-y-0.5" aria-label="Main navigation">
          {mainNav.map((item) => (
            <MobileNavLink key={item.href} item={item} onNavigate={close} />
          ))}
          <div className="my-3 h-px bg-stone-100" />
          {secondaryNav.map((item) => (
            <MobileNavLink key={item.href} item={item} onNavigate={close} />
          ))}
        </nav>
      </Drawer>
    </div>
  );
}
