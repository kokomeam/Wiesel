/**
 * Job seam between the request side (enqueue) and the conversion worker.
 *
 * The whole point of this indirection is the hard rule: heavy PPT/PDF conversion
 * must NOT run inside a Next.js request handler. Routes only mark a job as
 * needing work; a separate process (`npm run worker:deck-imports`) does the
 * conversion. Swapping in a real durable queue later touches only this file.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { markProcessing } from "./deckImportService";
import type { DeckImportRow } from "./deckImportTypes";

type DB = SupabaseClient<Database>;

export interface DeckImportJob {
  deckImportId: string;
}

/**
 * Enqueue a deck import for processing.
 *
 * v1 transport: there is no external queue, so "enqueue" transitions the row to
 * `processing` (idempotent) and returns. A separate worker polls for
 * `status = 'processing'` rows and converts them, keeping LibreOffice/Poppler
 * work off the request path.
 *
 * Production: replace the marked TODO with a durable publish (Supabase PGMQ /
 * SQS / QStash / Postgres NOTIFY). The signature is stable, so callers and the
 * worker's claim loop don't change.
 */
export async function enqueueDeckImportJob(supabase: DB, row: DeckImportRow): Promise<string | null> {
  const res = await markProcessing(supabase, row);
  if ("error" in res) return res.error;
  // TODO(prod): publish { deckImportId: row.id } to a durable queue here.
  return null;
}

/**
 * Worker side: claim the next batch of pending jobs (oldest first). Uses a
 * service-role client so it sees rows across all authors.
 *
 * This is a simple poll, not an atomic lease — correct for a SINGLE worker. To
 * scale to several workers, add a `claimed_at` / `worker_id` lease and switch to
 * a `... for update skip locked` claim (see workers/deck-import/README.md).
 */
export async function claimProcessingDeckImports(admin: DB, limit = 5): Promise<DeckImportRow[]> {
  const { data, error } = await admin
    .from("deck_imports")
    .select("*")
    .eq("status", "processing")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error || !data) return [];
  return data;
}
