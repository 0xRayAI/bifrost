# Bifrost: Node server + the read-only GitHub collector (python3 stdlib only; tzdata for zoneinfo).
# collector/ is committed in this repo. The image does not assemble it.
# Railway root-mounts the volume at container start. A build-time chown of /data
# does not survive that mount (#580). No USER here: this image stays root only
# until docker-entrypoint.sh chowns the data dir and drops to the image node user.
FROM node:24.22.1-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 tzdata ca-certificates gosu \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs health-exit.mjs feed-read-worker.mjs presence.mjs source.mjs archive.mjs ci-credit.mjs resp.mjs history-store.mjs compact-cards.mjs origin.mjs routes.mjs governor.mjs arch1-launch.mjs worktrack.mjs handoff.mjs wave-schedule.mjs bifrost-waves.json chicago-stamp.mjs pr-batch.mjs ci-clear.mjs wake-gate.mjs station-tick.mjs inbox-queue.mjs ./
COPY public ./public
COPY collector ./collector
# One line, the house config name:. Committed so the image COPY succeeds.
COPY owner-name ./owner-name
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0755 docker-entrypoint.sh
# collector/ is committed. A checkout without upstream/fetch_feed.py and live_mesh.py must not build.
RUN test -f collector/upstream/fetch_feed.py && test -f collector/live_mesh.py || { \
      echo "ERROR: collector/ is missing from git. upstream/fetch_feed.py and live_mesh.py must be committed." >&2; exit 1; }
ENV NODE_ENV=production TZ=America/Chicago PORT=8080
# railway.json startCommand is this script. Railway replaces ENTRYPOINT, so a
# start command of `node server.mjs` would skip the chown (#580).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
