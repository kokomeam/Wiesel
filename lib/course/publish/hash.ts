/**
 * Deterministic content hashing for publications — PURE + isomorphic.
 *
 * `stableStringify` serializes with sorted object keys so the same logical
 * content always yields the same string regardless of key insertion order
 * (the DB round-trip reorders keys). Hashing uses WebCrypto's SHA-256, which
 * is the SAME API in the browser (`crypto.subtle`) and Node ≥18
 * (`globalThis.crypto.subtle`) — so the studio can compute the draft hash
 * client-side for the live "unpublished draft changes" indicator and get a
 * byte-identical result to the server's published `content_hash`.
 */

/** JSON.stringify with recursively sorted object keys. `undefined` values are
 *  dropped (exactly like JSON.stringify), so `{a: undefined}` === `{}`. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((k) => record[k] !== undefined)
        .map((k) => [k, sortKeysDeep(record[k])])
    );
  }
  return value;
}

/** SHA-256 of a UTF-8 string as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The publication content hash: sha256 over BOTH the client-visible snapshot
 * AND the stripped answer keys, so changing only a correct answer still counts
 * as a draft change / new version.
 */
export async function computeContentHash(
  snapshot: unknown,
  answerKeys: unknown
): Promise<string> {
  return sha256Hex(stableStringify({ answerKeys, snapshot }));
}
