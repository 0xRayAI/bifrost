---
title: Inbox
sidebar_label: Inbox
---

# Inbox

A seat reads `GET /inbox/<seat>` with its own key. Another seat's inbox is 403. The query flags are `since`, `all`, `stale`, `queue`, and `backlog`.

`queue=1` returns the head: ready handoffs, then cards whose packet names this seat as R, hotfix first, then P0 or P1, then the other cards for that seat. The response names `head` and `backlog`. A station nudge stays behind that head while any other line is open. A read does not ack.

`POST /inbox/<seat>/ack` accepts `{"id"}`, `{"upto"}`, `{"stale":true}`, or `{"all":true}`. `upto` acks the stored prefix through that id. `stale` acks up to 1000 lines that have a close or merge event, or a closed or done card. A line the seat already acked gets no further L1, L2, or L3. `live-inbox <seat> --upto <id>` is that prefix receipt. The board sweep acks a previous-day station line, a closed-card nudge, and a comment on a closed issue or pull, so the seat does not have to name that id.

`POST /inbox/<seat>/pass` with `{"id"}` hides that line. The card stays open. It is not an ack. The public board deployed from the xray tree has no pass route. On that board, `live-inbox --pass` exits before the POST and reports that the board has no pass route.

An owner message is recorded with `live-inbox <seat> --prompt --from owner --note "<gist>"`. `--from` defaults to the house owner line when it is omitted. Ack a handled line with `live-inbox <seat> --ack <id>`. `--ack all` acks every open line and is only for a queue that is finished.

A live card with no beat for `NUDGE_L1_S` (default 3600) sends one L1 inbox line to `nudge_to`, else the packet next owner, else the card owner. A later L3 updates that same record. It does not add a second inbox line. `POST /inbox/<seat>/postpone` with `{"id","phase"}` keeps that line off the queue head until the card reaches `phase` (`review`, `fix`, `merge`, or `retest`). Postpone does not ack the issue. The public queue stays on the issue row. An unacked inbox line steps L1, L2, and L3 on that seat. A missing handoff nudges the owing seat. The coordinator is not woken to reassign.

The station nudge is `nudge:station:<seat>:<Chicago date>`. The hour guard is still weekdays, America/Chicago, 7:30 through 17:30. A later hour the same day updates that row. The sentence is to run station and re-read OP-PROC. Ack only after the re-read. A pulsar line is the station card and is not acked from chat.

A comment is a beat on the card. It does not open a second card. `@arch10x` is the arch1 needle. A bare `@arch1` does not route.

## What wakes a seat

The default filter is actionable. Set `SEAT_WAKE_FILTER` to `all`, `actionable`, or JSON `{mode, seats}`. When the env var is unset, roster `wake_filter` is that same JSON. A line still lands. A skip is reason `filter`.

Someone outside the fleet is reached by an @-mention of their real GitHub login. That mention becomes their inbox line and can wake them.

A fleet seat is woken by a direct handoff packet (`live-inbox <seat> --handoff <to> --pr <owner/repo#n> --kind ready --sha <head>`). An @-mention of the seat id wakes that seat. An @-mention of the seat's bot login lands a line and does not wake it. The filter matches the seat id only. Matching the login or an alias would wake on every mention of a shared bot, which is the flood this filter holds back.

A new head on an open pull does not wake the reviewer by itself. The author owes a `ready` handoff at that head. A GitHub comment does not clear `handoff missing`.

`wake_filter.reviewer_on_new_head` set to `true`, or a per-seat map such as `{"critic": true}`, wakes that seat once per pull head. `SEAT_WAKE_REVIEWER_ON_NEW_HEAD=1` is the same switch. The default is off. Draft and closed pulls stay quiet. The line still passes the wake gate, fleet mode, and the own-actor skip. A push that never emits `pr_commit` on a long-running board is not confirmed, so this switch only fires when that event is stored.

A nudge writes `nudge_level` and `nudged_at`. It does not change `t_ct`. The line keeps the time it arrived. The reminder is the level and `nudged_at`.

A routed ask is a line with `ask: true`. A needle hit sets `routed_by` to `needle`. A review request sets `routed_by` to `kind`. That flag wakes the seat. The wake does not look for `@seat` in the title. `wake_filter.wake_on_ask` set to `false`, or `SEAT_WAKE_ON_ASK=0`, turns it off. A per-seat map such as `{"critic": false}` turns it off for that seat. The default is on. A new head still does not wake by itself.

A line already stored is not re-read when this config changes. The body is not on the line. The filter applies to new lines only.

## One login, one seat

`bifrost init --check` fails when one login or alias, compared with no case and no `[bot]` suffix, belongs to two seats. It also fails when the same `@handle` needle is on two seats. The message names the handle and both seats. Startup writes the same warning and still boots. `GET /routing` includes `conflicts`. The first seat in the map keeps the login and the alias. One event id routed to two seats is moved to the later seat. It is not copied.
