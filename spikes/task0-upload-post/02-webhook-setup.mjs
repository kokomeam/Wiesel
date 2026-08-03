// Bonus for tests 1+2+4 — ZERO uploads. Creates a one-off webhook.site inbox and points
// Upload-Post webhook notifications at it.
// ⚠️ SPEC BUG (found live 2026-07-23): the OpenAPI `servers` override claims this endpoint
// lives on app.upload-post.com — that host serves the dashboard SPA (POST → nginx 405).
// The endpoint actually lives on the NORMAL api base. See samples/03-webhook-configure-corrected.json.
import fs from "node:fs";
import path from "node:path";
import { call, logStep, capture, SPIKE_DIR } from "./lib/api.mjs";

logStep("Create webhook.site inbox");
const tokenRes = await fetch("https://webhook.site/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const token = await tokenRes.json();
if (!token.uuid) {
  console.error("webhook.site inbox creation failed:", JSON.stringify(token).slice(0, 500));
  process.exit(1);
}
const inboxUrl = `https://webhook.site/${token.uuid}`;
console.log("inbox:", inboxUrl);
fs.writeFileSync(path.join(SPIKE_DIR, "webhook-inbox.json"), JSON.stringify({ uuid: token.uuid, url: inboxUrl, createdAt: new Date().toISOString() }, null, 2));

logStep("POST /uploadposts/users/notifications (NORMAL api base — spec's app.* override is wrong)");
const res = await call("POST", "/uploadposts/users/notifications", {
  json: {
    channels: { webhook: true },
    webhook_url: inboxUrl,
    webhook_events: ["upload_completed", "social_account.connected", "social_account.disconnected", "social_account.reauth_required"],
  },
  captureAs: "webhook-configure",
});
console.log("status:", res.status, "| body:", JSON.stringify(res.body).slice(0, 800));

capture("webhook-inbox", { inboxUrl, note: "payloads polled via https://webhook.site/token/<uuid>/requests" });
console.log("\nWebhook configured. Test 3 will poll this inbox for upload_completed payloads.");
