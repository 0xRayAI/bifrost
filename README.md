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

Seat ids come from `collector/fleet-roster.json` `seats`. `LIVE_SEAT_IDS` (comma list) replaces that list. `builder` and `builder-cloud` stay kit plumbing and are not board seats. The canvas, the roster chips, and `GET /healthz` `seats` all use that same list. Parked seats stay on the chip strip and off the canvas. `outside` seats stay on the canvas.

The coordinator, operator, and reviewer are resolved in this order: `LIVE_ROLE_COORD`, `LIVE_ROLE_OPS`, `LIVE_ROLE_REVIEW`; then `collector/routing/inbox-roles.json` `seats.coord` / `seats.operator` / `seats.reviewer` when that row has a seat and is not off; then a roster role whose text is `chief of staff`, `coordinator`, `eng primary`, `operator`, or `reviewer`. An unmatched role is empty. `POST /fleet-mode` with a seat key has to be the coordinator.

`GET /healthz` is open. `seats` is the fleet's seat ids, in roster order (or `LIVE_SEAT_IDS` order). It is strings only: no keys, no logins, no webhook URLs. A setup check is `GET /healthz` and a comparison of `seats` to the fleet. The fields `arch1_launch` and `arch1_inbox` are present only when `arch1` is one of those ids. The stats strip adds the arch1 backlog column only when the feed includes that number.

The owner node is `LIVE_OWNER`, otherwise the `owner-name` file. The page title is `site.json` `name` and `title` (`LIVE_SITE_NAME` and `LIVE_SITE_TITLE` win). Names in `site.json` (`name`, `node`, and host values) are the board, not canvas nodes. `config/layout.json` is optional and is the only layout file that is read. `config/layout.example.json` is not. Portraits are served only when `LIVE_AVATAR_DIR` is set; the files are `avatars/<seat-id>.png` and the public tree ships none.

## Working lights

A push, merge, or review lights that seat on the mesh for `LIVE_TURN_OPEN_MIN` minutes (default 20). The actor has to be in `collector/fleet-nodes.json` or the login on `collector/routing/inbox-roles.json`. `arch10x[bot]` is Arch1.

An outside seat whose GitHub login is not in that map does not light from a merge. That seat posts `live-inbox <seat> --turn start` when the burst starts and `--turn end` when it stops.

## Station nudge

The live scheduler is the board process, not launchd. Each minute the server checks the clock. Inside the window it posts one inbox line, `nudge:station:<seat>:<Chicago date>`, for each station seat. The sentence is `Run station and re-read OP-PROC`. The window is weekdays, America/Chicago, from 7:30 through 17:30. 18:00 stays quiet. A second pass in the same Chicago hour does not post again. A later hour the same day updates that row. An inbox that already has work still gets the line; the queue keeps it behind the head.

Station seats are `STATION_SEATS` when that variable is set. Otherwise they are the roster `station` array when `LIVE_SEAT_IDS` is unset. Otherwise they are every fleet seat except parked seats. Kit plumbing is never nudged.

`STATION_NUDGE=off` stops the tick. `STATION_NUDGE=on` forces it. With the flag unset, Railway posts and a test bind (`PORT=0`) stays quiet. The launchd plist in the xray tree is a template and is not loaded.

## This deploy (0xRay)

The committed `collector/fleet-roster.json`, `collector/fleet-nodes.json`, `collector/routing/inbox-roles.json`, and `collector/site.json` are this fleet. Leave them in place and the board still has these seats, the coordinator on blinky, the operator on forge, and the reviewer on critic. `station` on the roster is `forge`, `critic`, `blinky`, `arch1`, which is the previous station tick. `arch1_launch` and `arch1_inbox` stay on `/healthz` because `arch1` is in that roster.

To keep the previous canvas, owner node, portraits, and wordmark, set:

| Setting | Value |
| --- | --- |
| `LIVE_OWNER` | `Blaze` (or write `Blaze` in `owner-name`; the committed file is `owner`) |
| `LIVE_AVATAR_DIR` | `config/avatars` |
| `config/layout.json` | copy of `config/layout.example.json` |

`config/layout.example.json` is not read. Without the copy, seats still draw, on a generated ring, with no Coord alias and no wordmark. Without `LIVE_AVATAR_DIR`, seats use the letter badge. `STATION_SEATS` overrides the roster `station` array. `LIVE_ROLE_COORD`, `LIVE_ROLE_OPS`, and `LIVE_ROLE_REVIEW` override the routing file and the roster role text.

No secrets belong in this tree. Roster and site mode are the committed JSON under `collector/`.
