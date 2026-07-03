# Deck-import conversion worker

Turns an uploaded **PPT / PPTX / PDF** into per-page preview images for the
in-app rail viewer. It runs **outside** the Next.js request path — heavy
LibreOffice/Poppler work must never block a user request.

```
PPT/PPTX/PDF original (private storage)
  → normalize to PDF        (LibreOffice headless; PDF passes through)
  → render each page to PNG (Poppler pdftoppm: full @150dpi + thumb @42dpi)
  → upload pages/thumbs      (private deck-imports bucket)
  → write deck_import_pages  (page_number, image_path, thumbnail_path, w/h)
  → deck_imports.status = ready (+ page_count, preview_pdf_path)
```

Any failure (bad file, tools missing, render error) marks the row `failed` with a
friendly message and **does not crash** the worker — the app stays stable.

## Files

| File | Role |
| --- | --- |
| `processDeckImport.ts` | Orchestrator: `processDeckImport(deckImportId)` — the production entry point. |
| `convertToPdf.ts` | PPT/PPTX → PDF via LibreOffice; PDF copied through. |
| `renderPdfPages.ts` | PDF → PNG pages + thumbnails via `pdftoppm`; pure `pngDimensions` IHDR reader. |
| `uploadDeckArtifacts.ts` | Uploads pages/thumbs/preview-pdf, returns page insert rows. |
| `runWorker.ts` | CLI entry: poll loop, or one-shot by id. |
| `shell.ts` | `run()` / `commandExists()` + `WorkerError` (technical + user message). |
| `Dockerfile` | Node 20 + LibreOffice + Poppler image. |

## System dependencies

The worker shells out to two CLIs. Install them on the worker host:

**Debian/Ubuntu (and the Dockerfile):**
```bash
apt-get install -y libreoffice-impress poppler-utils fonts-liberation fontconfig
```

**macOS (local dev):**
```bash
brew install --cask libreoffice   # provides `soffice`
brew install poppler              # provides `pdftoppm`
```

Override the binary locations if they aren't on `PATH`:
`LIBREOFFICE_BIN` (default `soffice`), `PDFTOPPM_BIN` (default `pdftoppm`).

If the tools are **not** installed, jobs fail gracefully with
"Preview tools are unavailable on the server." — the editor shows the failed card
with retry; nothing crashes.

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`) | ✅ | Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | ✅ | Privileged server-side key — legacy `service_role` JWT (`eyJ…`) **or** a new Supabase secret API key (`sb_secret_…`). The worker reads jobs across users and writes artifacts (bypasses RLS by design). **Never ship this to the browser.** |
| `DECK_IMPORT_POLL_MS` | – | Poll interval (default 4000). |
| `DECK_IMPORT_BATCH` | – | Jobs claimed per tick (default 3). |
| `DECK_IMPORT_FULL_DPI` / `DECK_IMPORT_THUMB_DPI` | – | Render DPIs (default 150 / 42). |

## Running

```bash
# Poll loop (leave it running in a second terminal during local dev)
npm run worker:deck-imports

# Process a single job (debugging / manual retry)
npm run worker:deck-imports -- <deckImportId>

# Containerized
docker build -f workers/deck-import/Dockerfile -t deck-import-worker .
docker run --env-file .env.local deck-import-worker
```

## State machine

```
uploaded ──enqueue──▶ processing ──ok──▶ ready
                          │
                          └──error──▶ failed ──retry──▶ processing
ready ──replace/retry──▶ processing
```

The transitions are enforced in code (`deckImportValidation.canTransition`) and
the route handlers; the worker only ever moves `processing → ready | failed`.

## Production notes / TODO

- **Queue transport.** v1 "enqueue" just sets `status='processing'` and this
  worker polls. Swap `enqueueDeckImportJob` (publish side) and
  `claimProcessingDeckImports` (consume side) for a durable queue — Supabase PGMQ,
  SQS, QStash, or `LISTEN/NOTIFY`. The function signatures are stable, so nothing
  else changes.
- **Multiple workers.** The poll is a plain `select`, not an atomic lease. For >1
  worker, add a `claimed_at`/`worker_id` lease column and claim with
  `... for update skip locked`, plus a stale-claim reaper so a crashed worker's
  job re-runs.
- **Poison jobs.** A job that always throws is marked `failed` (not retried in a
  loop). A crash *before* `markFailed` leaves it `processing`; add a max-attempts
  guard alongside the lease for production.
- **Google Slides / OneDrive.** The schema already supports `source_type` +
  `source_external_id`. A future import would export the remote file to PDF, drop
  it at `original_file_path`, and reuse this exact pipeline unchanged.
