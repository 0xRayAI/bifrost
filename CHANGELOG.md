# Changelog

## Unreleased

- One login, alias, or `@handle` claimed by two seats is a startup warning and a `conflicts` array on `GET /routing`. The process still boots. The first seat in the map keeps the claim. `wake_filter.reviewer_on_new_head` wakes a reviewer once per pull head and stays off.
- A board ready handoff (type `packet`, kind `ready`) on the current head wakes the seat it is addressed to. Its kind is `ready`, so the filter's `packet` rule never matched it. A queued ready handoff (the seat is busy) still offers its wake; busy sets queue position, not the wake. A head the card moved past is still dropped, the author's own line still skips, and a delivered line wakes once. #108
- A review or `critic_fail` line on a sha the card head has moved past, while the card's verdict is stale, is settled: it leaves open work, stops line-nudging the author, and a `review` line is acked by the board sweep. A review at the head stays. #108
- The collector's `green head returns to critic` line wakes critic once Actions has cached an all-green run list for that full sha, and is remembered like `CI green on current head`. A partial green from the collector still stays quiet. #108
- The Actions-runs retry counts the first arm and each timer retry. A burst of check events on one pending head no longer spends the 30-try cap and drops the head before CI finishes. #108

- `/healthz` `wakes` reports `disabled` when the last attempt was a paused routine (HTTP 400, automation disabled), and `stale` when a fail is older than 6 hours, instead of leaving a sticky `fail`. #105
- A later line nudge updates the existing inbox row in place (same id, bumped level and time). It does not append a second line. Once the fired set holds that line's key, L2 and L3 of the ladder do not wake; that is intended. The key is dropped when the line is acked or the card closes, so later stale work on the same card can fire once more.
- After the #83 wake filter, two holes still rang seats. A later line nudge copied a board-only GitHub line (a new-head heads-up, a push, a deploy) and prefixed `nudge L1:` on the reason, which the filter treated as an act-now signal. The stall clock also minted a new `clock:<started_at>` id on every run, so one stale line (a #1082 breaker, for example) could wake the seat over and over, and the title counted those clock lines as open work. A stall now fires at most once per card or line id and the title count matches the unacked work inbox. A `needs_human` line to a seat wakes once per card; a line addressed to a human does not wake a bot. Part of 0xRayAI/xray#942.


- A seat is not woken for a GitHub event whose actor is that seat's own App or bot login. The line is still stored, and other seats still wake. Packet R still rings the opener. xray#1060
- The wake breaker (the comment count and the pause on a repo#n) is written to the live volume and reloaded on boot, so a redeploy does not clear it. xray#979

- A quiet pass still leaves the event document in place when the board signature matches. A card change with the same events rewrites the document, then writes a beat that carries `board_sig` and no board body. `updated_ct` and `closed_t` do not force that rewrite.
- The stall clock moves on a board event or an ack. CI, deploys, health, X, and seat presence do not reset it. A still board wakes once and waits for the next move. A nudge line is that wake. `POST /clock` starts the same run, including an empty board. Weekly burn still keeps the empty wake quiet.
- The collector writes the watchdog beat at the start of a pass, and the stall window defaults to 270 seconds. A pass of about two minutes is no longer inside ten seconds of the kill. #65
- One nudge record per card. A later L3 updates that record and does not add an inbox line or wake the seat again. `POST /inbox/<seat>/postpone` keeps the line off the queue head until the card reaches a later phase. The board sweep acks a previous-day station line, a nudge whose card is closed, and a comment on a closed issue or pull. `--upto` still acks a prefix the seat names. The station id is the Chicago date. Shed age at or past `BIFROST_SHED_TTL_S` is acked, and that TTL caps at 7 days.
- Packet R files that seat, including the opener, once inside 48 hours. A dead assignee token stops writes for this process and does not finish the 14-day walk. The open-card refill does not replay routes a seeded volume already refused. The assignee latch remembers every 4xx except 401, treats 401 as a dead token for the process, and leaves a network miss unremembered. The server mints the assignee token and redacts it on collector logs.
- The manual says `GET /archive` takes the `ARCHIVE_KEY` bearer, `GET /fleet-mode` is open, and `POST /fleet-mode` takes the ingest secret or the blinky seat key. `stalled` follows the accepted clock. `unreadable_repos` lists names, masked only when the site is gated. The card does not store gates. Rollback stays `house/live/app/rollback.sh` on the xray tree.
- A quiet pass writes a clock file and leaves the event document in place. The clock file omits the board. A clock file over 2 MiB still moves the health clock and is not parsed. `card_age` is reported and does not change `ok`.
- A shed inbox row whose card is already closed or merged is acked. A still-open shed row is unshed back into the queue, keeping its original time. Shed rows at or older than `BIFROST_SHED_TTL_S` (default 24h, capped at 7 days) are acked. The sweep runs at boot and on the governor tick. #69
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
