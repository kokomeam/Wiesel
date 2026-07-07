# Task 0 — Reap smoke-test findings (Phase 1.5, gates M-B)

> **Status: BLOCKED — waiting on `REAP_API_KEY`.**
> Create a free Reap account (free tier: 1 hour of processing), add
> `REAP_API_KEY=...` to `.env.local`, then run `npm run smoke:reap`
> (optionally `-- --webhook-url https://webhook.site/<id>` to capture
> deliveries). The script writes every request/response pair to
> `docs/reap-task0-findings.generated.json`; transfer conclusions here,
> check the boxes, and surface adapter-design changes for approval.
> **CHECKPOINT — M-B does not start until this doc is filled and approved.**

Run metadata: date ______ · API base ______ · test video ______

## (a) Does `/create-clips` accept explicit in/out timestamps?

- [ ] YES — variant accepted: `start/end seconds` / `startMs/endMs` /
      `segments[]` (circle one; paste the accepted request body below)
- [ ] NO — **adopt the pre-cut FFmpeg fallback in M-B** (server-side segment
      cut → `/create-captions` + `/create-reframe`; the fallback ships fully,
      with its own tests, not stubbed — PRD §9.3/§18)

```jsonc
// accepted request body (verbatim)
```

Decision recorded: ____________________________________________

## (b) Webhook payload + signing scheme

- Delivery observed at: ______ (webhook.site / local tunnel)
- Signature header name: ______ (or: none — secret URL segment + shared-secret
  header + strict payload schema, per the M7 fallback rule)
- Replay/timestamp field: ______
- ACK contract confirmed: 200 within 5s, auto-disable after 5 failures (PRD §11.2)

```jsonc
// one verbatim webhook payload (redact tokens)
```

Verification implementation to pin in the adapter: ____________________

## (c) Brand-template API fields

- Endpoint(s) that exist: ______
- Fields supported: fonts ☐ · colors ☐ · logo ☐ · end-card ☐ · caption preset ☐
- One template per creator per preset is feasible: ☐ yes ☐ no (workaround: ______)

## (d) One render per preset, scored vs. OpusClip reference

Same source span rendered through `tofu_hook` / `mofu_story` / `bofu_preview`
approximations, plus the SAME span through the OpusClip consumer product.
Score both with the §20 rubric (0–5 each: caption accuracy, reframe subject
centering, cut cleanliness, hook overlay, end-card):

| | tofu_hook | mofu_story | bofu_preview | OpusClip ref |
|---|---|---|---|---|
| Caption accuracy (WER note) | | | | |
| Reframe centering | | | | |
| Cut cleanliness | | | | |
| Overlay/branding | | | | |
| Overall | | | | |

Parity judgment (mechanical stages must be ≥ reference): ______

## (e) TTFC + cost

| Job | Submitted | First status change | Completed | TTFC | cost-minutes reported |
|---|---|---|---|---|---|
| transcription | | | | | |
| clip render | | | | | |

Cost-minutes field name in the API response: ______ (feeds `clip_render_jobs.cost_minutes`, §11.5)

## Adapter design changes surfaced for approval

1. ______
2. ______

Approved by creator on: ______ → M-B unblocked.
