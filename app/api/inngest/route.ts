/**
 * Inngest serve route — registers every durable function (M-C: the publish
 * fire path + the reconciliation sweep). Prod: INNGEST_SIGNING_KEY verifies
 * calls; dev: `npx inngest-cli@latest dev` discovers this route.
 */

import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { publishFire, publishSweep } from "@/lib/inngest/functions/publish";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [publishFire, publishSweep],
});
