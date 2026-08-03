import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Everything except /api, Next internals, and static assets.
    // /api is excluded deliberately (PERF-1 C1): every route handler already
    // authenticates itself (requireUser / service-role / webhook secrets), so
    // the middleware getUser() was a pure extra auth round trip per API call.
    // Token refresh still works handler-side — the server client refreshes an
    // expired session and route handlers CAN write cookies.
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
