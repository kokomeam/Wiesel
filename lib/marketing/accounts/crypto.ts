/**
 * Encryption-at-rest for provider profile refs — SERVER ONLY (never import
 * from client code; verify-accounts enforces the import fence and the bundle
 * scan asserts nothing leaks). AES-256-GCM via node:crypto, key from
 * SOCIAL_ACCOUNTS_ENC_KEY (32 bytes, base64). There is deliberately NO
 * insecure dev fallback: with the key unset, account linking is disabled
 * with a clear message (the lib/comms/tokens.ts throw-don't-degrade
 * precedent — a silently-plaintext profile ref would defeat the point).
 *
 * Ciphertext format: `v1.<iv b64url>.<tag b64url>.<ct b64url>` — versioned
 * so a future key/algorithm rotation can coexist with old rows.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";

function keyBytes(): Buffer {
  const raw = process.env.SOCIAL_ACCOUNTS_ENC_KEY;
  if (!raw) {
    throw new Error(
      "SOCIAL_ACCOUNTS_ENC_KEY is not set — account linking requires the encryption key (32 bytes, base64)."
    );
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      `SOCIAL_ACCOUNTS_ENC_KEY must decode to exactly 32 bytes (got ${key.length}) — generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

export function isEncryptionConfigured(): boolean {
  try {
    keyBytes();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(enc: string): string {
  const [version, ivB64, tagB64, ctB64] = enc.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("unrecognized ciphertext format for SOCIAL_ACCOUNTS_ENC_KEY material");
  }
  const decipher = createDecipheriv(ALGO, keyBytes(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}
