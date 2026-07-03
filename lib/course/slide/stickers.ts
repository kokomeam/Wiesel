/**
 * Sticker primitive library — the ONE registry of inline icons that the
 * renderer, the manual editor (a picker), and the AI all reference BY ID.
 *
 * This module is pure data (no React) so it can be imported from the UI-free
 * course-model layer (schemas/patches/AI). The actual icon GEOMETRY is
 * lucide-react, mapped id → component in the renderer
 * (`components/editor/slide/elements/StickerElement.tsx`). Add a sticker once
 * here (+ its icon in that map) and all three consumers pick it up.
 *
 * Stickers render single-color, themed to the slide accent, in a tinted circle
 * — never per-icon two-tone, never raw SVG from the model.
 */

export interface StickerDef {
  /** Stable kebab id used in content + patches + the AI schema. */
  id: string;
  /** 2–3 word human label (picker + AI catalog + aria-label). */
  label: string;
  /** Search terms for the picker and hints for the AI's choice. */
  keywords: string[];
}

/** Curated starter set (seeded from the reference sticker sheet + the cgref
 *  layouts). Every id MUST have an icon in STICKER_ICONS — verified by a test. */
export const STICKER_REGISTRY: StickerDef[] = [
  // ── Arrows / flow
  { id: "arrow-right", label: "Arrow", keywords: ["next", "forward", "then", "flow", "step"] },
  { id: "arrow-left-right", label: "Two-way arrow", keywords: ["both", "bidirectional", "exchange", "sync"] },
  { id: "trending-up", label: "Growth", keywords: ["increase", "rise", "up", "improve", "progress"] },
  { id: "split", label: "Branch", keywords: ["diverge", "fork", "one to two", "split", "decision"] },
  { id: "exchange", label: "Exchange", keywords: ["swap", "trade", "transfer", "convert"] },
  // ── Concepts (people / money)
  { id: "users", label: "People", keywords: ["team", "users", "audience", "group", "community"] },
  { id: "discuss", label: "Discussion", keywords: ["talk", "chat", "conversation", "feedback", "communicate"] },
  { id: "cash", label: "Cash", keywords: ["money", "payment", "revenue", "price", "banknote"] },
  { id: "coins", label: "Coins", keywords: ["money", "savings", "cost", "budget", "stack"] },
  // ── Generally useful
  { id: "check", label: "Check", keywords: ["correct", "done", "yes", "success", "approve"] },
  { id: "x", label: "Cross", keywords: ["wrong", "no", "remove", "avoid", "incorrect"] },
  { id: "target", label: "Target", keywords: ["goal", "aim", "objective", "focus", "bullseye"] },
  { id: "lightbulb", label: "Idea", keywords: ["insight", "concept", "understand", "tip", "learn"] },
  { id: "info", label: "Note", keywords: ["note", "info", "aside", "caveat", "in practice", "remember"] },
  { id: "bar-chart", label: "Chart", keywords: ["data", "metrics", "results", "analytics", "performance"] },
  { id: "search", label: "Identify", keywords: ["find", "explore", "analyze", "magnify", "discover"] },
  { id: "brain", label: "Understand", keywords: ["think", "learn", "knowledge", "comprehend", "reason"] },
  { id: "signpost", label: "Choice", keywords: ["decision", "direction", "tradeoff", "option", "path"] },
  { id: "user-star", label: "Best option", keywords: ["preference", "favorite", "alternative", "top pick"] },
  { id: "gear", label: "Process", keywords: ["execute", "build", "configure", "mechanism", "settings"] },
  { id: "document", label: "Plan", keywords: ["notes", "write", "document", "draft", "map"] },
];

export const STICKER_IDS: string[] = STICKER_REGISTRY.map((s) => s.id);

const STICKER_ID_SET = new Set(STICKER_IDS);

export function isStickerId(id: string): boolean {
  return STICKER_ID_SET.has(id);
}

export function findSticker(id: string): StickerDef | undefined {
  return STICKER_REGISTRY.find((s) => s.id === id);
}

/** Safe default when an id is missing/unknown (renderer + factory fallback). */
export const DEFAULT_STICKER_ID = "lightbulb";

/** A compact catalog line the AI system prompt can list (id — label). */
export function stickerCatalogText(): string {
  return STICKER_REGISTRY.map((s) => `${s.id} — ${s.label}`).join(", ");
}
