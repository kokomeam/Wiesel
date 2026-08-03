/**
 * Dev-only Inngest reachability probe (AC-MD.7). In development it checks
 * the local Inngest dev server; the BANNER TEXT is delivered from here —
 * server-side, dev-branch only — so no prod client chunk ever contains it
 * (the bundle suite greps for exactly that). In production this returns
 * {prod:true} and the banner component renders nothing.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEV_SERVER = "http://127.0.0.1:8288";

export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ prod: true, show: false });
  }
  try {
    const res = await fetch(`${DEV_SERVER}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return NextResponse.json({ prod: false, show: false });
  } catch {
    // unreachable — fall through to the banner
  }
  return NextResponse.json({
    prod: false,
    show: true,
    message:
      "Dev: publishing won't fire — the Inngest dev server isn't running. Start it with: npx inngest-cli@latest dev",
  });
}
