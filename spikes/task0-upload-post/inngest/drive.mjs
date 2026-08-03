// Drives the Inngest spike: sends events to the LOCAL dev server, polls run states via its
// REST API, and asserts the three behaviors. Prereqs (two terminals):
//   node inngest/server.mjs
//   npx inngest-cli@latest dev -u http://localhost:3111/api/inngest --no-discovery
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV = "http://localhost:8288";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(name, data) {
  const res = await fetch(`${DEV}/e/spike-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  const body = await res.json();
  if (!body.ids?.length) throw new Error(`event send failed: ${JSON.stringify(body)}`);
  console.log(`sent ${name} → eventId ${body.ids[0]}`);
  return body.ids[0];
}

async function runsFor(eventId) {
  const res = await fetch(`${DEV}/v1/events/${eventId}/runs`);
  const body = await res.json();
  return body.data ?? [];
}

async function waitForTerminal(eventId, label, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const runs = await runsFor(eventId);
    const run = runs[0];
    if (run && !["Running", "Queued", "Scheduled"].includes(run.status)) {
      console.log(`${label}: ${run.status} after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return run;
    }
    await sleep(3000);
  }
  console.log(`${label}: TIMEOUT waiting for terminal state`);
  return (await runsFor(eventId))[0] ?? null;
}

// reset proof file
const RESULTS = path.join(__dirname, "results.json");
fs.writeFileSync(RESULTS, "{}");

// --- 1) sleepUntil 2 minutes out ---
const wakeAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
const sleepEvt = await send("spike/sleep.requested", { wakeAt });

// --- 2) cancellable: start, cancel after 10s ---
const cancelEvt = await send("spike/cancellable.start", { runKey: "k1" });
await sleep(10_000);
await send("spike/cancel", { runKey: "k1" });

// --- 3) retry-on-error ---
const retryEvt = await send("spike/retry.start", {});

// --- collect ---
const [cancelRun, retryRun, sleepRun] = [
  await waitForTerminal(cancelEvt, "cancellable", 120_000),
  await waitForTerminal(retryEvt, "retry", 120_000),
  await waitForTerminal(sleepEvt, "sleepUntil", 200_000),
];

const proof = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
const summary = {
  sleepUntil: {
    runStatus: sleepRun?.status, wakeAtTarget: wakeAt,
    proof: { before: proof["sleepUntil.before"], after: proof["sleepUntil.after"] },
    pass: sleepRun?.status === "Completed" && !!proof["sleepUntil.after"] && Math.abs(proof["sleepUntil.after"].driftMs) < 30_000,
  },
  cancelOnEvent: {
    runStatus: cancelRun?.status,
    proof: { started: proof["cancel.started"], completedAnyway: proof["cancel.COMPLETED_ANYWAY"] ?? null },
    pass: cancelRun?.status === "Cancelled" && !proof["cancel.COMPLETED_ANYWAY"],
  },
  retryOnError: {
    runStatus: retryRun?.status,
    proof: { attempts: proof["retry.attempts"], final: proof["retry.final"] },
    pass: retryRun?.status === "Completed" && proof["retry.attempts"] === 2,
  },
};
fs.writeFileSync(path.join(__dirname, "spike-results.json"), JSON.stringify({ summary, rawRuns: { sleepRun, cancelRun, retryRun } }, null, 2));
console.log("\n" + JSON.stringify(summary, null, 2));
const allPass = Object.values(summary).every((s) => s.pass);
console.log(allPass ? "\nINNGEST SPIKE: ALL PASS" : "\nINNGEST SPIKE: FAILURES — see above");
process.exit(allPass ? 0 : 1);
