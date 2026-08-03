/**
 * Zod-free profile field caps (PERF-1 D1). The identity band + settings form
 * render live character counters from these, so they sit in the initial
 * client bundle — while the zod CreatorProfileFormSchema (lib/profile/
 * schema.ts) is needed only inside the async SAVE handlers, which lazy-import
 * it. Keeping the caps here keeps the zod core out of /dashboard.
 * schema.ts re-exports this so existing imports keep working.
 */
export const PROFILE_LIMITS = {
  displayName: 80,
  headline: 120,
  bio: 2000,
} as const;
