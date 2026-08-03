/**
 * /studio serves two very different shapes from ONE URL: the course gallery
 * (no ?course=) and the full-bleed three-column editor (?course= →
 * StudioLoader's own hydration skeleton). loading.tsx cannot read
 * searchParams, so committing to either layout guarantees a whole-page shift
 * for the other (the measured "studio double-skeleton" CLS source). This is
 * therefore a deliberately NEUTRAL frame: the content area is one blank
 * shimmer — no card grid, no columns.
 *
 * The one committed piece of chrome is the empty 53px top rail, kept
 * byte-identical to StudioLoader's StudioSkeleton rail: on the ?course= path
 * (the common transition — opening a course from the gallery) the rail
 * carries over seamlessly into that skeleton and then the editor header. The
 * gallery variant has no such rail, but the swap replaces this frame
 * wholesale (nothing below it persists), so nothing shifts there either.
 */
export default function StudioLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy>
      <div className="h-[53px] shrink-0 border-b border-stone-200 bg-white" />
      <div aria-hidden className="skeleton-shimmer flex-1 bg-stone-50/40" />
    </div>
  );
}
