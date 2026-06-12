import {
  LayoutDashboard,
  Wand2,
  Megaphone,
  BarChart3,
  FileDown,
  Store,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
}

/** Primary product areas — drives the sidebar and active-state highlighting. */
export const mainNav: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Creator Studio", href: "/studio", icon: Wand2 },
  { label: "Marketing", href: "/marketing", icon: Megaphone },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
  { label: "Exports", href: "/exports", icon: FileDown },
  { label: "Marketplace", href: "/marketplace", icon: Store },
];

export const secondaryNav: NavItem[] = [
  { label: "Settings", href: "/settings", icon: Settings },
];
