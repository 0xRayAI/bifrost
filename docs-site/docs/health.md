---
title: Health
sidebar_label: Health
---

# Health

`GET /healthz` and `HEAD /healthz` need no auth. HTTP is 503 when `ok` is false, and 200 when `ok` is true. `health-exit.mjs` treats 503 as a live process, so a quiet feed does not replace the replica. A Railway deploy healthcheck uses the same path and does not share that exception. A missed probe that the supervisor treats as down exits 1 so the platform can replace the one replica. The collector is not signaled for that miss.

`ok` is false only when `feed_quiet` is true or `cards_behind` is true.

`feed_quiet` is true when the collector is watched and the accepted clock is older than `COLLECTOR_STALE_S` (default 180 seconds). The clock is the event file, or the quiet beat, whichever the reader accepted. A quiet pass writes `github-events.beat.json` and leaves `github-events.json` in place. The beat omits the board, so the file stays small enough to parse. `generated_at` and the rest of the header still move. A beat over 2 MiB still moves the clock and is not parsed. An empty beat does not move the clock.

`cards_behind` is true when a card-worthy event, never CI and never `pr_commit`, is newer than the board or the card clock by more than `CARD_BEHIND_S` (default 180 seconds).

`collector_age` is the age of that accepted clock. `card_age` is the age of the last board card change (`CARD_STALE_S` default 600 is a label). `data_age` is the newest GitHub event time (`DATA_STALE_S` default 21600 is a label). `box_age` is the last box status push. `card_age`, `data_age`, and `box_age` do not change `ok`.

`stalled` is a separate flag. It uses the raw mtime of the event file or the beat, inside `COLLECTOR_WATCH_S` (default 45 seconds) times `COLLECTOR_WATCHDOG_N` (default 3). A collector that is still writing a fat beat is not stalled. It is quiet until the reader accepts that mtime.

`board` on the health body is `building`, `empty`, or `live`. `origin` is the pinned public origin, or null. The body carries a repo count and times. It does not carry repo names.
