# Changelog

## Unreleased

- A quiet pass writes a clock file and leaves the event document in place. The clock file omits the board. A clock file over 2 MiB still moves the health clock and is not parsed. `card_age` is reported and does not change `ok`.
- A shed inbox row whose card is already closed or merged is acked. A still-open shed row is unshed back into the queue, keeping its original time. Shed rows older than `BIFROST_SHED_TTL_S` (default 24h) are acked. The sweep runs at boot and on the governor tick. #69
- A line marked shed is never the live head, including the rank-2 fallback. A ready handoff still leads a same-card tip. xray#823
- An unassigned issue wakes arch1 when forge is dark, and forge otherwise. xray#815
- A newer merge tip on the same pull is the live head. An older tip on that pull does not stay in front. A ready handoff still leads. xray#813 bifrost#39
- A new issue open leads an older parent tip. A passed parent stays shed, so later tips on that card do not take the head. xray queue twin.
- A green head that is still critic's posts one ci_pass line to critic. That line rings the chat. A pass on that sha does not. xray#806 bifrost#32
- The roster lists `fleet.seats` plus `product_nodes` only. A seat with no signal for 7 days is dormant.
- The roster calls a 15-minute sighting seen, not active. Working is the same bit as the mesh light. A prompt with no card name does not spin every card.
- A push, merge, or review lights the mapped seat for the turn window, including an Arch1 merge after the card closes. An outside seat missing from the GitHub actor map still needs `live-inbox --turn start/end`.
- `fleet.cloud.last_ct` follows the same cloud launch and finish lines as `cloud_agents`. A finish moves `last_ct` to that time or later, and `open_agents` is empty when nothing is running.
- The mesh keeps a CloudAgents node. A non-empty `open_agents` lights it. An empty list leaves the node with `last_ct`. Seat working on the canvas uses the same bit as the roster chip.
- The board tick is the station-nudge scheduler. Weekday half hours 7:30–17:30 CT post `nudge:station:<seat>:<hour>` for forge, critic, and blinky, and for arch1 when that seat is in the fleet, even when the inbox already has work. The queue still holds that line behind the head. The launchd plist is not loaded.
- An outside seat's stall card follows that seat's comment, push, or close on the card. A prompt with no working_on still does not spin every card that seat owns.
- Sync the live app to xray `house/live/app` at `f2008613`. A critic ready or green head rings the owner's chat after the inbox wake. The image COPY list includes `chat-doorbell.mjs`. Chat keys stay in env.
- Sync the live app to xray `house/live/app` at `bc0a635e`. A card spins only when a seat's working_on names it, or a running cloud row is bound to it. A prompt pulse with no working_on does not spin every card that seat owns.
- Sync the live app to xray `house/live/app` at `a0090056` (includes the Arch1 backlog tile). `/healthz` keeps `arch1_inbox` `{open, head, backlog}`. Collector modules are recommitted from that tree's assemble sources. `arch1_launch` stays off.
- The board shows Arch1 backlog depth before open now. A card that already has an L3 does not get another while that backlog is open. #731 #768.
- A missed /healthz makes the supervisor exit 1 so ON_FAILURE replaces the one replica. The replica pid is not SIGKILL'd. The collector is not signaled for that miss.
- The board header says Refreshed for the page pull. The light says Last activity for the newest GitHub event.

## 0.1.0 — 2026-10-22

- First tree. The live app is the repo root, copied from 0xRayAI/xray main `b49fe24cdfbc85126af3337a7e4f129c4e1a9d2f` (`house/live/app`). That path matches this commit on main.
- Collector modules are committed (`house/live/feed` assemble set plus `house/live-mesh/fetch_feed.py` at `collector/upstream/fetch_feed.py`). A clean checkout satisfies the Dockerfile guard. There is no assemble step.
- Railway root is `/`. The health route is `/healthz`.
- xray `house/live` is unchanged. The pointer lands after this SHA is the tree Railway builds.
