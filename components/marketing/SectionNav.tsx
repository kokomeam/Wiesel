"use client";

/**
 * The grouped section strip (UI-1 W2.2, DEV-7): every marketing destination
 * visible under the page header — deliberately NOT dropdown groups, which
 * would regress every destination to two clicks (INV-4). Groups by hairline
 * separators + eyebrows at ≥md; a horizontally scrollable chip row below.
 * The agent is deliberately absent: the ask bar + FAB are its entry points.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CheckCheck,
  Clapperboard,
  Link2,
  Mail,
  Send,
  Share2,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { cn } from "@/lib/cn";

interface NavDest {
  href: string;
  icon: LucideIcon;
  label: string;
  /** Old Explore sub-line — kept as a hover title. */
  title: string;
}

export const SECTION_NAV_GROUPS: { label: string; items: NavDest[] }[] = [
  {
    label: "Audience",
    items: [
      { href: "/marketing/leads", icon: UserPlus, label: "Leads", title: "Consent-first lists and imports" },
      { href: "/marketing/audience", icon: Users, label: "Audience", title: "Subscribers and funnel stages" },
    ],
  },
  {
    label: "Email",
    items: [
      { href: "/marketing/email", icon: Mail, label: "Email campaigns", title: "Goal-driven sequences, reviewed by you" },
      { href: "/marketing/sequences", icon: Send, label: "Sequences", title: "What sends, when, to whom" },
    ],
  },
  {
    label: "Social",
    items: [
      { href: "/marketing/social", icon: Share2, label: "Social posts", title: "Drafts you copy and post yourself" },
      { href: "/marketing/clips", icon: Clapperboard, label: "Lesson clips", title: "Short verticals cut from your lessons" },
      { href: "/marketing/accounts", icon: Link2, label: "Connected accounts", title: "Link the social accounts WiseSel works with" },
      { href: "/marketing/publish", icon: CheckCheck, label: "Publish review", title: "Approve or skip each post before it ships" },
    ],
  },
  {
    label: "Insights",
    items: [{ href: "/marketing/analytics", icon: BarChart3, label: "Analytics", title: "Views, clicks, enrollments" }],
  },
];

export function SectionNav({ courseId }: { courseId: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Marketing sections"
      data-testid="section-nav"
      className="flex items-center gap-y-1 max-lg:overflow-x-auto max-lg:pb-1 lg:flex-wrap"
    >
      {/* Group chrome (eyebrows + separators) is lg-up only — at tablet
          widths the chips alone must wrap to ≤2 rows inside 88px. */}
      {SECTION_NAV_GROUPS.map((group, gi) => (
        <div key={group.label} className="flex shrink-0 items-center max-lg:mr-1">
          {gi > 0 ? <span aria-hidden className="mx-2.5 hidden h-4 w-px shrink-0 bg-line lg:block" /> : null}
          {/* stone-600 override: these sit on the canvas, not a white card. */}
          <Eyebrow className="mr-2 hidden shrink-0 text-stone-600 lg:block">{group.label}</Eyebrow>
          <div className="flex shrink-0 items-center gap-1">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={`${item.href}?course=${courseId}`}
                  title={item.title}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-secondary font-medium ring-1 transition-colors",
                    active
                      ? "bg-white text-brand-700 ring-stone-200 shadow-card"
                      : "text-stone-600 ring-transparent hover:bg-white hover:text-stone-900 hover:shadow-card hover:ring-stone-200"
                  )}
                >
                  <Icon className={cn("size-4", active ? "text-brand-700" : "text-stone-500")} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
