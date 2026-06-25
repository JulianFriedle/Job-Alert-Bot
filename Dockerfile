# Playwright base image ships Chromium + all system deps, matching the
# playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Install dependencies first for better layer caching. Copy the lockfile too and
# use `npm ci` so the image gets the exact, pinned versions we tested locally
# (reproducible builds — no silent transitive-dependency upgrades at build time).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Persisted SQLite DB lives on a mounted volume.
ENV JOBS_DB_PATH=/app/data/jobs.db
ENV GUI_PORT=3000
EXPOSE 3000

# Default command runs the GUI server. The scheduler runs as a second service
# (see docker-compose.yml) sharing the same data volume.
CMD ["node", "src/server.js"]
