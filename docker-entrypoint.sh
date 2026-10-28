#!/bin/sh
# A missed /healthz exits this process 1. ON_FAILURE replaces the one replica.
# HEALTH_EXIT=off runs the server directly. A local run with no Railway env does too.
set -eu
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
if [ "${HEALTH_EXIT:-}" = "off" ]; then
  exec node server.mjs
fi
if [ -n "${RAILWAY_ENVIRONMENT:-}" ] || [ "${HEALTH_EXIT:-}" = "on" ]; then
  exec node health-exit.mjs
fi
exec node server.mjs
