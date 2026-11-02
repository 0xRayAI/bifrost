#!/usr/bin/env bash
# This repo builds from git. Railway root is /. There is no assemble step.
# Forge connects burst-live after critic PASS. Do not upload this tree with the Railway CLI.
# The app cp list names every module the server imports, including chat-doorbell.mjs,
# so a deploy-dir copy cannot drop one. This script still does not upload.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DST="${MESH_APP_DEPLOY_DIR:-}"
if [ -n "$DST" ] && [ -d "$DST" ]; then
  [ "$(cd "$DST" && pwd -P)" = "$APP" ] || {
  cp "$APP"/server.mjs "$APP"/health-exit.mjs "$APP"/feed-read-worker.mjs "$APP"/presence.mjs "$APP"/source.mjs "$APP"/archive.mjs "$APP"/ci-credit.mjs "$APP"/resp.mjs "$APP"/history-store.mjs "$APP"/compact-cards.mjs "$APP"/origin.mjs "$APP"/routes.mjs "$APP"/governor.mjs "$APP"/arch1-launch.mjs "$APP"/worktrack.mjs "$APP"/handoff.mjs "$APP"/wave-schedule.mjs "$APP"/fleet-mode.mjs "$APP"/bifrost-waves.json "$APP"/chicago-stamp.mjs "$APP"/pr-batch.mjs "$APP"/ci-clear.mjs "$APP"/wake-gate.mjs "$APP"/station-tick.mjs "$APP"/inbox-queue.mjs "$APP"/chat-doorbell.mjs "$APP"/package.json "$APP"/railway.json "$APP"/.railwayignore "$APP"/Dockerfile "$APP"/docker-entrypoint.sh "$DST"/
  }
fi
echo "bifrost builds from git at repo root /. No assemble step. Service connect waits on critic PASS." >&2
exit 1
