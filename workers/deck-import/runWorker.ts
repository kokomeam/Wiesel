/**
 * Deck-import worker entry point — `npm run worker:deck-imports`.
 *
 *   npm run worker:deck-imports                 # poll loop (dev + prod stub)
 *   npm run worker:deck-imports -- <deckImportId>  # process one job and exit
 *
 * Requires a Supabase URL (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL) + a
 * privileged server-side key (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY)
 * and LibreOffice + Poppler on PATH. The poll loop is the v1 transport;
 * production swaps `claimProcessingDeckImports` for a durable queue consumer
 * (see README). Single-worker by design — see the lease note.
 */

// MUST be first: tsx doesn't auto-load .env.local, so this populates process.env
// before any import below reads it (see ./loadEnv).
import { loadedEnvFileNames } from "./loadEnv";

import { createAdminClient, supabaseEnvStatus } from "@/lib/supabase/admin";
import { claimProcessingDeckImports } from "@/lib/course/imports/deckImportJobs";
import { processDeckImport } from "./processDeckImport";

const POLL_MS = Number(process.env.DECK_IMPORT_POLL_MS ?? 4000);
const BATCH = Number(process.env.DECK_IMPORT_BATCH ?? 3);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function logStartupEnv() {
  const envFiles = loadedEnvFileNames.length ? loadedEnvFileNames.join(", ") : "(none)";
  console.log(`[deck-import worker] loaded env files: ${envFiles}`);
  const status = supabaseEnvStatus();
  // Booleans only — never print secret values.
  const summary = Object.entries(status)
    .map(([name, set]) => `${name}=${set ? "set" : "MISSING"}`)
    .join(", ");
  console.log(`[deck-import worker] env: ${summary}`);
  const hasUrl = status.NEXT_PUBLIC_SUPABASE_URL || status.SUPABASE_URL;
  const hasKey = status.SUPABASE_SERVICE_ROLE_KEY || status.SUPABASE_SECRET_KEY;
  if (!hasUrl) {
    console.log("[deck-import worker] → no Supabase URL (need NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL).");
  }
  if (!hasKey) {
    console.log(
      "[deck-import worker] → no privileged key (need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY)."
    );
  }
}

async function main() {
  logStartupEnv();

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    console.error(`[deck-import worker] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // One-shot mode: process a specific id (handy for retries + debugging).
  const id = process.argv[2];
  if (id) {
    console.log(`[deck-import worker] processing ${id}`);
    await processDeckImport(id, { admin });
    return;
  }

  console.log(`[deck-import worker] polling every ${POLL_MS}ms (batch ${BATCH}) — Ctrl-C to stop`);
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    let jobs;
    try {
      jobs = await claimProcessingDeckImports(admin, BATCH);
    } catch (err) {
      console.error(`[deck-import worker] claim failed: ${err instanceof Error ? err.message : err}`);
      await sleep(POLL_MS);
      continue;
    }
    if (jobs.length === 0) {
      await sleep(POLL_MS);
      continue;
    }
    for (const job of jobs) {
      if (!running) break;
      await processDeckImport(job.id, { admin });
    }
  }
  console.log("[deck-import worker] stopped");
}

void main();
