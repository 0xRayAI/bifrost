# Board data map

The page reads `GET /live-events.json`. Production numbers below are the feed at `2026-10-20T07:03:41-05:00`, before this change is deployed. GitHub search for the same Chicago day-window is the check.

## Stats

| Field | Source | Transform | UI | Expected | Live at 07:03 CT | Status |
|---|---|---|---|---|---|---|
| issues_opened_24h | collector `issue_open` | `feed/live_board.py` `stats` | tile “issues opened 24h” | count equals `*_ids` | 20 / GitHub 21 | PASS (feed) |
| issues_closed_24h | `issue_close` | same | tile | count equals ids | 7 / GitHub 7 | PASS |
| prs_opened_24h | `pr_open` | same | tile | count equals ids | 19 / GitHub 30 | PASS on the feed. GitHub is higher because pulls the cursor already passed are not re-listed until the one-time 36h rewind in `poll_pulls` |
| prs_merged_24h | `kind=merged`, or `pr_close` with `merged_at` / `merged: true` | `stats` window 24h | tile “PRs merged 24h”, click filters to `prs_merged_24h_ids` | count equals ids, and a close that carries `merged_at` is merged | 20 events / GitHub 32 | FAIL on the live feed until deploy. The 12 missing merges are 407, 408, 422, 424, 425, 426, 427, 428, 432, 433, 435, 436. Code records them on the next pulls walk (`merged:day`) |
| prs_closed_unmerged_24h | `pr_close` whose key is not in merged | same | tile | 0 when every close in the window merged | 0 / GitHub 0 | PASS |
| issues_open / prs_open / open_total | open events that still carry `pr_state` and are not closed | same | “open now” tile filters cards that are not closed and not stage done | fleet cards, not every GitHub issue | 37 + 2 = 39 / GitHub 45 + 5 | PASS for the fleet card set. GitHub’s open count includes items the board does not track |
| tile click | `stats.*_ids` | `index.html` `renderWave` | `button.wstat` `aria-pressed`, class `on` | second click clears the filter | unused on production | PASS in `tests/board-face.test.mjs` |

## Cards

| Field | Source | Transform | UI | Expected | Live | Status |
|---|---|---|---|---|---|---|
| owner | card `owner`, else packet `next owner` | `cardSeat` then `paintEdge` | left edge `rgb(var(--seat-<slug>))` when that token exists, else `L.COLOR` | mill is `214, 196, 140` in dark and `92, 68, 16` in light. The kit color map drops mill, so a missing token used to leave `.wcard` on `--card-edge` `#3b82f6` | state-colored edge | PASS `tests/board-face.test.mjs`. Production still has the old CSS until deploy |
| state | card `state` | badge `.wbadge.state` | badge text | state is a badge | state was the edge color | PASS in this page |
| stage done or state closed | card | `laneBucket` → `done` | collapsed “done” | not in an open waiting group | mixed | PASS |
| cloud `finished`/`failed`/`stale` and the PR is merged or closed | `cloud_agents[].card` | `laneBucket` | done | out of Open | finished rows sat in the open cloud group | PASS |
| cloud finished and the PR is still open | same | `laneBucket` → `review` | “in review” | not in Open waiting | same | PASS |
| empty seat group | `L.boardGroups` | skip when every bucket is empty | no `.wgroup` with nothing under it | no empty header | empty headers existed | PASS |
| group | card bucket, else seat | default `status`. `#cardGroup` stores `bifrost-card-group` `agent` | `.wgroup` is the status. By agent, `.wgroup` is the seat and `.wsub` is the status | status on first load. The toggle switches to one group per seat | seat groups were the only layout | PASS `tests/board-group.test.mjs` |

## Recent changes and history

Root cause: `archive.mjs` `cardHistory` keeps the latest snapshot per key (owner, state, title, times). It did not carry a merged verb, and `renderCardRecent` concatenated owner, state, title, and a raw ISO time with no gap. The same key on the live board is a different object (`merged_by`, beats).

