/**
 * GET /api/deck-imports/[id]/original — a short-lived SIGNED URL to download the
 * ORIGINAL uploaded file (Content-Disposition: attachment). Returns the URL as
 * JSON so the client can trigger a download without leaving the editor; the URL
 * itself is never persisted or made public.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { requireDeckImportAccess } from "@/lib/course/imports/deckImportAccess";
import { signObject } from "@/lib/course/imports/deckImportStorage";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const supabase = await createClient();
  const { id } = await params;

  const access = await requireDeckImportAccess(supabase, id);
  if (!access.ok) return new Response(access.message, { status: access.status });

  const url = await signObject(supabase, access.row.original_file_path, 60 * 5, {
    download: access.row.original_file_name,
  });
  if (!url) return new Response("The original file is unavailable.", { status: 404 });

  return Response.json(
    { url, fileName: access.row.original_file_name },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
