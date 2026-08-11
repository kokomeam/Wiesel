/**
 * Inngest serve route — registers every durable function (M-C: the publish
 * fire path + the reconciliation sweep). Prod: INNGEST_SIGNING_KEY verifies
 * calls; dev: `npx inngest-cli@latest dev` discovers this route.
 */

import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { publishFire, publishSweep } from "@/lib/inngest/functions/publish";
import { tutorGraphExtract, tutorGraphReconcile } from "@/lib/inngest/functions/tutorGraph";
import { tutorChunksEmbed } from "@/lib/inngest/functions/tutorChunks";
import { tutorMasteryRefold, tutorMasteryNightly } from "@/lib/inngest/functions/tutorMastery";
import { tutorLessonHealthNightly } from "@/lib/inngest/functions/tutorLessonHealth";
import {
  tutorEscalationSynthesize,
  tutorEscalationReconcileNightly,
} from "@/lib/inngest/functions/tutorEscalation";
import { creatorDigestNightly } from "@/lib/inngest/functions/creatorDigestNightly";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    publishFire,
    publishSweep,
    tutorGraphExtract,
    tutorGraphReconcile,
    tutorChunksEmbed,
    tutorMasteryRefold,
    tutorMasteryNightly,
    tutorLessonHealthNightly,
    tutorEscalationSynthesize,
    tutorEscalationReconcileNightly,
    creatorDigestNightly,
  ],
});
