/**
 * Server Supabase client (server components, route handlers, server actions).
 * Reads/writes the auth cookies via next/headers. Writing cookies from a Server
 * Component render throws — that's fine, the middleware refreshes the session,
 * so we swallow it.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Database } from "@/lib/database.types";

/**
 * Per-request singleton (react cache()): layout + page + nested loaders share
 * one client instead of constructing one each. Safe — the cookie store is
 * request-scoped and identical for every caller in the render pass.
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — ignore; middleware refreshes.
          }
        },
      },
    }
  );
});

/**
 * Request-deduped auth lookup. `auth.getUser()` is a NETWORK round trip to
 * Supabase Auth — before this helper, middleware + layout + page each paid it
 * (3–4× per navigation, PERF-1 A6 finding #1). Every server component / route
 * handler / server action in one request now shares a single call.
 */
export const getSessionUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
