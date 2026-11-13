---
title: Deploy
sidebar_label: Deploy
---

# Deploy

This repo builds from git. The Dockerfile copies the committed `collector/`. A checkout missing `collector/live_mesh.py` fails the image build. `deploy.sh` copies modules when `MESH_APP_DEPLOY_DIR` is set, then exits 1. It does not run `railway up`. Do not upload this tree from a laptop.

The public board is updated from the xray tree:

```bash
MESH_APP_DEPLOY_DIR=/tmp/burst-live-deploy bash house/live/app/deploy.sh
```

That script assembles `collector/` and uploads the app directory. A Railway build of the xray repo straight from git stops in the Dockerfile because `collector/` is not assembled. `railway down` removes the live deployment. Restore a previous SUCCESS with `house/live/app/rollback.sh <deployment-id>`. The id has to be a UUID. `railway redeploy` rebuilds only the latest deployment.

A short 502 or 503 during the cutover is the health gate until the next poll is 200. `ok` stays false while the accepted clock is quiet.

Node on the image is 24.22.3. The base image is `node:24.22.1-bookworm-slim`, and the Dockerfile replaces that binary from nodejs.org. Docker Hub has no `node:24.22.3` tag.

No secrets belong in this tree. Roster and site mode are the committed JSON under `collector/`.
