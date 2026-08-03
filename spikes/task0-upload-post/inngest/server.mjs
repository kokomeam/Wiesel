// Inngest spike server — three durable functions proving sleepUntil / cancelOn / step retry.
// Steps write proof to results.json so the driver can assert without scraping UI.
import express from "express";
import { Inngest, RetryAfterError } from "inngest";
import { serve } from "inngest/express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(__dirname, "results.json");

function record(key, value) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(RESULTS, "utf8")); } catch {}
  data[key] = value;
  fs.writeFileSync(RESULTS, JSON.stringify(data, null, 2));
  return value;
}

const inngest = new Inngest({ id: "task0-spike" });

// 1) sleepUntil a timestamp ~2 min out
const sleepUntilFn = inngest.createFunction(
  { id: "spike-sleep-until" },
  { event: "spike/sleep.requested" },
  async ({ event, step }) => {
    await step.run("before-sleep", () =>
      record("sleepUntil.before", { at: new Date().toISOString(), wakeAt: event.data.wakeAt }));
    await step.sleepUntil("wake-at-target", event.data.wakeAt);
    const wokeAt = new Date().toISOString();
    await step.run("after-sleep", () =>
      record("sleepUntil.after", { wokeAt, driftMs: Date.now() - new Date(event.data.wakeAt).getTime() }));
    return { wokeAt };
  },
);

// 2) cancellation by event (matched on data.runKey)
const cancellableFn = inngest.createFunction(
  { id: "spike-cancellable", cancelOn: [{ event: "spike/cancel", match: "data.runKey" }] },
  { event: "spike/cancellable.start" },
  async ({ event, step }) => {
    await step.run("started", () => record("cancel.started", { at: new Date().toISOString(), runKey: event.data.runKey }));
    await step.sleep("long-nap", "10m");
    // If cancellation works, this NEVER runs:
    await step.run("should-never-run", () => record("cancel.COMPLETED_ANYWAY", { at: new Date().toISOString() }));
  },
);

// 3) step retry on thrown error (fails on attempt 1, succeeds on attempt 2)
const retryFn = inngest.createFunction(
  { id: "spike-retry", retries: 2 },
  { event: "spike/retry.start" },
  async ({ step }) => {
    const result = await step.run("flaky-step", () => {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(RESULTS, "utf8")); } catch {}
      const n = (data["retry.attempts"] ?? 0) + 1;
      record("retry.attempts", n);
      if (n === 1) throw new RetryAfterError("deliberate first-attempt failure", "5s");
      return record("retry.final", { succeededOnAttempt: n, at: new Date().toISOString() });
    });
    return result;
  },
);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/inngest", serve({ client: inngest, functions: [sleepUntilFn, cancellableFn, retryFn] }));
app.listen(3111, () => console.log("spike inngest app on :3111"));
