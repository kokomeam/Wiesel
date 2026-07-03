/**
 * Step 2 of the pipeline: rasterize each PDF page to a full-size PNG plus a
 * lightweight thumbnail, using Poppler's `pdftoppm`. Two passes at two DPIs
 * avoids pulling in an image-resize dependency.
 *
 * `pngDimensions` is a pure IHDR reader (no deps) so page width/height are
 * captured without decoding the image — it's exported + unit-tested.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { commandExists, run, WorkerError } from "./shell";

function pdftoppmBin(): string {
  return process.env.PDFTOPPM_BIN || "pdftoppm";
}

export interface RenderedPage {
  pageNumber: number;
  imageBytes: Uint8Array;
  thumbBytes: Uint8Array | null;
  width: number | null;
  height: number | null;
}

export async function renderPdfPages(args: {
  pdfPath: string;
  workDir: string;
  fullDpi?: number;
  thumbDpi?: number;
}): Promise<RenderedPage[]> {
  const { pdfPath, workDir } = args;
  const fullDpi = args.fullDpi ?? Number(process.env.DECK_IMPORT_FULL_DPI ?? 150);
  const thumbDpi = args.thumbDpi ?? Number(process.env.DECK_IMPORT_THUMB_DPI ?? 42);

  const bin = pdftoppmBin();
  if (!(await commandExists(bin))) {
    throw new WorkerError(
      "pdftoppm (poppler-utils) not installed",
      "Preview tools are unavailable on the server."
    );
  }

  const fullDir = path.join(workDir, "full");
  const thumbDir = path.join(workDir, "thumb");
  await mkdir(fullDir, { recursive: true });
  await mkdir(thumbDir, { recursive: true });

  await run(bin, ["-png", "-r", String(fullDpi), pdfPath, path.join(fullDir, "page")], {
    timeoutMs: 300_000,
  });
  await run(bin, ["-png", "-r", String(thumbDpi), pdfPath, path.join(thumbDir, "page")], {
    timeoutMs: 300_000,
  });

  const fulls = await collectPages(fullDir);
  if (fulls.length === 0) {
    throw new WorkerError("pdftoppm produced no pages", "We couldn't render this deck's pages.");
  }
  const thumbs = await collectPages(thumbDir);
  const thumbByPage = new Map(thumbs.map((t) => [t.page, t.file]));

  const pages: RenderedPage[] = [];
  for (const f of fulls) {
    const imageBytes = new Uint8Array(await readFile(f.file));
    const dim = pngDimensions(imageBytes);
    const thumbFile = thumbByPage.get(f.page);
    const thumbBytes = thumbFile ? new Uint8Array(await readFile(thumbFile)) : null;
    pages.push({
      pageNumber: f.page,
      imageBytes,
      thumbBytes,
      width: dim?.width ?? null,
      height: dim?.height ?? null,
    });
  }
  return pages;
}

/** Collect `*-<n>.png` files from a dir, parsed + sorted NUMERICALLY by page. */
async function collectPages(dir: string): Promise<{ page: number; file: string }[]> {
  const names = await readdir(dir);
  const out: { page: number; file: string }[] = [];
  for (const name of names) {
    const m = name.match(/-(\d+)\.png$/);
    if (m) out.push({ page: parseInt(m[1], 10), file: path.join(dir, name) });
  }
  return out.sort((a, b) => a.page - b.page);
}

/**
 * Read a PNG's pixel dimensions straight from its IHDR chunk — no image decode,
 * no dependency. Returns null if the bytes aren't a valid PNG header.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR: [8..12) length, [12..16) "IHDR", [16..20) width, [20..24) height
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}
