---
title: Routes
sidebar_label: Routes
---

# Routes

Public reads: `GET /`, `GET /healthz`, `GET /robots.txt`, and, when `feed/site.json` has `"public": true`, `GET /history`, `GET /history/cards`, `GET /history/transitions`, and `GET /history/export`. `GET /live-events.json` needs a session unless the site is public. `POST /login` and `POST /logout` are the session.

Seat and ingest routes:

| Method | Path | Who |
| --- | --- | --- |
| POST | `/cursor/webhook` | Cursor, `X-Webhook-Signature` HMAC |
| GET | `/fleet-mode` | no auth |
| POST | `/fleet-mode` | ingest secret, or the blinky seat key. Any other seat is `403 not the mode switch` |
| GET | `/archive` | `ARCHIVE_KEY` bearer |
| POST | `/ingest`, `/ingest/delta` | ingest secret |
| POST | `/activity` | the seat's own token |
| POST | `/activity/ingest` | ingest secret |
| GET | `/activity/pull` | ingest secret |
| POST | `/emit` | sample emitter |
| GET | `/ingest/events` | ingest secret |
| POST | `/inbox` | ingest secret, or a seat key for its own handoff |
| GET | `/inbox/<seat>` | that seat |
| POST | `/inbox/<seat>/ack` | that seat |
| POST | `/inbox/<seat>/pass` | that seat |
| POST, GET | `/inbox/builder` | ingest secret, or Builder's token for the GET |
| POST | `/ingest/source` | ingest secret |
| POST | `/clock` | a clock seat. An empty open list returns `started: false` and `reason: no open work` |
| GET | `/routing` | read-only map. No keys and no webhook URLs |
| POST | `/cards/start-after` | owner or a fleet seat, inside 30 days |
| POST | `/cards/seed` | ingest secret |
| GET | `/cards` | that seat's key. The coordinator may read any seat |
| GET | `/wake-stats` | seat key |
| GET | `/nudges` | the routing operator |

There is no GitHub webhook and no Railway webhook. Inbound HTTP from outside the fleet is the Cursor webhook. Seat wakes are outbound `SEAT_WEBHOOKS`. The critic chat doorbell is outbound `SEAT_CHAT_DOORBELL`. The doorbell refuses a cloud-agent resume URL.

`GET /board`, `GET /inbox`, and `GET /live` are not routes. The board page is `/`. The inbox API is `/inbox/<seat>`.
