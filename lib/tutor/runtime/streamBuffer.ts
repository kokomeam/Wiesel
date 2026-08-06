/**
 * TUTOR-1 Amendment A2 Wave 1 — the RESUME-BUFFER seam.
 *
 * A tutor SSE stream's frames are appended here as they are produced so a client
 * that reconnects mid-turn can replay from where it dropped. Frames are the raw
 * SSE strings (`encodeWireEvent(...)` output); the buffer is agnostic to their
 * shape. Two backends implement ONE interface:
 *   • createInMemoryStreamBuffer — Map-backed, TTL via an injectable clock; used
 *     by dev + the pure tests.
 *   • createUpstashStreamBuffer  — Upstash Redis over the REST API (fetch, NO
 *     SDK — the lib/comms Resend precedent). Each stream is a Redis LIST at
 *     `<prefix><streamId>:frames` (+ a `<prefix><streamId>:done` marker), every
 *     write carries an EXPLICIT EXPIRE (directive: never rely on a package's
 *     default TTL).
 *
 * DEV DEGRADE: `streamBufferFromEnv` returns null when the Upstash env is unset —
 * streaming still WORKS (frames flow straight to the client), only mid-turn
 * RESUME is unavailable. The route must treat a null buffer as "no resume", never
 * as an error.
 */

/** Key namespace for every tutor stream buffer key. */
export const TUTOR_STREAM_KEY_PREFIX = "wisesel:tutor:";

/** The default frame-buffer TTL. EXPLICIT (directive forbids relying on a
 *  package/backend default); overridable via TUTOR_STREAM_TTL_SECONDS. */
export const DEFAULT_TUTOR_STREAM_TTL_SECONDS = 600;

/** The resume-buffer seam. `frame` is the raw SSE string. `read(from)` returns
 *  the frames at index ≥ `fromIndex`, the next index to read from, and whether
 *  the stream has been finalized (no more frames will arrive). */
export interface TutorStreamBuffer {
  append(streamId: string, frame: string): Promise<void>;
  read(
    streamId: string,
    fromIndex: number
  ): Promise<{ frames: string[]; nextIndex: number; finalized: boolean }>;
  finalize(streamId: string): Promise<void>;
}

/* ─────────────────────────────── keys ───────────────────────────────────── */

function framesKey(streamId: string): string {
  return `${TUTOR_STREAM_KEY_PREFIX}${streamId}:frames`;
}
function doneKey(streamId: string): string {
  return `${TUTOR_STREAM_KEY_PREFIX}${streamId}:done`;
}

/* ─────────────────────────── in-memory backend ──────────────────────────── */

interface MemEntry {
  frames: string[];
  finalized: boolean;
  /** Epoch ms after which the entry is expired (absent). */
  expiresAt: number;
}

/**
 * Map-backed buffer honoring TTL via the injectable clock. A read of an
 * absent/expired stream is `{ frames: [], nextIndex: 0, finalized: false }` (an
 * absent stream is indistinguishable from an empty one — the caller falls back
 * to a fresh connection). Dev/test only.
 */
export function createInMemoryStreamBuffer(opts?: {
  ttlSeconds?: number;
  now?: () => number;
}): TutorStreamBuffer {
  const ttlMs = (opts?.ttlSeconds ?? DEFAULT_TUTOR_STREAM_TTL_SECONDS) * 1000;
  const now = opts?.now ?? Date.now;
  const store = new Map<string, MemEntry>();

  /** Return the LIVE entry, or undefined if absent/expired (and evict it). */
  function live(streamId: string): MemEntry | undefined {
    const entry = store.get(streamId);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      store.delete(streamId);
      return undefined;
    }
    return entry;
  }

  return {
    async append(streamId, frame) {
      const entry = live(streamId) ?? { frames: [], finalized: false, expiresAt: 0 };
      entry.frames.push(frame);
      entry.expiresAt = now() + ttlMs; // every write refreshes the TTL
      store.set(streamId, entry);
    },
    async read(streamId, fromIndex) {
      const entry = live(streamId);
      if (!entry) return { frames: [], nextIndex: 0, finalized: false };
      const start = Math.max(0, fromIndex);
      const frames = entry.frames.slice(start);
      return { frames, nextIndex: entry.frames.length, finalized: entry.finalized };
    },
    async finalize(streamId) {
      const entry = live(streamId) ?? { frames: [], finalized: false, expiresAt: 0 };
      entry.finalized = true;
      entry.expiresAt = now() + ttlMs;
      store.set(streamId, entry);
    },
  };
}

