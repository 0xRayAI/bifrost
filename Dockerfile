# Bifrost: Node server + the read-only GitHub collector (python3 stdlib only; tzdata for zoneinfo).
# collector/ is committed in this repo. The image does not assemble it.
FROM node:24.22.1-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs presence.mjs source.mjs archive.mjs origin.mjs routes.mjs governor.mjs arch1-launch.mjs worktrack.mjs handoff.mjs wave-schedule.mjs bifrost-waves.json chicago-stamp.mjs pr-batch.mjs wake-gate.mjs ./
COPY public ./public
COPY collector ./collector
# One line, the house config name:. Committed so the image COPY succeeds.
COPY owner-name ./owner-name
RUN test -f collector/upstream/fetch_feed.py && test -f collector/live_mesh.py || { \
      echo "ERROR: collector/ is missing from git. upstream/fetch_feed.py and live_mesh.py must be committed." >&2; exit 1; }
ENV NODE_ENV=production TZ=America/Chicago PORT=8080
CMD ["node", "server.mjs"]
