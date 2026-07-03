/**
 * PURE WebVTT helpers (no fetch, no DOM): parse a caption track into timed cues,
 * derive a plain transcript, and pick the active cue for a given playback time.
 *
 * Used both server-side (deriving the plain transcript we store on the row from
 * the Mux-generated VTT) and client-side (rendering a synced caption overlay on
 * the trim-aware preview player). Kept pure so it's trivially unit-testable with
 * no key/DB/browser (see scripts/verify-video.ts).
 */

export interface CaptionCue {
  /** Cue start/end in seconds (absolute source time). */
  start: number;
  end: number;
  text: string;
}

/** Parse a `HH:MM:SS.mmm` / `MM:SS.mmm` WebVTT timestamp into seconds. */
function parseTimestamp(ts: string): number | null {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return hours * 3600 + mins * 60 + secs + ms / 1000;
}

/** Strip inline WebVTT markup: <c.classes>, <v Speaker>, <00:00:01.000>, </c>. */
function stripCueTags(line: string): string {
  return line.replace(/<[^>]+>/g, "").trim();
}

/**
 * Parse a WebVTT document into cues. Tolerant: ignores the header, NOTE/STYLE/
 * REGION blocks, optional numeric cue ids, and cue settings after the timing line.
 * Returns [] for null/empty/garbage input (never throws).
 */
export function parseVtt(vtt: string | null | undefined): CaptionCue[] {
  if (!vtt || typeof vtt !== "string") return [];
  const normalized = vtt.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: CaptionCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    // Find the timing line ("start --> end [settings]") — it may be the 1st line
    // or the 2nd (after a numeric/textual cue identifier).
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue; // header / NOTE / STYLE / REGION → skip
    const timing = lines[timingIdx];
    const [startRaw, rest] = timing.split("-->");
    if (rest === undefined) continue;
    const endRaw = rest.trim().split(/\s+/)[0]; // drop cue settings
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (start == null || end == null) continue;
    const text = lines
      .slice(timingIdx + 1)
      .map(stripCueTags)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

/**
 * Derive a readable plain transcript from a WebVTT track. Joins cue text in order,
 * skipping a cue whose text exactly repeats the previous one (rolling-caption
 * artifact). This is what we persist as the searchable/AI-usable transcript.
 */
export function plainTextFromVtt(vtt: string | null | undefined): string {
  const cues = parseVtt(vtt);
  const parts: string[] = [];
  let prev = "";
  for (const cue of cues) {
    if (cue.text === prev) continue;
    parts.push(cue.text);
    prev = cue.text;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** The cue text active at `timeSeconds` (absolute source time), or null. */
export function activeCaption(cues: CaptionCue[], timeSeconds: number): string | null {
  if (!cues.length) return null;
  // Cues are in order; a small linear scan is fine (a lecture has hundreds, not
  // millions). Return the last cue that contains the time (handles slight overlap).
  let active: string | null = null;
  for (const cue of cues) {
    if (timeSeconds >= cue.start && timeSeconds < cue.end) active = cue.text;
    else if (cue.start > timeSeconds) break;
  }
  return active;
}