The page now paints those rows with `.wcard` (owner edge, verb, Chicago time). `cardHistory` sets `verb` to `merged` when a stored beat or `merged_by` says merge, else `closed` when the snapshot is closed. If the archive row has no beat, the page still says merged when the live card has `merged_by` or a merge beat.

| Field | Source | Transform | UI | Expected | Status |
|---|---|---|---|---|---|
| verb | archive beats / `merged_by`, else the live card | `changeVerb` | badge + meta | “merged” or “closed”, not a bare state word glued to the title | PASS |
| actor | `owner`, and `merged_by` when present | `historyCard` | `owner · verb` | a real seat, spaced | PASS |
| time | `updated_ct` / `closed_ct` | `wbCt` America/Chicago | `.wage` | clock plus `CT`, not a raw ISO string | PASS |

## Work and queue

| Field | Source | Transform | UI | Expected | Status |
|---|---|---|---|---|---|
| track item | `header.track` from `deriveTrack` | page drops `phase=acked` or `label=acked` | `#trackList` | real per-seat work | PASS |
| lane header | item lanes | header only when the filtered lane has a row | `.lane` | no empty header | PASS |
| separators | seat, label, title | joined with ` · ` | one line | `forge · working · real task`, not `blinkyackedhandoff` | PASS |
| queue row | `openQueue` in `server.mjs` | types in the open-ask set only | `#queueList` | packet, dispatch, ready, critic_fail, needs_human, comments, pr/issue opens. No nudge, info, or stall | PASS |
| age | `t_ct` | `wbAge` | same line | age after the title | PASS |

## Roster, activity, rewind

| Field | Source | Transform | UI | Expected | Status |
|---|---|---|---|---|---|
| seat chip | `L.AGENTS` + `L.seatView` | name in `.nm`, `title` is the full label. No `.st`, no role line, no ACTIVE/IDLE/WORKING/LIVE text | dot + name | a lit seat rolls a seat-color sheen across the name (1.2s) for as long as `seatView.lit`. An idle seat's name stays still. Reduced motion keeps a lit name static and highlighted. The dot does not blink. A long name truncates with an ellipsis and the full name is the hover title | PASS `tests/board-face.test.mjs` |
| activity | live events, or `GET /history?date=` | shared fold. Open unless `bifrost-folds.activity` is `closed`, or the older `bifrost-activity` value is `collapsed`. A toggle still writes both keys | `#activity` | open on first load, `#log` max-height 16rem, overflow auto, date `<select id="historyDay">`, times in CT | PASS |
| folds | mesh, stats, roster, cards, cloud, recent, history, work, queue, activity, kanban | one `.fold` / `.fold-head` / `.fold-body`, `data-fold`, `localStorage bifrost-folds` | header toggle, count in `.fold-sum` | mesh, stats, roster, cards, and activity are open on first load, on desktop and mobile, in both themes. A stored `open` or `closed` still wins. The other sections stay collapsed until opened. An open body max-height is 16rem and scrolls, except the mesh body and `#waveBody`. The card list flexes to fill the 720px wave (`min-height` 220px, no 16rem cap) | PASS `tests/board-folds.test.mjs` |
| rewind | `#slider` | bottom of `#meshPanel` | range | the slider box sits inside the mesh panel, at its bottom. The roster sits at the top of that card. Board stats sit above the mesh | PASS |

## Cloud rows

