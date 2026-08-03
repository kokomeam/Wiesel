/**
 * Durable publish functions (M-C amendment 1) — the FIRE PATH is
 * event-driven, not cron-quantized:
 *
 *   publishFire  — on social/publish.requested: sleepUntil(scheduledFor)
 *     (sleepUntil-precise — fire accuracy is delivery latency only, P95 well
 *     under 120s), then advance the manifest edge-by-edge with short sleeps
 *     between verify polls. cancelOn social/publish.released (matched by
 *     manifestId) kills the sleep on cancel / void / reschedule; a
 *     reschedule then emits a fresh requested event (new sleep).
 *   publishSweep — the M-B reconciliation tick, retained as the BACKSTOP
 *     ONLY (crashed fire runs, lost events, guard-held rows), moved off the
 *     marketing scheduler route onto an Inngest cron.
 *
 * Both build the same deps the scheduler route used (admin client + the real
 * provider) and are no-ops when the provider/encryption/admin env is absent.
 * All domain logic stays in publishService — these are thin durable shells.
 */

import { inngest } from "../client";
import {
  PUBLISH_CANCEL_MATCH,
  PUBLISH_RELEASED_EVENT,
  PUBLISH_REQUESTED_EVENT,
} from "../publishEvents";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import {
  getSocialPublishProvider,
  isPublishProviderConfigured,
} from "@/lib/marketing/publish/provider";
import { isEncryptionConfigured } from "@/lib/marketing/accounts/crypto";
import {
  advancePublishManifest,
  processPublishTick,
  type PublishTickDeps,
} from "@/lib/marketing/publish/publishService";
import { getPublishManifest } from "@/lib/marketing/publish/manifestRepository";
import { isTerminalManifestStatus } from "@/lib/marketing/publish/manifest";

/** Verify polling inside the durable run: short sleeps, bounded; anything
 *  left after the budget falls to the sweep. */
export const FIRE_VERIFY_POLL_SECONDS = 30;
export const FIRE_MAX_STEPS = 12;

function buildDeps(): PublishTickDeps | null {
  if (!isAdminConfigured() || !isPublishProviderConfigured() || !isEncryptionConfigured()) return null;
  return {
    supabase: createAdminClient() as never,
    provider: getSocialPublishProvider(),
  };
}

export const publishFire = inngest.createFunction(
  {
    id: "social-publish-fire",
    cancelOn: [{ event: PUBLISH_RELEASED_EVENT, if: PUBLISH_CANCEL_MATCH }],
    triggers: [{ event: PUBLISH_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const { manifestId, scheduledFor } = event.data as {
      manifestId: string;
      scheduledFor: string | null;
    };
    if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()) {
      // The whole fire-accuracy story: ONE durable sleep to the exact
      // creator-approved instant — no cron rounding.
      await step.sleepUntil("wait-for-fire-time", new Date(scheduledFor));
    }
    for (let i = 0; i < FIRE_MAX_STEPS; i++) {
      const outcome = await step.run(`advance-${i}`, async () => {
        const deps = buildDeps();
        if (!deps) return "not_configured";
        const manifest = await getPublishManifest(deps.supabase, manifestId);
        if (!manifest || isTerminalManifestStatus(manifest.status)) return "terminal";
        if (manifest.status === "held") return "held"; // sweep resumes holds
        return advancePublishManifest(deps, manifest);
      });
      if (outcome === "terminal" || outcome === "held" || outcome === "not_configured") return { outcome };
      if (outcome === "live" || outcome === "failed" || outcome === "platform_failed" || outcome === "voided") {
        return { outcome };
      }
      await step.sleep(`verify-wait-${i}`, `${FIRE_VERIFY_POLL_SECONDS}s`);
    }
    return { outcome: "handed_to_sweep" };
  }
);

export const publishSweep = inngest.createFunction(
  { id: "social-publish-sweep", triggers: [{ cron: "*/5 * * * *" }] },
  async ({ step }) => {
    return step.run("sweep", async () => {
      const deps = buildDeps();
      if (!deps) return { skipped: "not_configured" };
      return processPublishTick(deps, { limit: 50 });
    });
  }
);
