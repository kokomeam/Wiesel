# Caching policy (PERF-1 B5/C4)

One page: what is cached, where, for how long, and why it can never serve wrong data.

## Principles

1. **No parallel data layer.** The client cache IS the Next.js Router Cache; the server cache IS `react cache()` (request scope) + `unstable_cache` (cross-request Data Cache) + Supabase storage/CDN headers. No React Query/SWR (directive §9).
2. **Immutability does the work.** Published content is DB-trigger immutable (`course_publications`: snapshot/version/content_hash reject UPDATE) and storage objects are UUID-named write-once (replace-flows upload a NEW object and delete the old). Immutable things cache forever with **no invalidation story at all**; mutable things are cheap narrow reads that are never cached.
3. **Authorization is never cached.** RLS-scoped *meta* queries (who can see what, live/visibility/slug state) always hit the DB; only the immutable *body* they point at comes from cache.

## Tiers

| Data class | Cache | TTL | Invalidation | Why it's safe |
|---|---|---|---|---|
| Published snapshot body (snapshot, version, content_hash) | `unstable_cache` keyed by publication id (`lib/learn/publicationCache.ts`) + per-process parsed-Zod LRU (32) | ∞ (`revalidate: false`) | none needed | DB trigger rejects any mutation of these columns; status/visibility/slug are NOT in the entry |
| Publication meta (status, visibility, slug) | none — narrow RLS-scoped query per request | 0 | n/a | mutable + authorization-bearing |
| Draft course content (studio) | none server-side; Router Cache client-side only | 0 / 30 s client | autosave writes + `router.refresh` | drafts mutate constantly |
| Analytics rollups | none server-side (rollups are already the cache — nightly + manual recompute); Router Cache client-side | 30 s client | "Refresh data" action → `revalidatePath` | rollup tables change at most nightly/manual |
| Auth user | `react cache()` (`getSessionUser`) | request | n/a | request-scoped only; middleware still refreshes tokens |
| Session profile (display_name/role/avatar) | `react cache()` (`getSessionProfile`) | request | n/a | request-scoped only |
| **Client: RSC payloads (all dynamic routes)** | Router Cache via `experimental.staleTimes` | **dynamic 30 s, static 300 s** | any server action `revalidatePath`; hard reload | 30 s staleness on in-app dashboards is an accepted product trade-off; mutating flows call `revalidatePath`/`router.refresh` which purge it |
| Back/forward navigation | Router Cache / bfcache restore (framework) | session | popstate revalidation hook | measured 8–20 ms; a background `router.refresh()` revalidates after restore |
| Storage objects — published/immutable (AI slide images, covers, avatars, homework files, deck page images) | Supabase storage → browser/CDN, `cacheControl: 31536000` at upload (`IMMUTABLE_ASSET_CACHE_SECONDS`) | 1 year | none needed | object names embed UUIDs; replacing content = new object + old deleted; stale references die with the row that held them |
| Storage objects — deck pages via signed URLs | same object TTL, but the SIGNED URL rotates hourly | ≤1 h effective | n/a | security trade-off documented in `deckImportStorage.ts` — private bucket stays signed |
| Fonts / `_next/static` chunks | Next defaults (immutable, content-hashed) | 1 year | build id | framework |

## Intent prefetch (B4)

Hover/focus/touch on primary-nav links and course cards triggers `router.prefetch(href)` through `lib/perf/intentPrefetch.ts`: 80 ms hover debounce (kills list-sweep storms), ≤3 concurrent, one prefetch per href per 30 s (matches `staleTimes.dynamic` — a prefetch older than the stale window would be refetched on click anyway). Viewport code-prefetch stays at the Link default.

## What is deliberately NOT cached

- Anything authorization-bearing (RLS meta queries, enrollment/access checks).
- Learner progress state (correctness > speed; writes are optimistic-locked server-side).
- Marketing approvals/questions (must reflect resolution instantly across surfaces — approvalSync invalidates cross-tab).
- Exact analytics counts backing creator decisions (rollups are the sanctioned staleness layer).

## Adding a new cached thing — checklist

1. Is it immutable-by-construction (DB trigger / content-hash / UUID object)? → cache forever, key by id/hash, done.
2. Mutable? → prefer NOT caching; if you must, tag it (`unstable_cache` tags) and `revalidateTag` from EVERY mutation path, and write the test that proves stale-after-mutation fails.
3. Never put status/visibility/authorization columns inside a cached entry.
