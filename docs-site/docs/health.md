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

`stalled` is a separate flag. It follows the accepted clock when that clock is newer than the collector child start, and the child start otherwise. The window is `COLLECTOR_WATCH_S` (default 45 seconds) times `COLLECTOR_WATCHDOG_N` (default 6, 270 seconds). The collector writes a beat at the start of a pass and again at the end. A fat beat moves the accepted clock before the 2 MiB return, so that write is not stalled. Raw mtime of the event file or the beat is only the empty-board guard: an empty card list does not replace a live board while `stalled` is true or that file age is past the same window.

`board` on the health body is `building`, `empty`, or `live`. `origin` is the pinned public origin, or null. The body carries a repo count and times. `unreadable_repos` lists the names the collector could not read. Those names are real when the site is public. They are masked as `private repo #n` only when the site is gated. The committed `collector/site.json` is public. `LIVE_PUBLIC` wins over that file.
