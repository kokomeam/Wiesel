/**
 * TUTOR-1 Amendment A2 Wave 2 — the PROSE EXTRACTOR (the R-2 design). PURE.
 *
 * The tutor model streams its whole turn as ONE structured-JSON string (the
 * `TurnOutputSchema` shape), delivered to the route as raw `text_delta` chunks.
 * The learner-visible text is the STRING VALUE of the FIRST field,
 * `"proseWithSpanMarkers"` (confirmed first in outputContract.ts). This module is
 * a small incremental scanner that, given those raw deltas, yields ONLY the
 * decoded, marker-stripped prose — safe to display token-by-token — and nothing
 * else (citations / rung / evidence that follow the prose emit nothing).
 *
 * It solves four problems that ONLY appear when you decode a streamed JSON string:
 *
 *   (1) FIELD SCAN — find `"proseWithSpanMarkers"`, its `:` and opening quote, then
 *       read the string value up to (not including) its closing quote. A stream
 *       that never contains the key emits "" forever (junk-safe).
 *   (2) JSON ESCAPES — decode `\" \\ \/ \n \t \r \b \f \uXXXX` as they arrive,
 *       holding back an INCOMPLETE trailing escape (a lone `\`, or `\u` with < 4
 *       hex digits) across push() boundaries so half an escape never reaches the
 *       learner.
 *   (3) SPAN MARKERS — strip the four markers ⟦g⟧ ⟦/g⟧ ⟦s⟧ ⟦/s⟧ (imported from
 *       outputContract — never hardcoded), INCLUDING when a marker is split across
 *       two pushes: any suffix that is a strict prefix of a marker is held back
 *       until the next push disambiguates it. Markers are multi-CODE-UNIT (⟦ is
 *       U+27E6, one UTF-16 unit; the tag chars are ASCII) — we operate on JS string
 *       code units via ordinary string ops, never bytes.
 *   (4) END OF VALUE — the first UNESCAPED `"` closes the string; from there push()
 *       returns "" forever and done() is a no-op.
 *
 * push(rawDelta) returns the newly-safe-to-display plain prose (may be ""); the
 * caller concatenates the returns. O(n) in the total stream length.
 */

import {
  GROUNDED_OPEN,
  GROUNDED_CLOSE,
  SUPPLEMENTAL_OPEN,
  SUPPLEMENTAL_CLOSE,
} from "./outputContract";

/** The four span markers to strip, longest FIRST (so a longer marker matches
 *  before a shorter one that is its prefix — e.g. `⟦/g⟧` before `⟦g⟧`-style
 *  ambiguity; none of the four is a prefix of another, but ordering by length is
 *  the safe convention). Imported from the frozen contract — never hardcoded. */
const MARKERS: string[] = [GROUNDED_CLOSE, SUPPLEMENTAL_CLOSE, GROUNDED_OPEN, SUPPLEMENTAL_OPEN].sort(
  (a, b) => b.length - a.length
);

/** The scan phase. */
type Phase = "seeking_key" | "seeking_value" | "in_value" | "done";

/** The literal key whose value carries the prose. */
const PROSE_KEY = '"proseWithSpanMarkers"';

/** Is `s` a strict, non-empty PREFIX of `marker` (i.e. `s` could still grow into
 *  `marker`)? A full marker is NOT a strict prefix (it's a complete match, handled
 *  separately). */
function isStrictMarkerPrefix(s: string): boolean {
  if (s.length === 0) return false;
  return MARKERS.some((m) => m.length > s.length && m.startsWith(s));
}

export interface ProseExtractor {
  /** Feed one raw JSON delta; returns the newly-safe-to-display plain prose. */
  push(rawDelta: string): string;
  /** Signal the stream ended. A no-op today (a held-back marker/escape prefix at
   *  end-of-stream is discarded rather than emitted — it was never a real char). */
  done(): void;
}

/**
 * Create an incremental prose extractor. Dependency-free, O(n), never throws.
 */
