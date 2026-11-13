# bifrost

Live board for burst-live. Railway root is `/`. The service builds this Dockerfile from git.

The manual is a Docusaurus site in `docs-site/`. It is not copied into the image.

```bash
cd docs-site && npm install && npm run build
```

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

## Roster

A chip is a key of `fleet.seats`. `product_nodes` may also appear (CloudAgents). Until that seat map exists, the configured strip stays. A seat with no signal for 7 days is dormant, not a live slot.

## Working lights

A push, merge, or review lights that seat on the mesh for `LIVE_TURN_OPEN_MIN` minutes (default 20). The actor has to be in `collector/fleet-nodes.json` or the login on `collector/routing/inbox-roles.json`. `arch10x[bot]` is Arch1.

An outside seat whose GitHub login is not in that map does not light from a merge. That seat posts `live-inbox <seat> --turn start` when the burst starts and `--turn end` when it stops.

## Station nudge

The live scheduler is the board process, not launchd. Each minute the server checks the clock. Inside the window it posts one inbox line, `nudge:station:<seat>:<Chicago date>`, for forge, critic, and blinky, and for arch1 when that id is in the fleet. The sentence is `Run station and re-read OP-PROC`. The window is weekdays, America/Chicago, from 7:30 through 17:30. 18:00 stays quiet. A second pass in the same Chicago hour does not post again. A later hour the same day updates that row. An inbox that already has work still gets the line; the queue keeps it behind the head.

`STATION_NUDGE=off` stops the tick. `STATION_NUDGE=on` forces it. With the flag unset, Railway posts and a test bind (`PORT=0`) stays quiet. The launchd plist in the xray tree is a template and is not loaded.

No secrets belong in this tree. Roster and site mode are the committed JSON under `collector/`.
