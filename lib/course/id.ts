/**
 * Id generation for in-document nodes (elements, slides, list items, …).
 * Lives alone so pure leaf modules (slide/list.ts, the read-only slide view
 * path) can mint ids without importing factories.ts — which drags the whole
 * structured-layout registry into the learner bundle (PERF-1 D1, A6 #3).
 * crypto.randomUUID ⇒ event handlers only, never render.
 */

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
