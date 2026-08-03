// Preflight — ZERO uploads. Validates the key, the "test" profile, connected platforms,
// Facebook page id (needed by test 4), and the JWT link flow shape.
import { call, logStep, PROFILE } from "./lib/api.mjs";

logStep("GET /uploadposts/me — key validation + account info");
const me = await call("GET", "/uploadposts/me", { captureAs: "preflight-me" });
console.log("status:", me.status, "| body keys:", typeof me.body === "object" ? Object.keys(me.body) : me.body);
if (me.status !== 200) {
  console.error("KILL: API key rejected. Aborting preflight.");
  process.exit(1);
}

logStep("GET /uploadposts/users — profiles + connected accounts + reauth flags");
const users = await call("GET", "/uploadposts/users", { captureAs: "preflight-users" });
console.log("status:", users.status);
const profiles = users.body?.profiles ?? users.body;
console.log(JSON.stringify(profiles, null, 2).slice(0, 3000));

logStep("GET /uploadposts/facebook/pages — page id for test 4");
const pages = await call("GET", "/uploadposts/facebook/pages", {
  query: { profile: PROFILE },
  captureAs: "preflight-facebook-pages",
});
console.log("status:", pages.status, "| body:", JSON.stringify(pages.body).slice(0, 1000));

logStep("POST /uploadposts/users/generate-jwt — link-URL flow (not visited)");
const jwt = await call("POST", "/uploadposts/users/generate-jwt", {
  json: { username: PROFILE, redirect_url: "https://example.com/linked", platforms: ["tiktok", "instagram", "linkedin", "youtube", "facebook"] },
  captureAs: "preflight-generate-jwt",
});
console.log("status:", jwt.status, "| keys:", typeof jwt.body === "object" ? Object.keys(jwt.body) : jwt.body);

console.log("\nPreflight complete.");
