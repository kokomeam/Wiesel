/**
 * Bundled clip fonts (T-1) — server-only. The burn pipeline NEVER relies on
 * system fonts: the OFL-licensed files in `assets/clip-fonts/` are handed to
 * libass via the `subtitles=` filter's `fontsdir=` option (libass adds them
 * to its memory font provider, which wins over fontconfig), and this module
 * ASSERTS they resolve before any burn:
 *
 *   1. the files exist on disk (a broken deploy fails loudly, not with a
 *      silent DejaVu fallback — the T-1 release blocker), and
 *   2. each file's TTF name table actually contains the family name the ASS
 *      styles reference (a renamed/mismatched font can't slip through).
 *
 * The rendered-frame half of the fallback check lives in
 * verify-clips-render (`textBurn.fonts.spec`): the same hook burned with the
 * real family vs. a nonsense family MUST differ — identical frames mean the
 * real family didn't resolve and the fallback took both renders.
 *
 * Licenses ship alongside the files (OFL-*.txt) — see docs/clips.md
 * § Burned text (OFL obligations: license bundled, no font resale).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIP_TEXT_FONTS } from "./textStyles";

export const CLIP_FONT_FILES = [
  CLIP_TEXT_FONTS.hook.file,
  CLIP_TEXT_FONTS.hookAlt.file,
  CLIP_TEXT_FONTS.caption.file,
  CLIP_TEXT_FONTS.captionAlt.file,
] as const;

export const CLIP_FONT_LICENSE_FILES = [
  "OFL-ArchivoBlack.txt",
  "OFL-Montserrat.txt",
  "OFL-Inter.txt",
] as const;

export class ClipFontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipFontError";
  }
}

/** Resolve assets/clip-fonts from the repo root — works from the Next
 *  server, tsx scripts, and tests (cwd first, then relative to this module
 *  for bundled layouts). */
export function clipFontsDir(): string {
  const candidates = [
    join(process.cwd(), "assets", "clip-fonts"),
    // lib/marketing/clips/textFonts.ts → repo root is 3 levels up
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "clip-fonts"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, CLIP_TEXT_FONTS.hook.file))) return dir;
  }
  throw new ClipFontError(
    `clip fonts directory not found (looked in ${candidates.join(", ")}) — assets/clip-fonts must ship with the deploy (serverless: add it to the tick route's traced files, the ffmpeg-static precedent)`
  );
}

/**
 * Minimal TTF `name`-table reader: family names (nameID 1) + typographic
 * family (nameID 16). Dependency-free by design (the imageMeta.ts magic-byte
 * precedent) — enough to assert the bundled files really carry the families
 * the ASS styles reference.
 */
export function parseTtfFamilies(bytes: Buffer): string[] {
  const families = new Set<string>();
  if (bytes.length < 12) return [];
  const numTables = bytes.readUInt16BE(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.length) break;
    if (bytes.toString("ascii", rec, rec + 4) === "name") {
      nameOffset = bytes.readUInt32BE(rec + 8);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + 6 > bytes.length) return [];
  const count = bytes.readUInt16BE(nameOffset + 2);
  const stringsAt = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > bytes.length) break;
    const platformId = bytes.readUInt16BE(rec);
    const nameId = bytes.readUInt16BE(rec + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = bytes.readUInt16BE(rec + 8);
    const offset = stringsAt + bytes.readUInt16BE(rec + 10);
    if (offset + length > bytes.length) continue;
    if (platformId === 3 || platformId === 0) {
      // UTF-16BE
      let s = "";
      for (let j = 0; j + 1 < length; j += 2) s += String.fromCharCode(bytes.readUInt16BE(offset + j));
      families.add(s);
    } else {
      families.add(bytes.toString("latin1", offset, offset + length));
    }
  }
  return [...families];
}

let asserted: { dir: string } | null = null;

/**
 * The T-1 startup assertion, run before every burn (cached after first
 * success): every bundled file exists AND carries the family name its style
 * constant references. Throws ClipFontError with the remedy.
 */
export function assertClipFontsResolvable(): { dir: string } {
  if (asserted) return asserted;
  const dir = clipFontsDir();
  const entries = [
    CLIP_TEXT_FONTS.hook,
    CLIP_TEXT_FONTS.hookAlt,
    CLIP_TEXT_FONTS.caption,
    CLIP_TEXT_FONTS.captionAlt,
  ];
  for (const { family, file } of entries) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      throw new ClipFontError(
        `bundled clip font missing: ${path} — restore assets/clip-fonts (committed to the repo; see docs/clips.md § Burned text)`
      );
    }
    const families = parseTtfFamilies(readFileSync(path));
    if (!families.includes(family)) {
      throw new ClipFontError(
        `font file ${file} does not contain family "${family}" (found: ${families.join(", ") || "none"}) — the ASS styles would silently fall back (T-1 release blocker)`
      );
    }
  }
  for (const lic of CLIP_FONT_LICENSE_FILES) {
    if (!existsSync(join(dir, lic))) {
      throw new ClipFontError(`font license file missing: ${lic} — OFL requires the license to ship with the fonts`);
    }
  }
  asserted = { dir };
  return asserted;
}

/** Test seam: forget the cached assertion. */
export function resetClipFontAssertion(): void {
  asserted = null;
}
