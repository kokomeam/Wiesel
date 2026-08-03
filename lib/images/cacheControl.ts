/**
 * Cache lifetime for IMMUTABLE storage objects (PURE — shared by browser and
 * server upload sites). Every object we upload is UUID-named — replace flows
 * delete the old object and write a NEW path — so a year-long max-age is safe
 * at every site. Supabase's upload `cacheControl` option takes SECONDS as a
 * string and serves the object with `cache-control: max-age=<seconds>` (the
 * default is a mere 3600 — PERF-1 C4). Supabase does not emit `immutable`;
 * the long max-age is the win.
 */
export const IMMUTABLE_ASSET_CACHE_SECONDS = "31536000"; // 365 days
