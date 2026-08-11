/**
 * TUTOR-1 Amendment A4, Wave 4 — server-side citation LABEL resolution (pure).
 *
 * A citation is `{lessonId, blockId, slideId?}` (ids). The learner must never see
 * an id (D-7 / A4-22); the "Go there" affordance must NAME its destination (D-8 /
 * A4-23). This resolves each citation to a human LABEL from the published
 * snapshot — the lesson title, plus "· slide N" when a specific slide is cited.
 * The labels ride the turn payload + are persisted into the grounding jsonb, so
 * both live and history turns show a real destination name.
 */

import type { PublicationSnapshot } from "@/lib/course/publish/schemas";

export interface CitationLike {
  lessonId: string;
  blockId: string;
  slideId?: string | null;
}

export interface LabeledCitation {
  lessonId: string;
  blockId: string;
  slideId: string | null;
  /** The human destination name (never an id). */
  label: string;
}

/** Build a lesson-title map + a (blockId → slideId → 1-based position) map. */
function buildIndex(snapshot: PublicationSnapshot): {
  lessonTitle: Map<string, string>;
  slidePos: Map<string, Map<string, number>>;
} {
  const lessonTitle = new Map<string, string>();
  const slidePos = new Map<string, Map<string, number>>();
  for (const m of snapshot.modules) {
    for (const l of m.lessons) {
      lessonTitle.set(l.id, l.title);
      for (const b of l.blocks) {
        if (b.type === "slide_deck") {
          const pos = new Map<string, number>();
          (b as unknown as { slides: { id: string }[] }).slides.forEach((s, i) => pos.set(s.id, i + 1));
          slidePos.set(b.id, pos);
        }
      }
    }
  }
  return { lessonTitle, slidePos };
}

/** Resolve a human label for one citation. */
function labelFor(
  idx: { lessonTitle: Map<string, string>; slidePos: Map<string, Map<string, number>> },
  c: CitationLike
): string {
  const title = idx.lessonTitle.get(c.lessonId) ?? "the referenced lesson";
  if (c.slideId) {
    const pos = idx.slidePos.get(c.blockId)?.get(c.slideId);
    if (pos) return `${title} · slide ${pos}`;
  }
  return title;
}

/** Attach a human `label` to every citation, resolved from the snapshot. Pure. */
export function resolveCitationLabels(
  snapshot: PublicationSnapshot,
  citations: CitationLike[]
): LabeledCitation[] {
  const idx = buildIndex(snapshot);
  return citations.map((c) => ({ lessonId: c.lessonId, blockId: c.blockId, slideId: c.slideId ?? null, label: labelFor(idx, c) }));
}
