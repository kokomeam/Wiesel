import Link from "next/link";

/** Shown for unknown slugs AND for unlisted courses visited signed-out (RLS
 *  makes those indistinguishable by design — link possession requires a
 *  session), so the copy covers both. */
export default function CourseNotFound() {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-stone-400">404</p>
      <h1 className="mt-3 text-3xl [font-family:var(--font-display)] font-light text-stone-900">
        Course not found
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-stone-500">
        This course may have moved or may be unlisted. If someone shared this
        link with you, sign in and open it again.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link
          href="/login"
          className="brand-gradient rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
        >
          Sign in
        </Link>
        <Link
          href="/"
          className="rounded-full border border-stone-300/80 bg-white px-5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
