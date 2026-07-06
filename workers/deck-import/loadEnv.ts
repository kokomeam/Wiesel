/**
 * Loads `.env.local` (and the rest of Next's env files) for the standalone
 * deck-import worker.
 *
 * `tsx workers/deck-import/runWorker.ts` runs as a plain Node process, so —
 * unlike the Next dev server / build — NOTHING loads `.env*` automatically.
 * Without this, `process.env.NEXT_PUBLIC_SUPABASE_URL` (and friends) are
 * undefined even when `.env.local` is on disk, and the worker exits with
 * "Supabase URL is not set".
 *
 * This is a SIDE-EFFECT module: importing it loads the env. It MUST be the
 * FIRST import in `runWorker.ts` so the env is populated before any module
 * that reads `process.env` is evaluated. Keep it dependency-free (only
 * `@next/env`) so importing it can't pull in an env-reader first.
 */
import { loadEnvConfig } from "@next/env";

const dev = process.env.NODE_ENV !== "production";
const { loadedEnvFiles } = loadEnvConfig(process.cwd(), dev);

/** Basenames of the `.env*` files that were actually loaded (for startup logging). */
export const loadedEnvFileNames: string[] = loadedEnvFiles.map((f) =>
  f.path.split("/").pop() ?? f.path
);
