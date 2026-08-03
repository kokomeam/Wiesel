# Task 0a spike — Upload-Post + Inngest (THROWAWAY)

Verification spike for the connected-social-publishing phase plan. **Not production code.**
Findings: [`FINDINGS.md`](./FINDINGS.md). Raw evidence (redacted): [`samples/`](./samples/).

**Scope (Task 0a):** LinkedIn + YouTube ONLY. TikTok / Instagram / Facebook are
deferred to Task 0b — do not attempt them. Profile: `henry`.

## Prereqs
- `UPLOAD_POST_API_KEY` in the repo root `.env.local`
- Upload-Post profile `henry` with LinkedIn + YouTube connected (verified live)
- Free tier: **10 uploads/month** — HARD BUDGET for 0a: **3 uploads total**
  (2 LinkedIn text + 1 YouTube video); the rest is reserved for Task 0b.
  **Never re-fire a publish call to "check if it worked"** — all verification is
  GET-only (`/uploadposts/status`, `/uploadposts/history`, webhook inbox).

## Run order (kill-order; scripts exit non-zero on a disqualifying failure)
```bash
cd spikes/task0-upload-post
npm install                       # express + inngest only (isolated from the app)
node make-clip.mjs                # 5s 1080x1920 test clip via repo's ffmpeg-static
node --env-file=../../.env.local 00-preflight.mjs                 # 0 uploads (also = listConnectedAccounts evidence)
node --env-file=../../.env.local 02-webhook-setup.mjs             # 0 uploads (webhook.site inbox, run BEFORE uploads)
node --env-file=../../.env.local 01-linkedin-text-idempotency.mjs # 2 uploads (test 1: idempotency + first_comment + refs)
node --env-file=../../.env.local 03-youtube-short.mjs             # 1 upload  (test 2: Shorts E2E + latency)
node --env-file=../../.env.local 05-delete-probe-and-errors.mjs   # 0 uploads (tests 3+4: delete probes + error shapes)
```
Tests 1+2 write `state.json` (post refs) which 05 auto-loads.

## Inngest spike (test 5 — no uploads, fully local; ALREADY RUN: ALL PASS)
```bash
node inngest/server.mjs &                                          # app on :3111
npx inngest-cli@latest dev -u http://localhost:3111/api/inngest --no-discovery &  # dev server :8288
node inngest/drive.mjs                                             # asserts all 3 behaviors (~3 min)
```
Results: `inngest/spike-results.json` (sleepUntil drift 389 ms · cancel-by-event · retry honored).
