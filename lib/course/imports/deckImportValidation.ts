/**
 * Imported-deck validation — PURE (no Supabase, no Node APIs). Shared by the
 * upload UI (client-side pre-check) and the upload route (authoritative
 * server-side check), so the two can never disagree.
 *
 * Security posture: we do NOT trust the client-reported MIME type alone. The
 * format is decided by FILE EXTENSION; a present-but-conflicting MIME is
 * rejected, while a missing/generic MIME (browsers often send
 * `application/octet-stream` for .pptx) falls back to the extension. The worker
 * re-validates by actually converting the bytes, so a disguised file ultimately
 * lands in `failed`, not `ready`.
 */

import type { DeckImportStatus } from "@/lib/course/types";

/** Hard server-side ceiling. PPT/PDF decks are image-heavy; 100 MB is generous
 *  without inviting abuse. Enforced in the route, not just the browser. */
export const MAX_DECK_FILE_BYTES = 100 * 1024 * 1024;

export interface DeckImportFormat {
  /** Lower-case extension without the dot. */
  ext: "pdf" | "ppt" | "pptx";
  /** Canonical MIME type(s) a browser may report for this format. */
  mimeTypes: string[];
  /** Human label for the UI. */
  label: string;
  /** PPT/PPTX must be normalized to PDF before rendering; a PDF skips that step. */
  needsPdfNormalize: boolean;
}

export const DECK_IMPORT_FORMATS: DeckImportFormat[] = [
  {
    ext: "pdf",
    mimeTypes: ["application/pdf"],
    label: "PDF",
    needsPdfNormalize: false,
  },
  {
    ext: "pptx",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    label: "PowerPoint (.pptx)",
    needsPdfNormalize: true,
  },
  {
    ext: "ppt",
    mimeTypes: ["application/vnd.ms-powerpoint"],
    label: "PowerPoint (.ppt)",
    needsPdfNormalize: true,
  },
];

/** Accepted extensions, with the dot, for the file input + messaging. */
export const ACCEPTED_EXTENSIONS = DECK_IMPORT_FORMATS.map((f) => `.${f.ext}`);

/** `accept` attribute value for the <input type=file> (extensions + MIME). */
export const DECK_ACCEPT_ATTR = [
  ...ACCEPTED_EXTENSIONS,
  ...DECK_IMPORT_FORMATS.flatMap((f) => f.mimeTypes),
].join(",");

/** MIME types we treat as "unknown" and therefore defer to the extension. */
const GENERIC_MIME = new Set([
  "",
  "application/octet-stream",
  "application/binary",
  "binary/octet-stream",
]);

/** Lower-case extension (no dot) of a filename, or "" if none. */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Make a filename safe for a storage path: strip directory parts, keep a single
 * extension, collapse anything non `[a-z0-9._-]` to `-`, and bound the length.
 * Never returns an empty string.
 */
export function sanitizeFileName(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).trim();
  const dot = base.lastIndexOf(".");
  const rawName = dot > 0 ? base.slice(0, dot) : base;
  const rawExt = dot > 0 ? base.slice(dot + 1) : "";
  const clean = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
  const name = clean(rawName).slice(0, 80) || "deck";
  const ext = clean(rawExt).slice(0, 8);
  return ext ? `${name}.${ext}` : name;
}

/**
 * Derive a friendly deck title from a filename: drop the extension, turn
 * separators into spaces, collapse whitespace, and trim. Falls back to
 * "Imported deck".
 */
export function deriveDeckTitle(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const title = stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title || "Imported deck";
}

/** Resolve the format for a file, honoring the security posture above. Returns
 *  null when the extension is unsupported OR a present MIME conflicts with it. */
export function formatForFile(fileName: string, mimeType: string | null | undefined): DeckImportFormat | null {
  const ext = extensionOf(fileName);
  const format = DECK_IMPORT_FORMATS.find((f) => f.ext === ext);
  if (!format) return null;
  const mime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (GENERIC_MIME.has(mime)) return format; // unknown MIME → trust the extension
  return format.mimeTypes.includes(mime) ? format : null; // conflicting MIME → reject
}

export type UploadValidation =
  | { ok: true; format: DeckImportFormat }
  | { ok: false; error: string };

/** Authoritative upload validation: extension/MIME agreement + size bounds. */
export function validateUpload(input: {
  fileName: string;
  mimeType: string | null | undefined;
  size: number;
}): UploadValidation {
  const { fileName, mimeType, size } = input;
  if (!fileName || !fileName.trim()) {
    return { ok: false, error: "The file has no name." };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: "The file appears to be empty." };
  }
  if (size > MAX_DECK_FILE_BYTES) {
    return {
      ok: false,
      error: `That file is ${formatBytes(size)} — the limit is ${formatBytes(MAX_DECK_FILE_BYTES)}.`,
    };
  }
  const format = formatForFile(fileName, mimeType);
  if (!format) {
    return {
      ok: false,
      error: `Unsupported file. Upload a PowerPoint (.ppt, .pptx) or PDF.`,
    };
  }
  return { ok: true, format };
}

/** Compact human file size (1 decimal for MB/GB). Pure + deterministic. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/* ─────────────────────────── status transitions ───────────────────────── */

/** Legal forward transitions of the processing lifecycle. A self-transition is
 *  always allowed (idempotent writes). */
const DECK_IMPORT_TRANSITIONS: Record<DeckImportStatus, DeckImportStatus[]> = {
  uploaded: ["processing", "failed"],
  processing: ["ready", "failed"],
  ready: ["processing"], // replace / re-render
  failed: ["processing"], // retry
};

export function canTransition(from: DeckImportStatus, to: DeckImportStatus): boolean {
  return from === to || DECK_IMPORT_TRANSITIONS[from].includes(to);
}

/** All statuses (handy for tests + exhaustiveness). */
export const DECK_IMPORT_STATUSES: DeckImportStatus[] = [
  "uploaded",
  "processing",
  "ready",
  "failed",
];