| Field | Source | Transform | UI | Expected | Live at 07:03 CT | Status |
|---|---|---|---|---|---|---|
| state running | webhook or `cloud_agent` launch/reply | `boardCloudAgents`, then `markStaleCloud` when `now - updated_ct > 6h` | open group “cloud agents (N)” only for `running` | a fresh run lights the owner | `bc-22f1b70d-…` running since 2026-10-19 17:56 CT, plus Oct 18 and Oct 15 forge rows | FAIL on production until deploy |
| state stale | same row past 6h | `state: 'stale'`. `applyCloudOwners` ignores it. Python `CLOUD_STALE_S` does the same for `working_state` and `cloud_state` | collapsed “cloud done” | Oct 18 `bc-8450c4aa-ed0a-5fb3-9748-f09a044c848f` and Oct 15 `bc-72f1b3b2-a56e-5ce3-9162-76f264e06aea` do not light forge | both still `running` | PASS in code. `tests/cloud-board.test.mjs`, `tests/test_activity_281.py` |
| owner active | running row with a known seat | `applyCloudOwners` | seat dot | running cloud agent keeps the seat active inside 6h. A non-cloud `working_via` stays | forge idle while three running rows existed | PASS in code, not deployed |

Decision: expire. A running row with no update for more than six hours becomes `stale`. This environment has no Cursor API key, and a list of agents would not name the launching seat. The two old forge rows are stale. A launch or reply inside six hours still keeps the seat active (the 25 min and 61 min cases).

## Mesh signals

These are canvas clocks, not CSS classes added and removed with `setTimeout` or `animationend`.

| Signal | Where | Trigger | Duration | Keep |
|---|---|---|---|---|
| Hot ring | `app/public/index.html` `drawNode`, the `isHot && !bare` strokes | `live.js` `activeSeats`. Live: a flash from `playFresh`. Rewind: `recentItems` inside two ping windows. Letter seats only. Three strokes at r+5, r+10, r+15. One-time, not a loop | `draw` passes `FLASH_MS` (2600). `activeSeats` keeps the seat while age `< 2 * flightMs`, so 5200ms from the flash start | yes. Legend “Hot ring 5.2s” |
| Seen ring | `drawNode` when `seen && !isHot` | `seatView.seen` for live or active. One stroke at r+4 on a letter or square. An avatar strokes the same ring outside the image. Not the name roll | while the seat stays seen | yes. Legend “Seen ring” |
| Depart pulse | `index.html` `draw`, `pk.src === key`, then `L.pulse` | a ping whose source is this node. `live.js` `pulse` line 117, `PULSE_MS` 900 | one sine over the flight. Flight is `FLASH_MS` 2600ms, up to 7800ms when the hop list is long (`playFresh` `dur`). Reduced motion returns 0 | yes. Legend “Depart pulse” |
| One-node ring | `index.html` `drawPing`, `pk.src === pk.dst` | `fixPings` when `from === to` and the hop list is shorter than 2 | alpha 1→0 and radius 24→46 across that same flight | yes. Legend “One-node ring” |
| Roster name roll | roster `.seat.live .nm` | `updateText` toggles `.live` from `L.seatView(seatState(a[0], hot)).lit`. The canvas working label is gone | a seat-color band sweeps the name on a 1.2s loop while the seat is lit and stops when idle. `prefers-reduced-motion` shows that name static and highlighted | yes |
| Wire glow | `live.js` `wireGlow`, drawn on edges | idle too, an 8s lap | not a node ring | kept on the wires. It is not the node blink |
| Packet halo | `drawPing` radius 18 | on the packet, not the node | the flight | kept on the packet |

## Theme

| Token | Where | UI | Expected | Status |
|---|---|---|---|---|
| color | `/* theme-tokens-start */` … `/* theme-tokens-end */` in `index.html` | every panel, mesh plate, cards, badges, dots | no hex outside that block | PASS `tests/theme-colors.test.mjs` |
| scheme | boot script sets `data-theme` from `localStorage bifrost-theme` or `prefers-color-scheme` | sun/moon `#themeToggle` | persists | PASS `tests/board-face.test.mjs` |
| type | `inter-latin-400.woff2`, `inter-latin-600.woff2`, `jetbrains-mono-latin-400.woff2` | Inter for text, JetBrains Mono for times and SHAs, `font-display: swap` | self-hosted, `font/woff2` in `server.mjs` | PASS |
| contrast | seat colors differ per theme | body, card title, stat label, badge, seat name | WCAG AA 4.5:1 in the face test | PASS |

