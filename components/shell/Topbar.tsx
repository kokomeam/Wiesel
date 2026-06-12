import { Search, Bell, Sparkles } from "lucide-react";

export function Topbar() {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-stone-200 bg-white/80 px-6 backdrop-blur">
      {/* Search */}
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
        <input
          type="text"
          placeholder="Search courses, lessons, templates…"
          className="h-9 w-full rounded-full border border-stone-200 bg-stone-50 pl-9 pr-16 text-sm text-stone-700 placeholder:text-stone-400 focus:border-brand-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/15"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-stone-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-stone-400">
          ⌘K
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button className="hidden items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3.5 py-1.5 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-100 sm:inline-flex">
          <Sparkles className="size-3.5" />
          Upgrade
        </button>
        <button
          className="relative grid size-9 place-items-center rounded-lg text-stone-500 transition-colors hover:bg-stone-100"
          aria-label="Notifications"
        >
          <Bell className="size-[18px]" />
          <span className="absolute right-2 top-2 size-2 rounded-full bg-brand-500 ring-2 ring-white" />
        </button>
      </div>
    </header>
  );
}
