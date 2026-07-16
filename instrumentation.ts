/**
 * This machine's network resolves several external APIs (Supabase, OpenAI, Mux)
 * to a broken IPv6 route by default, which Node's fetch doesn't gracefully skip —
 * calls just hang/fail ("fetch failed"). Standalone verify scripts already pin
 * ipv4first per-script; this applies the same fix once, process-wide, so the
 * actual running server (API routes, the Mux status poll, etc.) isn't affected too.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dns = await import("node:dns");
    dns.setDefaultResultOrder("ipv4first");
  }
}
