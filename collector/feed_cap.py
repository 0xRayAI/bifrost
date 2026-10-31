"""Keep the newest events in the live GitHub document. No collector imports.

The boot script runs this file before node starts. Importing live_mesh fails there:
fetch_feed.py is assembled under collector/upstream, not beside live_mesh.py.
"""
import json
import os
import sys
from pathlib import Path


def feed_cap():
    """Newest events kept in the live document. The archive holds the rest."""
    try:
        n = int(os.environ.get("LIVE_FEED_CAP", "2000"))
    except ValueError:
        return 2000
    return n if n > 0 else 0


def window_events(events, cap):
    if not isinstance(events, list) or cap <= 0 or len(events) <= cap:
        return list(events) if isinstance(events, list) else []

    def key(item):
        i, e = item
        if not isinstance(e, dict):
            return ("", "", i)
        t = e.get("t_ct")
        return (t if isinstance(t, str) else "", str(e.get("id") or ""), i)

    ranked = sorted(enumerate(events), key=key)
    return [e for _, e in ranked[-cap:]]


def window_note(notes, events):
    """The live document is the newest window. Older days stay in the history archive."""
    oldest = None
    count = len(events) if isinstance(events, list) else 0
    if isinstance(events, list):
        for event in events:
            if not isinstance(event, dict):
                continue
            stamp = event.get("t_ct")
            if isinstance(stamp, str) and (oldest is None or stamp < oldest):
                oldest = stamp
    window = f"Window: newest {count} events"
    window += f" (oldest in this document {oldest})." if oldest else "."
    window += " Older days stay in the history archive."
    out = []
    replaced = False
    for line in notes or []:
        if isinstance(line, str) and line.startswith("Window:"):
            out.append(window)
            replaced = True
        elif isinstance(line, str) and "full GitHub history" in line:
            out.append(line.replace(
                "full GitHub history (backfilled from repo creation, then incremental)",
                "GitHub history archived by day. This document is the newest window (backfilled from repo creation, then incremental)",
            ))
        else:
            out.append(line)
    if not replaced:
        out.append(window)
    return out


def cap_file(path):
    """Shrink an existing document before node parses it. Returns how many events were dropped."""
    path = Path(path)
    try:
        if not path.is_file() or path.stat().st_size == 0:
            return 0
        feed = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return 0
    if not isinstance(feed, dict) or not isinstance(feed.get("events"), list):
        return 0
    cap = feed_cap()
    events = feed["events"]
    if cap <= 0 or len(events) <= cap:
        return 0
    kept = window_events(events, cap)
    dropped = len(events) - len(kept)
    payload = dict(feed)
    payload["events"] = kept
    payload["event_count"] = len(kept)
    tmp = path.with_suffix(f".json.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, path)
    return dropped


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else ""
    if not target:
        print("feed cap skipped", file=sys.stderr)
        raise SystemExit(0)
    print("feed cap dropped", cap_file(target))
