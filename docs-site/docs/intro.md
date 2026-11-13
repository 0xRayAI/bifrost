---
title: Bifrost
sidebar_label: Bifrost
slug: /
---

# Bifrost

Bifrost is the live board at [https://bifrost.0xray.dev](https://bifrost.0xray.dev). A pull, an issue, and a comment become a card. The card files a line on a seat inbox. The seat is woken to act.

This repository is the service. `collector/` is committed. Railway builds the Dockerfile from git at `/`. `deploy.sh` refuses a laptop upload. Forge connects the burst-live service to a reviewed SHA of this repo. Until that connect, the public board is the tree deployed from the xray checkout with `house/live/app/deploy.sh`. A commit here does not move the public board by itself.

The page draws a kanban above the activity list. Columns are `open`, `review`, `fix`, `merge`, `retest`, and `done`. A click opens that card's timeline.

A cloud agent is its own board row: `bcId`, owning seat, linked card, pull, and state `running`, `finished`, or `failed`.
