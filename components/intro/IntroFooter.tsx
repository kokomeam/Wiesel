import Link from "next/link";
import { Wordmark } from "./IntroNav";

const links = [
  { label: "For educators", href: "/educators" },
  { label: "Marketplace", href: "/marketplace" },
  { label: "Studio", href: "/studio" },
  { label: "Dashboard", href: "/dashboard" },
];

export function IntroFooter() {
  return (
    <footer className="border-t border-stone-900/[0.07] bg-[#FAF7F1]">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
        <div className="flex items-center gap-4">
          <Wordmark suffix="both sides of the classroom" />
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-6">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500 transition-colors hover:text-stone-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-400">
          © 2026 WiseSel
        </p>
      </div>
    </footer>
  );
}
