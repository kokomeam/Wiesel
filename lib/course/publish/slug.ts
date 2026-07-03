/**
 * Course slugs — PURE helpers. URL-safe: lowercase alnum groups separated by
 * single hyphens (mirrors the DB CHECK on course_publications.slug).
 */

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 60;

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
}

/** Derive a slug candidate from a course title. Always returns a valid slug
 *  (falls back to "course" for titles with no usable characters). */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics (post-NFKD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "course";
}

/** First of `base`, `base-2`, `base-3`, … not present in `taken`. Suffixing
 *  respects the max length (the base is trimmed to make room). */
export function suffixedSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Public learner-facing path for a published course. */
export function publicCoursePath(slug: string): string {
  return `/learn/${slug}`;
}
