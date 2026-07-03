# Deck-import conversion worker.
#
# System packages this worker shells out to:
#   • libreoffice-impress  — PPT/PPTX → PDF (headless)
#   • poppler-utils         — PDF → PNG (pdftoppm)
#   • fonts-*               — so converted slides render with sane fallbacks
#
# Runtime env (required): NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) +
#   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)
# Build from the repo root:  docker build -f workers/deck-import/Dockerfile -t deck-import-worker .
# Run:                       docker run --env-file .env.local deck-import-worker

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      poppler-utils \
      fonts-liberation \
      fonts-dejavu-core \
      fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (tsx is a devDependency the worker runs through, so keep dev deps).
COPY package*.json ./
RUN npm ci

# App + worker source (tsconfig provides the @/* path alias tsx resolves).
COPY . .

ENV NODE_ENV=production \
    DECK_IMPORT_POLL_MS=4000

# Long-running poll loop. Override CMD with an id arg to process one job.
CMD ["npx", "tsx", "workers/deck-import/runWorker.ts"]
