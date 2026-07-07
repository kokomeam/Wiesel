/**
 * Image metadata sniffing — pure, dependency-free (the 15-runtime-deps
 * invariant). The finalize endpoint (PRD §15) validates content-type by MAGIC
 * BYTES (never trusting the client's header) and reads pixel dimensions for
 * the soft platform-norm warning. Supports exactly the allowed upload types:
 * PNG, JPEG, WebP (lossy VP8, lossless VP8L, extended VP8X).
 */

export interface ImageMeta {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}
function ascii(b: Uint8Array, o: number, len: number): string {
  return String.fromCharCode(...b.subarray(o, o + len));
}

function parsePng(b: Uint8Array): ImageMeta | null {
  // 8-byte signature, then the IHDR chunk: length(4) + "IHDR"(4) + w(4) + h(4)
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return null;
  if (ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function parseJpeg(b: Uint8Array): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1];
    // Standalone markers without a length segment.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01 || marker === 0xff) {
      o += 2;
      continue;
    }
    const len = u16be(b, o + 2);
    // SOF0–SOF15 except DHT(C4)/JPGA(C8)/DAC(CC) carry dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: "image/jpeg", width: u16be(b, o + 7), height: u16be(b, o + 5) };
    }
    o += 2 + len;
  }
  return null;
}

function parseWebp(b: Uint8Array): ImageMeta | null {
  if (b.length < 30) return null;
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  const p = 20; // chunk payload start
  if (chunk === "VP8 ") {
    // Lossy: 3-byte frame tag, then 3-byte start code 9D 01 2A, then dims (14 bits each).
    if (b[p + 3] !== 0x9d || b[p + 4] !== 0x01 || b[p + 5] !== 0x2a) return null;
    return {
      mime: "image/webp",
      width: u16le(b, p + 6) & 0x3fff,
      height: u16le(b, p + 8) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (b[p] !== 0x2f) return null;
    const bits = b[p + 1] | (b[p + 2] << 8) | (b[p + 3] << 16) | (b[p + 4] << 24);
    return {
      mime: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    // Payload: 4 bytes flags/reserved, then canvas width-1 and height-1 (24-bit LE).
    return {
      mime: "image/webp",
      width: u24le(b, p + 4) + 1,
      height: u24le(b, p + 7) + 1,
    };
  }
  return null;
}

/** Parse mime + dimensions from raw bytes. Null = not a supported image. */
export function parseImageMeta(bytes: Uint8Array): ImageMeta | null {
  return parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes) ?? null;
}

/**
 * Soft platform-norm check (PRD §15): warn when the image is far from the
 * platform's recommended dimensions — NEVER a block. "Far" = aspect ratio off
 * by >25% or the width under half the recommendation.
 */
export function imageNormWarning(
  meta: { width: number; height: number },
  norm: { width: number; height: number },
  platformLabel: string
): string | null {
  if (meta.width <= 0 || meta.height <= 0) return null;
  const ratio = meta.width / meta.height;
  const normRatio = norm.width / norm.height;
  const ratioOff = Math.abs(ratio - normRatio) / normRatio > 0.25;
  const tooSmall = meta.width < norm.width / 2;
  if (!ratioOff && !tooSmall) return null;
  return `This image is ${meta.width}×${meta.height} — ${platformLabel} posts usually look best around ${norm.width}×${norm.height}. It will still work; consider a closer crop if it renders oddly.`;
}