/* ─────────────────────────── Upstash REST backend ───────────────────────── */

type FetchImpl = typeof fetch;

interface UpstashResult {
  result?: unknown;
  error?: string;
}

/**
 * Upstash Redis over the REST API — fetch, NO SDK. A single command is
 * `POST {url}/pipeline` with a JSON array body `[["CMD","arg",...], ...]`
 * returning `[{result},...]`; we use the pipeline endpoint uniformly (even a
 * single logical op) so append/finalize are ONE round-trip with their EXPIRE.
 *
 * Keys: `<prefix><streamId>:frames` (a Redis LIST) + `<prefix><streamId>:done`.
 * Every write sets an EXPLICIT EXPIRE = `ttlSeconds`.
 */
export function createUpstashStreamBuffer(opts: {
  url: string;
  token: string;
  ttlSeconds: number;
  fetchImpl?: FetchImpl;
}): TutorStreamBuffer {
  const base = opts.url.replace(/\/+$/, "");
  const ttl = String(opts.ttlSeconds);
  const doFetch = opts.fetchImpl ?? fetch;

  async function pipeline(commands: (string | number)[][]): Promise<UpstashResult[]> {
    const res = await doFetch(`${base}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash pipeline HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = (await res.json().catch(() => null)) as UpstashResult[] | null;
    if (!Array.isArray(parsed)) {
      throw new Error("Upstash pipeline: malformed response (expected an array)");
    }
    for (const item of parsed) {
      if (item && typeof item === "object" && "error" in item && item.error) {
        throw new Error(`Upstash command error: ${item.error}`);
      }
    }
    return parsed;
  }

  return {
    async append(streamId, frame) {
      const key = framesKey(streamId);
      await pipeline([
        ["RPUSH", key, frame],
        ["EXPIRE", key, ttl],
      ]);
    },
    async read(streamId, fromIndex) {
      const key = framesKey(streamId);
      const from = Math.max(0, fromIndex);
      const results = await pipeline([
        ["LRANGE", key, from, -1],
        ["EXISTS", doneKey(streamId)],
      ]);
      const rangeRes = results[0]?.result;
      const frames = Array.isArray(rangeRes) ? rangeRes.map((v) => String(v)) : [];
      const existsRes = results[1]?.result;
      const finalized = Number(existsRes) === 1;
      return { frames, nextIndex: from + frames.length, finalized };
    },
    async finalize(streamId) {
      const key = doneKey(streamId);
      await pipeline([
        ["SET", key, "1"],
        ["EXPIRE", key, ttl],
      ]);
    },
  };
}

/* ─────────────────────────────── factory ────────────────────────────────── */

/** Read the TTL from the env (explicit fallback = the exported default). A
 *  non-positive/garbage value falls back rather than persisting forever. */
function ttlFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.TUTOR_STREAM_TTL_SECONDS;
  if (!raw) return DEFAULT_TUTOR_STREAM_TTL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TUTOR_STREAM_TTL_SECONDS;
}

/**
 * Build the resume buffer from the environment, or null when Upstash is not
 * configured (dev degrade — streaming still works, resume unavailable). Present
 * only when BOTH UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.
 */
export function streamBufferFromEnv(env: NodeJS.ProcessEnv = process.env): TutorStreamBuffer | null {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return createUpstashStreamBuffer({ url, token, ttlSeconds: ttlFromEnv(env) });
}
