#!/usr/bin/env bash
# This repo builds from git. Railway root is /. There is no assemble step.
# Forge connects burst-live after critic PASS. Do not upload this tree with the Railway CLI.
echo "bifrost builds from git at repo root /. No assemble step. Service connect waits on critic PASS." >&2
exit 1
