/**
 * Service-role Supabase client — SERVER / WORKER ONLY.
 *
 * Bypasses RLS, so it must NEVER be imported into client code or any
 * user-facing request path. It exists for the deck-import worker, which needs to
 * read pending jobs across all authors and write rendered artifacts on their
 * behalf. Keep its blast radius small: only the worker imports this.
 *
 * The privileged key may be EITHER a legacy `service_role` JWT
 * (`SUPABASE_SERVICE_ROLE_KEY`, starts with `eyJ`) OR a new Supabase secret API
 * key (`SUPABASE_SECRET_KEY`, starts with `sb_secret_`). Both are equally
 * privileged server-side; we never validate the prefix.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/** Project URL — public var preferred, server-only `SUPABASE_URL` as fallback. */
function readSupabaseUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
}

/**
 * The privileged server-side key. Either var holds an equally-privileged key;
 * the legacy service-role name wins if both are set. NEVER expose to the client.
 */
function readPrivilegedKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
}

/**
 * Which Supabase env vars are present, WITHOUT exposing their values — for
 * startup logging. Booleans only; never log the secret itself.
 */
export function supabaseEnvStatus(): Record<string, boolean> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    SUPABASE_SECRET_KEY: Boolean(process.env.SUPABASE_SECRET_KEY),
  };
}

export function createAdminClient() {
  const url = readSupabaseUrl();
  const serviceKey = readPrivilegedKey();
  if (!url) {
    throw new Error("Supabase URL is not set (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL).");
  }
  if (!serviceKey) {
    throw new Error(
      "Privileged Supabase key is not set (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY) — " +
        "the deck-import worker needs it to process jobs."
    );
  }
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** True when a privileged key + URL are configured — the marketing ingest /
 *  scheduler routes gate on this instead of throwing. */
export function isAdminConfigured(): boolean {
  return Boolean(readSupabaseUrl() && readPrivilegedKey());
}
