# bifrost

Live board for burst-live. Railway root is `/`. The service builds this Dockerfile from git.

## Build

`collector/` is committed. The image copies it. Nothing assembles it at build time.

```bash
docker build -t bifrost .
```

The process listens on `PORT` (the image sets 8080). `GET /healthz` is the health check.

## Tests

Node 24.22.1:

```bash
npm test
```

That runs the Dockerfile copy check, the collector guard, and the `/healthz` checks.

## Deploy

Forge connects the burst-live service to this repo after critic PASS on the SHA. Do not run `railway up` from a laptop. `deploy.sh` refuses.

No secrets belong in this tree. Roster and site mode are the committed JSON under `collector/`.
