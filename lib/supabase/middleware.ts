/**
 * Middleware session refresh + route guard. Runs on every request (see
 * middleware.ts matcher): refreshes the auth cookie and bounces unauthenticated
 * visitors away from the in-app (studio) routes to /login. Marketing pages and
 * /login stay public.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";

/** In-app routes that require a signed-in user. Marketing ("/", "/educators")
 *  and "/login" are intentionally public. Covers BOTH portals: the creator
 *  (app) group and the student (student) group (/home, /my-courses, /explore).
 *  /learn/* stays public (its lesson page self-gates). When adding a new
 *  top-level in-app route, add its prefix here or it silently ships public. */
const PROTECTED =
  /^\/(dashboard|studio|analytics|exports|marketing|marketplace|settings|home|my-courses|explore)(\/|$)/;

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Anonymous fast path (PERF-1 C1): with no Supabase auth cookies there is no
  // session to refresh and getUser() would be a guaranteed-null network round
  // trip. Public pages (/, /educators, /learn/*, /p/*) render with ZERO auth
  // RTT for signed-out visitors; protected pages still bounce to /login.
  const hasAuthCookies = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));
  if (!hasAuthCookies) {
    const path = request.nextUrl.pathname;
    if (PROTECTED.test(path)) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("redirectTo", path);
      return NextResponse.redirect(url);
    }
    return response;
  }

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: getUser() refreshes the token and must run before any redirect.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (!user && PROTECTED.test(path)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirectTo", path);
    return NextResponse.redirect(url);
  }

  return response;
}
