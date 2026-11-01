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

## Station nudge

The live scheduler is the board process, not launchd. Each minute the server checks the clock. Inside the window it posts one inbox line, `nudge:station:<seat>:<Chicago hour>`, for forge, critic, and blinky, and for arch1 when that id is in the fleet. The sentence is `Run station and re-read OP-PROC`. The window is weekdays, America/Chicago, from 7:30 through 17:30. 18:00 stays quiet. A second pass in the same Chicago hour does not post again. An inbox that already has work still gets the line; the queue keeps it behind the head.

`STATION_NUDGE=off` stops the tick. `STATION_NUDGE=on` forces it. With the flag unset, Railway posts and a test bind (`PORT=0`) stays quiet. The launchd plist in the xray tree is a template and is not loaded.

No secrets belong in this tree. Roster and site mode are the committed JSON under `collector/`.
