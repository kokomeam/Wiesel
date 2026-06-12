/**
 * Pure helpers for nested element groups (Google-Slides semantics).
 *
 * Groups are encoded as `groupPath: string[]` on each member element —
 * outermost group id first. "Scope" is the entered-group path during
 * navigation: at scope [], top-level groups act as atomic units; double-
 * clicking a selected group descends one level, Esc ascends.
 */

import type { SlideElement } from "../types";

export function pathOf(el: SlideElement): string[] {
  return el.groupPath ?? [];
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.every((seg, i) => path[i] === seg);
}

/** Is this element visible at the given scope (i.e. inside that scope)? */
export function inScope(el: SlideElement, scope: string[]): boolean {
  return startsWith(pathOf(el), scope);
}

/**
 * The "unit key" of an element at a scope: the thing one click selects.
 * Inside scope S, an element whose path extends S belongs to the sub-group
 * named by its next path segment; an element whose path IS S is its own unit.
 */
export function unitKeyAt(el: SlideElement, scope: string[]): string {
  const path = pathOf(el);
  return path.length > scope.length ? path[scope.length] : el.id;
}

/**
 * All elements in the same unit as `el` at `scope` — the element itself if
 * ungrouped at this level, else every member of its (sub-)group closure.
 */
export function unitClosure(
  elements: SlideElement[],
  el: SlideElement,
  scope: string[]
): SlideElement[] {
  if (!inScope(el, scope)) return [el];
  const key = unitKeyAt(el, scope);
  if (key === el.id) return [el];
  const groupPrefix = [...scope, key];
  return elements.filter((e) => startsWith(pathOf(e), groupPrefix));
}

/** Closure ids helper (selection payloads). */
export function unitClosureIds(
  elements: SlideElement[],
  el: SlideElement,
  scope: string[]
): string[] {
  return unitClosure(elements, el, scope).map((e) => e.id);
}

/** Distinct unit keys among a set of elements at a scope. */
export function unitKeysAt(elements: SlideElement[], scope: string[]): Set<string> {
  const keys = new Set<string>();
  for (const el of elements) {
    if (inScope(el, scope)) keys.add(unitKeyAt(el, scope));
  }
  return keys;
}

/** Expand a set of ids to full unit closures at a scope (marquee, paste…). */
export function expandToClosures(
  elements: SlideElement[],
  ids: Iterable<string>,
  scope: string[]
): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) continue;
    for (const member of unitClosure(elements, el, scope)) out.add(member.id);
  }
  return [...out];
}

/**
 * The deepest scope that still treats ALL the given elements as one unit —
 * used by Esc to walk up and dblclick to walk down. For a selection that is
 * exactly one group's closure at scope S, returns S.
 */
export function commonPath(elements: SlideElement[]): string[] {
  if (elements.length === 0) return [];
  let prefix = pathOf(elements[0]);
  for (const el of elements.slice(1)) {
    const path = pathOf(el);
    let i = 0;
    while (i < prefix.length && i < path.length && prefix[i] === path[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/** Distinct group ids acting as whole units at the scope depth among the
 *  given elements — the groups an "Ungroup" command would dissolve. */
export function groupIdsAt(elements: SlideElement[], scope: string[]): string[] {
  const ids = new Set<string>();
  for (const el of elements) {
    const path = pathOf(el);
    if (inScope(el, scope) && path.length > scope.length) ids.add(path[scope.length]);
  }
  return [...ids];
}

/** Group ids that have fewer than 2 distinct units directly inside them —
 *  degenerate after deletes/ungroup — mapped for removal. */
export function degenerateGroupIds(elements: SlideElement[]): Set<string> {
  // For every group id, find its depth and the set of units directly under it.
  const unitsByGroup = new Map<string, Set<string>>();
  for (const el of elements) {
    const path = pathOf(el);
    path.forEach((groupId, depth) => {
      const scope = path.slice(0, depth + 1);
      const key = path.length > scope.length ? path[scope.length] : el.id;
      let set = unitsByGroup.get(groupId);
      if (!set) {
        set = new Set();
        unitsByGroup.set(groupId, set);
      }
      set.add(key);
    });
  }
  const degenerate = new Set<string>();
  for (const [groupId, units] of unitsByGroup) {
    if (units.size < 2) degenerate.add(groupId);
  }
  return degenerate;
}
