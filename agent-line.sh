#!/bin/sh
# One cloud-agent line on the live board: launch | reply | finish | cancel.
# The bearer is LIVE_KEY or ACTIVITY_TOKEN. This process reads it from the environment.
# It is never placed on argv and never printed. LIVE_URL is the board. LIVE_SEAT defaults to Builder-cloud.
set -eu
action="${1:-}"
agent="${2:-}"
tag="${3:-}"
exec python3 - "$action" "$agent" "$tag" <<'PY'
import datetime, json, os, sys, urllib.error, urllib.request
action, agent, tag = (sys.argv[1:4] + ["", "", ""])[:3]
if action not in ("launch", "reply", "finish", "cancel") or not agent:
    sys.exit("usage: agent-line.sh launch|reply|finish|cancel <agent-id> [tag]")
key = os.environ.get("LIVE_KEY") or os.environ.get("ACTIVITY_TOKEN") or ""
url = (os.environ.get("LIVE_URL") or "").rstrip("/")
seat = os.environ.get("LIVE_SEAT") or "Builder-cloud"
if not key or not url:
    sys.exit("LIVE_URL and LIVE_KEY (or ACTIVITY_TOKEN) are required")
body = {"t_ct": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "kind": "agent", "action": action, "agent": agent, "seat": seat}
if tag:
    body["tag"] = tag
data = json.dumps(body).encode()
req = urllib.request.Request(url + "/activity", data=data, method="POST",
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        sys.stdout.write(str(r.status) + "\n")
except urllib.error.HTTPError as e:
    sys.stdout.write(str(e.code) + "\n")
    sys.exit(1)
PY
