/**
 * Browser Supabase client (client components). Reads the publishable creds from
 * NEXT_PUBLIC_* env. Auth sessions live in cookies, shared with the server
 * client so RLS sees the same user on both sides.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
