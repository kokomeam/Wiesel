/**
 * Shared plumbing for the /api/learn/* route handlers: auth, body parsing,
 * and LearnError → HTTP mapping. Routes stay thin; policy lives in
 * lib/learn/* services.
 */

import { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { LearnError, learnErrorStatus } from "./errors";

type DB = SupabaseClient<Database>;

export async function requireUser(): Promise<
  | { ok: true; supabase: DB; user: User }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, supabase, user };
}

export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 }
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

export function learnErrorResponse(error: unknown): NextResponse {
  if (error instanceof LearnError) {
    return NextResponse.json({ error: error.message }, { status: learnErrorStatus(error.code) });
  }
  console.error("[learn] unexpected error", error);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
