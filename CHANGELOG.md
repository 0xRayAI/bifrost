# Changelog

## Unreleased

- Sync the live app to xray `house/live/app` at `a0090056` (includes the Arch1 backlog tile). `/healthz` keeps `arch1_inbox` `{open, head, backlog}`. Collector modules are recommitted from that tree's assemble sources. `arch1_launch` stays off.
- The board shows Arch1 backlog depth before open now. A card that already has an L3 does not get another while that backlog is open. #731 #768.
- A missed /healthz makes the supervisor exit 1 so ON_FAILURE replaces the one replica. The replica pid is not SIGKILL'd. The collector is not signaled for that miss.
- The board header says Refreshed for the page pull. The light says Last activity for the newest GitHub event.

## 0.1.0 — 2026-10-22

- First tree. The live app is the repo root, copied from 0xRayAI/xray main `b49fe24cdfbc85126af3337a7e4f129c4e1a9d2f` (`house/live/app`). That path matches this commit on main.
- Collector modules are committed (`house/live/feed` assemble set plus `house/live-mesh/fetch_feed.py` at `collector/upstream/fetch_feed.py`). A clean checkout satisfies the Dockerfile guard. There is no assemble step.
- Railway root is `/`. The health route is `/healthz`.
- xray `house/live` is unchanged. The pointer lands after this SHA is the tree Railway builds.
