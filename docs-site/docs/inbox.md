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
