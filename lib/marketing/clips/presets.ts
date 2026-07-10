/**
 * Packaging presets + ResolvedPackaging (M-C, PRD §9.1 + amendment FR-5).
 *
 * PRESETS and LAYOUTS are ORTHOGONAL (binding): any preset can render in any
 * layout the recording format allows — a bofu_preview slide-short is valid, a
 * tofu_hook stacked-split is valid. Zod enforces MEMBERSHIP only; there is
 * deliberately NO superRefine coupling preset↔layout.
 *
 * `captionsPresetId` maps our preset → one of Reap's ~10 read-only system
 * caption styles (Task 0 (c): no brand-template API exists — this lookup IS
 * `ensureBrandTemplate()` now). It only applies to provider-rendered
 * face_track output; in-house layouts get the M-F caption engine. Real
 * WiseSel branding rides `resolveBrandTokens` (D-1) — creator overrides are
 * the [FWD] seam, ALWAYS undefined in MVP.
 */

import { z } from "zod";
import {
  resolveBrandTokens,
  type BrandTokens,
  type CreatorBrandOverrides,
} from "@/lib/marketing/brand/tokens";
import { CLIP_LAYOUTS } from "./constants";
import { ClipLayoutSchema, type ClipLayout } from "./schemas";

export const CLIP_PACKAGING_PRESETS = ["tofu_hook", "mofu_story", "bofu_preview"] as const;
export type ClipPackagingPreset = (typeof CLIP_PACKAGING_PRESETS)[number];

export interface ClipPresetMeta {
  label: string;
  /** Reap system caption style for provider-rendered output (Task 0 (c)). */
  captionsPresetId: string;
  /** The hook framing the posting kit leans on (M-D copy input). */
  hookFraming: string;
  /** End-card CTA framing (comment-keyword vs. enroll/link). */
  endCardFraming: string;
}

export const CLIP_PRESET_META: Record<ClipPackagingPreset, ClipPresetMeta> = {
  tofu_hook: {
    label: "TOFU hook",
    captionsPresetId: "system_hype",
    hookFraming: "curiosity-gap / negative-knowledge opener",
    endCardFraming: "comment-keyword primary",
  },
  mofu_story: {
    label: "MOFU story",
    captionsPresetId: "system_think_media",
    hookFraming: "identity/process opener",
    endCardFraming: "comment-keyword primary",
  },
  bofu_preview: {
    label: "BOFU preview",
    captionsPresetId: "system_march",
    hookFraming: "inside-the-course preview framing",
    endCardFraming: "enroll / link-in-bio framing",
  },
};

/** The wire-safe half (persisted/validated); brand tokens resolve at use. */
export const ResolvedPackagingSchema = z.object({
  presetId: z.enum(CLIP_PACKAGING_PRESETS),
  /** REQUIRED per amendment FR-5 — membership only, never preset-coupled. */
  layout: ClipLayoutSchema,
  captionsPresetId: z.string(),
});
export type ResolvedPackagingWire = z.infer<typeof ResolvedPackagingSchema>;

export interface ResolvedPackaging extends ResolvedPackagingWire {
  brand: BrandTokens;
  /** [FWD] per-creator brand kit — ALWAYS undefined in MVP (D-1). */
  creatorBrandOverrides?: CreatorBrandOverrides;
}

export function resolvePackaging(
  presetId: ClipPackagingPreset,
  layout: ClipLayout,
  creatorBrandOverrides?: CreatorBrandOverrides
): ResolvedPackaging {
  if (!(CLIP_LAYOUTS as readonly string[]).includes(layout)) {
    throw new Error(`unknown layout '${layout}'`);
  }
  return {
    presetId,
    layout,
    captionsPresetId: CLIP_PRESET_META[presetId].captionsPresetId,
    brand: resolveBrandTokens(creatorBrandOverrides),
    creatorBrandOverrides,
  };
}
