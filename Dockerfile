# Bifrost: Node server + the read-only GitHub collector (python3 stdlib only; tzdata for zoneinfo).
# collector/ is committed in this repo. The image does not assemble it.
# Railway root-mounts the volume at container start. A build-time chown of /data
# does not survive that mount (#580). No USER here: this image stays root only
# until docker-entrypoint.sh chowns the data dir and drops to the image node user.
FROM node:24.22.1-bookworm-slim
# Node 24.22.3 is the patched release. Docker Hub has no node:24.22.3 tag yet.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) echo "unsupported $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v24.22.3/SHASUMS256.txt" -o /tmp/SHASUMS256.txt \
 && curl -fsSL "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-${narch}.tar.gz" -o "/tmp/node-v24.22.3-linux-${narch}.tar.gz" \
 && grep " node-v24.22.3-linux-${narch}.tar.gz$" /tmp/SHASUMS256.txt > /tmp/node-sum.txt \
 && (cd /tmp && sha256sum -c node-sum.txt) \
 && tar -xzf "/tmp/node-v24.22.3-linux-${narch}.tar.gz" -C /usr/local --strip-components=1 \
 && rm -f /tmp/SHASUMS256.txt /tmp/node-sum.txt "/tmp/node-v24.22.3-linux-${narch}.tar.gz" \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && node -v | grep -qx v24.22.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 tzdata ca-certificates gosu \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs health-exit.mjs feed-read-worker.mjs presence.mjs source.mjs archive.mjs ci-credit.mjs resp.mjs history-store.mjs compact-cards.mjs origin.mjs routes.mjs governor.mjs arch1-launch.mjs worktrack.mjs handoff.mjs wave-schedule.mjs fleet-mode.mjs bifrost-waves.json chicago-stamp.mjs pr-batch.mjs ci-clear.mjs wake-gate.mjs station-tick.mjs inbox-queue.mjs chat-doorbell.mjs ./
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