## Blaze prompts

A chat line reaches the board only when a seat posts it. The server does not read a chat transcript. Production at `2026-10-20T07:21:01-05:00` (`GET /live-events.json`, 1631 events) has **no** `seat_prompt` and **no** `prompt_message`. In `2026-10-20T06:15:00-05:00` … `2026-10-20T07:17:59-05:00` the feed has 26 `seat_turn` lines (blinky, arch1, critic), two issue comments, one pull comment, and Blaze opening xray #451 at 06:51:49. Forge’s seat row is idle: `last_ct` `2026-10-20T06:18:09-05:00`, `via` `github`, `working` false. Today’s DM words to forge are not on live.

| Step | File:line | What is stored |
|---|---|---|
| CLI | `tools/live-inbox` 393–399 | `POST /activity` with `t_ct`, `seat` (the key’s seat), `kind: prompt`, `action: sent`, `from` (default is the `name:` line in HOUSE.md), `to` (the seat), optional `room` (≤40, plain id), optional `note` (one quoted line) |
| Auth and shape | `app/server.mjs` 2793–2822, `validActivity` 2584–2610 | Seat comes from the key. `ACT_MAX_BODY` is 1024. `ACT_KEEP` is 5000 lines. Keys matching `body`, `text`, or `message` are refused (`ACT_BANNED`, 2358). Every field except `note` and `pr` is `ACT_VALUE`: 1–80 of `[A-Za-z0-9 ._:@#+/-]` and must not contain those three words |
| The line | `note` only, `ACT_NOTE` 2360 | Prompt only. 1–240 of letters, digits, space, and `._:@#+/?'",;!()-`. A sentence may contain the word “message”. A turn with `note` is refused. `room` is a short name, not the words |
| Stored row | `server.mjs` 2817–2821 | `id`, `seq`, `seat`, `t_ct`, `kind`, `action`, plus `to`, `from`, `room`, `note` when sent. Appended to `activity.jsonl` |
| Board event | `activityEvent` 2401–2413 | `kind` `seat_prompt`. `from` is `Blaze` when the sender is blaze or empty (`promptSender` 2396). `to` is the seat. `label` is `Blaze → forge` or `Blaze → forge: <note>`. `note` and `room` are copied onto the event. Room is not glued into the label |
| Feed | `GET /live-events.json` 3084 | The event is in `events[]` with the other seat activity. The page polls that file |
| UI | `live.js` `promptView` 186. `index.html` `paintPrompt` 1405, `renderLog` 1429, history 1633, CSS 511–513 | One line, `Blaze → <seat>: <note>`. Over 72 characters the visible text is cut with `…` and a button. Click shows the full stored line (`aria-expanded`). A label that is only `prompt sent` or `message` is not used as the note |

The box collector is a second path and it still drops the words. `feed/live_fleet.py` `scan_prompts` 750 and `_prompt_line` 808 emit `kind: prompt_message` with label `message` and never read `text` or `note`. `scan_activity` 914–917 maps `prompt sent` as from the seat to `to`, which is not the CLI’s `from: blaze`. `feed/live_flow.py` 15 keeps that hop and does not copy `note`. `feed/push_payload.py` `act_line` drops `note` when it copies a pulled line. The page rewrites a `prompt_message` whose label is `message` into `from → to` with no fake body.

Until a seat posts `--note`, the board can show `Blaze → forge` and cannot show the DM.

## Contract

`tests/board-face.test.mjs` loads a fixture and checks: merged tile matches its id list and filters the board, a finished-and-merged card is under done, a stale cloud row is not in the open cloud group, an acked lane has no header, the queue drops nudges, the log has no duplicate rows, the slider is inside the mesh panel, activity starts open, and both themes clear 4.5:1 on body text and card titles.

`tests/test_board.py` `test_pr_close_with_merged_at_counts_as_merged` checks the merged-versus-unmerged split. `tests/test_activity_281.py` `test_launcher_idle_after_six_hours` checks the stale cloud window.