export function createProseExtractor(): ProseExtractor {
  let phase: Phase = "seeking_key";

  // (1) Field scan — a small buffer of raw text we haven't yet located the key/
  //     value-open in. Kept bounded: we only need the tail long enough to match
  //     the key across a chunk boundary, but keeping it simple (append + search +
  //     truncate on match) is O(n) amortized for our stream sizes.
  let rawBuf = "";

  // (2) JSON escape — a held-back incomplete escape sequence (starts with `\`).
  let pendingEscape = "";

  // (3) Marker strip — decoded text held back because it might be the start of a
  //     marker split across pushes.
  let pendingMarker = "";

  /** Decode the value-region raw text (already past the opening quote) into plain
   *  characters, honoring JSON escapes and stopping at the first UNESCAPED `"`.
   *  Returns the decoded chars produced AND whether the closing quote was hit.
   *  Holds an incomplete trailing escape in `pendingEscape` for the next push. */
  function decodeValueChunk(chunk: string): { decoded: string; closed: boolean } {
    const src = pendingEscape + chunk;
    pendingEscape = "";
    let out = "";
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") {
        // An escape sequence. Need at least the escape char after the backslash.
        if (i + 1 >= src.length) {
          pendingEscape = src.slice(i); // lone trailing backslash — hold it
          break;
        }
        const esc = src[i + 1];
        if (esc === "u") {
          // \uXXXX — need 4 hex digits after the `u`.
          if (i + 6 > src.length) {
            pendingEscape = src.slice(i); // incomplete \uXXXX — hold it
            break;
          }
          const hex = src.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          out += Number.isNaN(code) ? "" : String.fromCharCode(code);
          i += 6;
          continue;
        }
        // Single-char escapes.
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "n":
            out += "\n";
            break;
          case "t":
            out += "\t";
            break;
          case "r":
            out += "\r";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          default:
            // Unknown escape — emit the escaped char verbatim (lenient).
            out += esc;
            break;
        }
        i += 2;
        continue;
      }
      if (ch === '"') {
        // The UNESCAPED closing quote of the string value.
        return { decoded: out, closed: true };
      }
      out += ch;
      i += 1;
    }
    return { decoded: out, closed: false };
  }

  /** Strip span markers from `decoded`, holding back a trailing marker-prefix.
   *  Prepends `pendingMarker` (a suffix held from the previous push). Returns the
   *  safe-to-emit text; leaves any still-ambiguous suffix in `pendingMarker`. */
  function stripMarkers(decoded: string): string {
    let work = pendingMarker + decoded;
    pendingMarker = "";
    let out = "";
    let i = 0;
    while (i < work.length) {
      // Try to match a full marker starting at i.
      let matched = false;
      for (const m of MARKERS) {
        if (work.startsWith(m, i)) {
          i += m.length; // drop the marker entirely
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Could the remaining tail be a strict prefix of a marker? If the ENTIRE
      // remainder from i is a strict marker prefix, hold it and stop.
      const tail = work.slice(i);
      if (isStrictMarkerPrefix(tail)) {
        pendingMarker = tail;
        work = "";
        break;
      }
      out += work[i];
      i += 1;
    }
    return out;
  }

  return {
    push(rawDelta: string): string {
      if (phase === "done") return "";
      if (typeof rawDelta !== "string" || rawDelta.length === 0) return "";

      let valueRegion = "";

      // (1) Locate the key + opening quote if we haven't yet. Everything after the
      //     opening quote (in THIS push) becomes the initial value region.
      if (phase !== "in_value") {
        rawBuf += rawDelta;

        if (phase === "seeking_key") {
          const keyIdx = rawBuf.indexOf(PROSE_KEY);
          if (keyIdx === -1) {
            // Not found yet. Keep only a tail that could still complete the key on
            // the next push (bounded), and emit nothing.
            const keep = PROSE_KEY.length - 1;
            if (rawBuf.length > keep) rawBuf = rawBuf.slice(rawBuf.length - keep);
            return "";
          }
          // Found the key — advance past it and seek the value's opening quote.
          rawBuf = rawBuf.slice(keyIdx + PROSE_KEY.length);
          phase = "seeking_value";
        }

        if (phase === "seeking_value") {
          // Skip `:` + whitespace, then require the opening quote.
          const quoteIdx = rawBuf.indexOf('"');
          if (quoteIdx === -1) {
            // No opening quote yet (still whitespace/`:`); keep a small tail.
            if (rawBuf.length > 8) rawBuf = rawBuf.slice(rawBuf.length - 8);
            return "";
          }
          // Everything after the opening quote is the start of the value.
          valueRegion = rawBuf.slice(quoteIdx + 1);
          rawBuf = "";
          phase = "in_value";
        }
      } else {
        valueRegion = rawDelta;
      }

      if (phase !== "in_value") return "";

      // (2) Decode JSON escapes; (4) stop at the closing quote.
      const { decoded, closed } = decodeValueChunk(valueRegion);
      // (3) Strip markers, holding a split-marker prefix.
      const emitted = stripMarkers(decoded);

      if (closed) {
        // The value ended. Flush any held-back marker prefix that turned out NOT to
        // be a marker is impossible to disambiguate now — but a genuine partial
        // marker at the very end of the string value is unusual; we drop it (the
        // markers are stripped output either way). Any pending escape at close is
        // discarded (a well-formed stream never closes mid-escape).
        pendingMarker = "";
        pendingEscape = "";
        phase = "done";
      }

      // Guard: emitted may be "" (all held back / all markers).
      if (emitted.length === 0) return "";
      return emitted;
    },

    done(): void {
      // No-op: any held-back marker/escape prefix at end-of-stream was never a
      // complete, real character, so it is intentionally NOT emitted. Idempotent.
      phase = "done";
      pendingMarker = "";
      pendingEscape = "";
      rawBuf = "";
    },
  };
}
