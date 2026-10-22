"""Delta payloads for push_to_host.sh (no network, no secrets).

  prepare FEED STATE OUT  -> writes OUT (body to POST) + OUT.pending; prints "full" or "delta <upserts> <removes>"
  commit  STATE OUT RESP  -> on a 200: STATE = {cursor from RESP, hashes from OUT.pending}
  reset   STATE           -> forget the acknowledged state (next push is a full resync)
  act-query STATE         -> query string for GET /activity/pull
  act-store RESP STATE OUT -> re-validate pulled activity lines, append new ones to OUT (JSONL); prints the count

STATE holds only the server cursor and a short content hash per event id (no event data).
A delta = events new or changed since the last acknowledged push + ids that disappeared + every header field.
"""
import hashlib, json, os, re, sys
from pathlib import Path

CURSOR_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.\d{1,12}$")


def ehash(e):
    return hashlib.sha1(json.dumps(e, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:16]


def load_state(path):
    try:
        st = json.loads(Path(path).read_text())
        if CURSOR_RE.match(st.get("cursor", "")) and isinstance(st.get("hashes"), dict):
            return st
    except (OSError, ValueError, AttributeError):
        pass
    return None


def atomic(path, text):
    tmp = Path(f"{path}.{os.getpid()}.tmp"); tmp.write_text(text); os.replace(tmp, path)


def prepare(feed_path, state_path, out):
    feed = json.loads(Path(feed_path).read_text())
    hashes = {e["id"]: ehash(e) for e in feed["events"]}
    atomic(f"{out}.pending", json.dumps(hashes, separators=(",", ":")))
    st = load_state(state_path)
    if not st:
        Path(out).write_text(json.dumps(feed, ensure_ascii=False, separators=(",", ":")))
        return "full"
    old = st["hashes"]
    body = {"base": st["cursor"],
            "header": {k: v for k, v in feed.items() if k not in ("events", "cursor")},
            "upsert": [e for e in feed["events"] if old.get(e["id"]) != hashes[e["id"]]],
            "remove": [i for i in old if i not in hashes]}
    Path(out).write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
    return f"delta {len(body['upsert'])} {len(body['remove'])}"


def commit(state_path, out, resp):
    cur = json.loads(Path(resp).read_text()).get("cursor", "")
    if not CURSOR_RE.match(str(cur)):          # a server without cursors (pre-delta) -> stay on full pushes
        Path(state_path).unlink(missing_ok=True); return "no-cursor"
    hashes = json.loads(Path(f"{out}.pending").read_text())
    atomic(state_path, json.dumps({"cursor": cur, "hashes": hashes}, separators=(",", ":")))
    return "ok"


# ---- activity pulled from the server (POST /activity by off-box seats) -> box JSONL for live_fleet.scan_activity
ACT_KINDS = {"prompt": {"received", "sent"}, "turn": {"start", "end", "tick"}, "subagent": {"start", "end", "tick"},
             "watcher": {"start", "end", "tick"}, "cloud_agent": {"launch", "reply", "finished", "cancel"}}
ACT_SEATS = {"Builder"}
ACT_VALUE = re.compile(r"[A-Za-z0-9 ._:@#+/-]{1,80}")
ACT_BANNED = re.compile(r"body|text|message", re.I)
ACT_AGENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{2,40}")
ACT_T = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,6})?)?([+-]\d\d:\d\d|Z)")
# Same owner/repo rules as the board. A dotted repo stays. "." and ".." do not.
# Lookaheads count characters (owner 39, repo 100). The {0,38} group does not.
PR_URL = re.compile(
    r"https://github\.com/(?![A-Za-z0-9-]{40})[A-Za-z0-9](?:-[A-Za-z0-9]|[A-Za-z0-9]){0,38}"
    r"/(?![A-Za-z0-9._-]{101})[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?/pull/\d{1,8}"
)
ACT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
ACT_NOTE = re.compile(r"""[A-Za-z0-9 ._:@#+/?'",;!()-]{1,240}""")


def act_line(d):
    """Re-validate a pulled line (defense in depth); returns the normalized line or None."""
    seat = d.get("seat") if isinstance(d, dict) else None
    kind = d.get("kind") if isinstance(d, dict) else None
    seat_ok = kind == "cloud_agent" and isinstance(seat, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{1,40}", seat)
    if not isinstance(d, dict) or kind not in ACT_KINDS or not (seat_ok or seat in ACT_SEATS):
        return None
    if d.get("action") not in ACT_KINDS[d["kind"]] or not ACT_T.fullmatch(str(d.get("t_ct", ""))):
        return None
    out = {"t_ct": d["t_ct"], "seat": d["seat"], "kind": d["kind"], "action": d["action"]}
    for k in ("to", "from", "agent", "tag"):   # from: prompt sender (#281)
        v = d.get(k)
        if v is None:
            continue
        if not isinstance(v, str) or not ACT_VALUE.fullmatch(v) or ACT_BANNED.search(v) or len(v) > 40:
            return None
        if k == "agent" and not ACT_AGENT.fullmatch(v):
            return None
        out[k] = v
    if "from" in out and d["kind"] != "prompt":
        return None
    if d["kind"] == "cloud_agent" and "agent" not in out:
        return None
    if "pr" in d:
        pr = d.get("pr")
        if d["kind"] != "cloud_agent" or not isinstance(pr, str) or len(pr) > 300 or not PR_URL.fullmatch(pr.strip()):
            return None
        out["pr"] = pr.strip()
    if d.get("kind") == "prompt":
        pid = d.get("id")
        if isinstance(pid, str) and ACT_ID.fullmatch(pid):
            out["id"] = pid
        note = d.get("note")
        if isinstance(note, str) and ACT_NOTE.fullmatch(note):
            out["note"] = note
    return out


def act_query(state_path):
    try:
        st = json.loads(Path(state_path).read_text())
        return f"epoch={st['epoch']}&after={int(st['after'])}" if re.fullmatch(r"[A-Za-z0-9_-]{1,32}", st["epoch"]) else "after=0"
    except (OSError, ValueError, KeyError, TypeError):
        return "after=0"


def act_store(resp, state_path, out_path):
    r = json.loads(Path(resp).read_text())
    epoch, last = str(r.get("epoch", "")), int(r.get("last", 0))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", epoch):
        return 0
    try:
        st = json.loads(Path(state_path).read_text())
    except (OSError, ValueError):
        st = {}
    seen = st.get("seen", [])
    seen_set, lines = set(seen), []
    for d in r.get("lines", [])[:1000]:
        lid = str(d.get("id", "")) if isinstance(d, dict) else ""
        line = act_line(d)
        if line is None or not lid or lid in seen_set:
            continue
        seen.append(lid); seen_set.add(lid); lines.append(json.dumps(line, separators=(",", ":")))
    Path(state_path).parent.mkdir(parents=True, exist_ok=True)
    atomic(state_path, json.dumps({"epoch": epoch, "after": last, "seen": seen[-2000:]}))   # first: never re-append
    if lines:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "a") as fh:        # one write of whole lines (the fleet scanner reads whole lines only)
            fh.write("\n".join(lines) + "\n")
    return len(lines)


if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    if cmd == "prepare": print(prepare(*a))
    elif cmd == "commit": print(commit(*a))
    elif cmd == "reset": Path(a[0]).unlink(missing_ok=True); print("reset")
    elif cmd == "act-query": print(act_query(*a))
    elif cmd == "act-store": print(act_store(*a))
    else: sys.exit(f"unknown command {cmd}")
