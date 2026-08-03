/**
 * Untyped-RPC escape hatch for the PERF-1 route-bundle RPCs (C1).
 *
 * The generated Database types lag new SQL functions until the next
 * database.types.ts splice; bundle loaders don't wait for that — they call
 * through here and validate the payload with Zod (the repo's Zod-first rule:
 * runtime safety comes from the schema, not the generated types). Once the
 * types are spliced a call site MAY move to the typed `.rpc()`, but doesn't
 * have to.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

export async function rpcJson<Schema extends z.ZodTypeAny>(
  supabase: SupabaseClient<never> | SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  schema: Schema
): Promise<z.infer<Schema>> {
  const { data, error } = await (
    supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return schema.parse(data);
}
