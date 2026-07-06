/**
 * Server-side CLAMP for structured-slide content — the fix for the "strictness
 * death-spiral".
 *
 * The strict per-slide template schema (structuredLayouts.ts) caps every text
 * slot + item array. Previously an over-long slot REJECTED the whole slide and
 * bounced it back to the model to reshape — which churned and, under a tight
 * budget, left specs unbuilt. Instead we now AUTO-SHORTEN over-length fields to
 * their max and SAVE the slide, attaching a non-blocking warning. We never bounce
 * a formatting problem back to the model.
 *
 * The clamp is SCHEMA-DRIVEN (works for every layout, present and future): it
 * parses, reads Zod's own `too_big` issues (stable in Zod 4: `code`, `path`,
 * `maximum`), truncates the offending string / slices the offending array at that
 * path, and re-parses until valid or no clampable issue remains. A slide that's
 * still invalid (missing required content, too FEW items, wrong shape) can't be
 * auto-fixed — only THOSE come back to the model.
 *
 * Pure: no DB, no model, no React.
 */

import type { z } from "zod";
import { StructuredTemplateInputSchema } from "./structuredLayouts";
import type { SlideTemplate } from "../types";

/** Truncate a string to `max` chars, preferring a word boundary, with a trailing
 *  ellipsis that keeps the result ≤ max (so the re-parse passes). */
export function smartTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, Math.max(0, max));
  const slice = s.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace >= Math.floor(max * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

function getAtPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

function setAtPath(root: unknown, path: ReadonlyArray<PropertyKey>, value: unknown): void {
  if (path.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = (cur as Record<PropertyKey, unknown>)[path[i]];
  }
  if (cur != null && typeof cur === "object") {
    (cur as Record<PropertyKey, unknown>)[path[path.length - 1]] = value;
  }
}

export interface ClampResult<T> {
  /** The parsed, valid value (when ok). */
  value?: T;
  /** True when at least one field had to be shortened/trimmed to fit. */
  clamped: boolean;
  /** Compact human-readable list of the slots that were shortened (for the warning). */
  clampedPaths: string[];
}

/**
 * Parse `value` against `schema`, AUTO-SHORTENING any over-length string / over-
 * count array at the path Zod flags, until it validates or no `too_big` issue
 * remains. Returns the parsed value + which slots were clamped, or `{ clamped }`
 * with no `value` when the value is invalid for a reason clamping can't fix.
 */
export function clampToSchema<T>(schema: z.ZodType<T>, value: unknown): ClampResult<T> {
  // Work on a deep copy so the caller's object is never mutated.
  let v: unknown;
  try {
    v = structuredClone(value);
  } catch {
    v = value;
  }
  const clampedPaths = new Set<string>();

  for (let round = 0; round < 16; round++) {
    const res = schema.safeParse(v);
    if (res.success) {
      return { value: res.data, clamped: clampedPaths.size > 0, clampedPaths: [...clampedPaths] };
    }
    let progressed = false;
    for (const issue of res.error.issues) {
      if (issue.code !== "too_big") continue;
      const maxRaw = (issue as { maximum?: number | bigint }).maximum;
      const max = typeof maxRaw === "bigint" ? Number(maxRaw) : maxRaw;
      if (typeof max !== "number" || !Number.isFinite(max)) continue;
      const target = getAtPath(v, issue.path);
      if (typeof target === "string" && target.length > max) {
        setAtPath(v, issue.path, smartTruncate(target, max));
        clampedPaths.add(issue.path.join(".") || "(root)");
        progressed = true;
      } else if (Array.isArray(target) && target.length > max) {
        setAtPath(v, issue.path, target.slice(0, max));
        clampedPaths.add(issue.path.join(".") || "(root)");
        progressed = true;
      }
    }
    if (!progressed) break; // remaining issues aren't clampable (e.g. too FEW, wrong type)
  }

  const final = schema.safeParse(v);
  if (final.success) return { value: final.data, clamped: clampedPaths.size > 0, clampedPaths: [...clampedPaths] };
  return { clamped: clampedPaths.size > 0, clampedPaths: [...clampedPaths] };
}

/**
 * Coerce the NULLS the agent uniformly emits for an ABSENT optional field into the
 * shapes the schema expects — recursively, anywhere they occur (nested arbitrarily
 * deep, every layout):
 *   - `runs:  null` → []   (the empty rich-text run list)
 *   - `marks: null` → {}   (the empty mark set inside a run)
 *   - any OTHER key whose value is null → DELETE it (the agent's "this is absent":
 *     `icon: null`, `detail: null`, `example: null`, `subtitle: null`, …)
 * LOSSLESS: `null` carries no content here — it always means "empty/absent" — so this
 * changes ENCODING, never text. It is the decisive fix for the "missing content" loop:
 * fully-authored slides were rejected only on `runs: expected array, received null`
 * (and `icon`/`detail`/`example: received null`). A genuinely-missing REQUIRED field
 * (e.g. `body: null`) still surfaces as a real error after the delete — an empty slide
 * is never silently saved. Walks a deep copy (never mutates the caller's object). PURE.
 */
export function normalizeAgentNulls<T>(value: T): T {
  let v: unknown;
  try {
    v = structuredClone(value);
  } catch {
    v = value;
  }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      const val = o[key];
      if (val === null) {
        if (key === "runs") o[key] = [];
        else if (key === "marks") o[key] = {};
        else delete o[key]; // the agent's "absent" — let the schema enforce required-ness
      } else {
        walk(val);
      }
    }
  };
  walk(v);
  return v as T;
}

/**
 * Drop `runs` from any rich-text slot whose `runs` no longer concatenate to its
 * (possibly truncated) `.text`, preserving the invariant `concat(runs) === text`
 * that lint/AI rely on. Mutates in place; returns the same node.
 */
function dropInconsistentRuns(node: unknown): void {
  if (Array.isArray(node)) {
    for (const n of node) dropInconsistentRuns(n);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (typeof o.text === "string" && Array.isArray(o.runs)) {
    const joined = (o.runs as Array<{ text?: unknown }>)
      .map((r) => (typeof r?.text === "string" ? r.text : ""))
      .join("");
    if (joined !== o.text) delete o.runs;
  }
  for (const [k, val] of Object.entries(o)) {
    if (k === "runs") continue;
    dropInconsistentRuns(val);
  }
}

export interface StructuredClampResult {
  /** The valid, clamped template ready to save — or undefined if unsaveable. */
  template?: SlideTemplate;
  /** True when one or more slots were auto-shortened to fit. */
  clamped: boolean;
  /** Slots that were shortened (for a non-blocking warning). */
  clampedPaths: string[];
  /** Why the template is unsaveable (only set when `template` is undefined). */
  error?: string;
}

/**
 * Clamp a raw structured-slide template to the strict input schema and return a
 * saveable `SlideTemplate`. Over-length slots are shortened (with the slot names
 * in `clampedPaths`); a template that's invalid for a non-length reason returns
 * `error` and no template (so ONLY a genuinely unbuildable slide comes back).
 */
export function clampStructuredTemplate(raw: unknown): StructuredClampResult {
  const res = clampToSchema(StructuredTemplateInputSchema, raw);
  if (!res.value) {
    const detail = StructuredTemplateInputSchema.safeParse(raw);
    const error = detail.success
      ? "invalid template"
      : detail.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join(".") || "template"}: ${i.message}`)
          .join(" · ");
    return { clamped: res.clamped, clampedPaths: res.clampedPaths, error };
  }
  dropInconsistentRuns(res.value);
  return { template: res.value as SlideTemplate, clamped: res.clamped, clampedPaths: res.clampedPaths };
}
