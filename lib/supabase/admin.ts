/**
 * Service-role Supabase client — BYPASSES RLS. SERVER-ONLY.
 *
 * The ONLY sanctioned use is the public marketing ingest route: anonymous
 * visitors on a published landing page can't write `subscriber` / `analytics_event`
 * rows under RLS (by design), so the server writes on their behalf AFTER
 * validating the target page is published. Never import this into a client
 * component or expose the key — it grants full database access.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) must be set for the ingest route."
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Whether the service-role ingest path is configured. The ingest route 503s
 *  cleanly when false instead of throwing. */
export function isAdminConfigured(): boolean {
  return !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}
