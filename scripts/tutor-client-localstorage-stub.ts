/**
 * A side-effect module that installs an in-memory `localStorage` for the tutor
 * client pure suite (scripts/verify-tutor-client.ts).
 *
 * WHY A SEPARATE MODULE: the suite originally assigned the stub inline "before"
 * importing the store — but esbuild/tsx HOISTS imports, so the tutorStore module
 * (and its zustand `persist` middleware) evaluated BEFORE the assignment ran.
 * With no storage the middleware takes its no-storage path: it warns on every
 * set AND never attaches the `useTutorStore.persist` API, which the suite's
 * partialize assertion needs. Import THIS module first — ESM executes imports
 * in declaration order, so the stub lands before the store module evaluates.
 *
 * NOTE zustand v5's default persist storage reads `window.localStorage` (not the
 * bare global), so a minimal `window` carrying ONLY the stub is installed too —
 * deliberately nothing else (no matchMedia/listeners: the suite exercises pure
 * helpers, and anything browser-shaped should keep failing loudly under Node).
 */

const memStore = new Map<string, string>();

const stub = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() {
    return memStore.size;
  },
} as Storage;

(globalThis as { localStorage?: Storage }).localStorage = stub;
(globalThis as { window?: { localStorage: Storage } }).window ??= {
  localStorage: stub,
};
