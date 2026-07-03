/**
 * Course Structure — target resolution.
 *
 * Resolves a natural-language reference ("Module 3", "this lesson", "the hashing
 * lesson", "the empty lessons") to STABLE ids against a `CourseOutlineSnapshot`,
 * returning one of three states — clear | ambiguous | unsafe — and NEVER a numeric
 * confidence score. The model already emits ids in its plan; this is the
 * code-side safety net used by validation (and exposed as the `resolve_course_target`
 * read tool) so a destructive op never runs against a guessed target.
 */

import type { CourseOutlineSnapshot, SnapshotLesson, SnapshotModule, TargetResolution } from "./types";

/** Normalize for fuzzy title matching (case/punctuation/whitespace-insensitive). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** word number / ordinal → cardinal (1-based). */
const WORD_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/** Extract a 1-based module number from a normalized phrase: "module 1" / "module one"
 *  / "chapter 2" / "the first module" / "the last module". Returns null if none. */
function moduleNumberFromPhrase(p: string, total: number): number | null {
  const digit = p.match(/\b(?:module|chapter|unit)\s+(\d+)\b/);
  if (digit) return Number(digit[1]);
  const word = p.match(/\b(?:module|chapter|unit)\s+([a-z]+)\b/);
  if (word && WORD_NUMBER[word[1]] !== undefined) return WORD_NUMBER[word[1]];
  if (/\blast\s+(?:module|chapter|unit)\b/.test(p)) return total;
  const ordinal = p.match(/\b([a-z]+)\s+(?:module|chapter|unit)\b/);
  if (ordinal && WORD_NUMBER[ordinal[1]] !== undefined) return WORD_NUMBER[ordinal[1]];
  return null;
}

function moduleLabel(m: SnapshotModule): string {
  return m.displayName;
}
function lessonLabel(l: SnapshotLesson): string {
  return `"${l.title}"`;
}

/** Resolve a module reference. Handles an explicit id, "Module N" / "module 3", a
 *  unique title match, or "this/current module". */
export function resolveModule(
  phrase: string,
  snapshot: CourseOutlineSnapshot
): TargetResolution {
  const mods = snapshot.modules;
  const p = norm(phrase);

  // explicit id
  const byId = mods.find((m) => phrase.includes(m.moduleId));
  if (byId) return { status: "clear", kind: "module", id: byId.moduleId, label: moduleLabel(byId) };

  // "this" / "current" module
  if (/\b(this|current|the selected)\b/.test(p) && snapshot.selected.moduleId) {
    const sel = mods.find((m) => m.moduleId === snapshot.selected.moduleId);
    if (sel) return { status: "clear", kind: "module", id: sel.moduleId, label: moduleLabel(sel) };
  }

  // "Module N" — digit ("Module 1"), word number ("module one"), or ordinal
  // ("the first/last module"). Resolves to the 1-based module number.
  const n = moduleNumberFromPhrase(p, mods.length);
  if (n !== null) {
    const hit = mods.find((m) => m.number === n);
    if (hit) return { status: "clear", kind: "module", id: hit.moduleId, label: moduleLabel(hit) };
    return { status: "unsafe", reason: `There is no Module ${n} (the course has ${mods.length} module(s)).` };
  }

  // title contains
  const titleHits = mods.filter((m) => p.includes(norm(m.title)) && norm(m.title).length > 0);
  if (titleHits.length === 1) return { status: "clear", kind: "module", id: titleHits[0].moduleId, label: moduleLabel(titleHits[0]) };
  if (titleHits.length > 1)
    return {
      status: "ambiguous",
      kind: "module",
      candidates: titleHits.map((m) => ({ id: m.moduleId, label: moduleLabel(m) })),
      question: `Which module do you mean — ${titleHits.map(moduleLabel).join(", or ")}?`,
    };

  return { status: "unsafe", reason: `I couldn't tell which module "${phrase}" refers to.` };
}

/** Resolve a lesson reference. Handles an explicit id, a unique title match,
 *  or "this/current lesson". (Module-scoped lookups go through the snapshot.) */
export function resolveLesson(
  phrase: string,
  snapshot: CourseOutlineSnapshot
): TargetResolution {
  const lessons = snapshot.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, moduleNumber: m.number })));
  const p = norm(phrase);

  const byId = lessons.find((l) => phrase.includes(l.lessonId));
  if (byId) return { status: "clear", kind: "lesson", id: byId.lessonId, label: lessonLabel(byId) };

  if (/\b(this|current|the selected)\b/.test(p) && snapshot.selected.lessonId) {
    const sel = lessons.find((l) => l.lessonId === snapshot.selected.lessonId);
    if (sel) return { status: "clear", kind: "lesson", id: sel.lessonId, label: lessonLabel(sel) };
  }

  const titleHits = lessons.filter((l) => norm(l.title).length > 0 && p.includes(norm(l.title)));
  if (titleHits.length === 1) return { status: "clear", kind: "lesson", id: titleHits[0].lessonId, label: lessonLabel(titleHits[0]) };
  if (titleHits.length > 1)
    return {
      status: "ambiguous",
      kind: "lesson",
      candidates: titleHits.map((l) => ({ id: l.lessonId, label: `${lessonLabel(l)} (Module ${l.moduleNumber})` })),
      question: `There are ${titleHits.length} lessons named like that — which one?`,
    };

  return { status: "unsafe", reason: `I couldn't tell which lesson "${phrase}" refers to.` };
}

/** Does an id exist in the snapshot (the executor must never act on a hallucinated id)? */
export function moduleExists(snapshot: CourseOutlineSnapshot, moduleId: string): boolean {
  return snapshot.modules.some((m) => m.moduleId === moduleId);
}
export function lessonExists(snapshot: CourseOutlineSnapshot, lessonId: string): SnapshotLesson | null {
  for (const m of snapshot.modules) {
    const l = m.lessons.find((x) => x.lessonId === lessonId);
    if (l) return l;
  }
  return null;
}
