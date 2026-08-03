/**
 * The Inngest client (M-C amendment 1) — event-driven durable functions own
 * the publish fire path; the M-B tick survives only as the reconciliation
 * backstop sweep (an Inngest cron). One app-wide client; functions live in
 * lib/inngest/functions/* and are served by app/api/inngest/route.ts.
 * Env: INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY in prod; the local dev server
 * (`npx inngest-cli@latest dev`) discovers the serve route automatically.
 */

import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "wisesel" });
