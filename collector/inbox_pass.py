"""Seat inboxes for the fleet (port of example-org/xray PR #5, house/live/inbox.py + board.py).

Run by the pusher every cycle (no secrets on argv; the ingest secret comes on stdin when posting):
  pull  EVENTS_JSON          -> merge a /ingest/events response (GitHub + box events the server holds) into the cache
  pass                       -> route events not seen before into $MESH_RUN/fleet/inbox/<seat>.jsonl, rebuild
                                BOARD.md (debounced 60 s, failure never stops the pass); prints "<new> <lines>"
  unsent OUT                 -> unsent lines (all seats) -> OUT ({"lines": [...]}) for POST /inbox; prints count
  sent OUT                   -> after a 200, remember those ids
The local spool ($MESH_RUN/feed/inbox-spool/<seat>.jsonl) is a ring buffer (last 300 lines a seat); the Railway
server is the source of truth (GET /inbox/<seat>).
The first pass marks every id seen and delivers only events inside the seed grace (SEED_GRACE_S). Older history is
never delivered. A later pass delivers an id once, and skips an id first seen after ROUTE_MAX_AGE_S. Inbox lines carry
ids, kinds, repo#number, sha, title (event label, already in the public feed), url and a short reason; never bodies,
prompt text or secrets.
"""
import json, os, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import ci_inbox

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "routing"))
import inbox  # noqa: E402

RUN = Path(os.environ.get("MESH_RUN", "/srv/live/run"))
FEED = Path(os.environ.get("FEED", RUN / "feed" / "live-events.json"))
INBOX = Path(os.environ.get("LIVE_INBOX", RUN / "feed" / "inbox-spool"))   # ring buffer only: the server holds the inboxes
RING = 300
STATE = Path(os.environ.get("INBOX_STATE", RUN / "feed" / "inbox-state.json"))
CACHE = Path(os.environ.get("INBOX_CACHE", RUN / "feed" / "inbox-events.json"))
ACTIVITY = Path(os.environ.get("LIVE_ACTIVITY", RUN / "fleet" / "activity.jsonl"))
ROLES = HERE / "routing" / "inbox-roles.json"
KEEP_S = 3 * 86400
MAX_SEEN = 60000
SEED_GRACE_S = 600   # events stamped this long before the seed pass still count as live
ROUTE_MAX_AGE_S = int(os.environ.get("ROUTE_MAX_AGE_S", 6 * 3600))   # an id first seen this late is backfill: never delivered
KIND_MAP = {"pr_commit": "pr_update", "pr_force_push": "pr_update", "pr_ready": "pr_update"}


def _load(p, d):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return d


def _save(p, obj):
    p = Path(p); p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + f".{os.getpid()}.tmp"); tmp.write_text(json.dumps(obj, separators=(",", ":"))); os.replace(tmp, p)


def _t(e):
    try:
        return datetime.fromisoformat(str(e.get("t_ct")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def adapt(events):
    """Feed events -> the field names inbox.py routes on (hints only; the events themselves are unchanged)."""
    by_sha = {}
    for e in events:
        if e.get("number") is not None and e.get("sha"):
            by_sha[str(e["sha"])[:12]] = e["number"]
    out = []
    for e in events:
        e = dict(e)
        h = {}
        if e.get("kind") in KIND_MAP:
            e["kind"] = KIND_MAP[e["kind"]]
        sha = e.get("sha") or e.get("head_sha") or e.get("merge_sha")
        if sha:
            h["sha"] = str(sha)
        if e.get("number") is None and sha and str(sha)[:12] in by_sha:
            e["number"] = by_sha[str(sha)[:12]]
        if e.get("number") is not None:
            try:
                e["number"] = int(e["number"])
            except (TypeError, ValueError):
                e.pop("number")
        if e.get("kind") == "critic_pass" or e.get("recheck_result") == "PASS":
            e["kind"] = "critic_pass"
        for k in ("message", "text", "body"):
            e.pop(k, None)                               # never routed, never copied
        h["title"] = e.get("label") or ""
        e["_inbox"] = h
        out.append(e)
    return out


_direct_core = inbox._direct
_line_core = inbox._line
ROSTER = HERE / "fleet-roster.json"


def our_seats():
    """Our seats (feed/fleet-roster.json "seats"); every routed line must land on one of them."""
    return {str(s) for s in (_load(ROSTER, {}).get("seats") or []) if isinstance(s, str)}


def role_seat(seat, roles=None):
    """Kit role (reviewer / builder / tester / operator / coord) -> our seat via roles.seats[role].seat; None when "off"."""
    rule = ((roles if roles is not None else _load(ROLES, {})).get("seats") or {}).get(seat)
    if isinstance(rule, dict):
        if rule.get("off"):
            return None
        if isinstance(rule.get("seat"), str):
            return rule["seat"]
    return seat


def _line_ours(event, seat, reason, *a, **kw):
    """Every inbox line (direct routes, ready, stall, watcher gaps) goes through here: kit roles become our seats."""
    seat = role_seat(seat)
    return _line_core(event, seat, reason, *a, **kw) if seat else None


inbox._line = _line_ours
NODES = HERE / "fleet-nodes.json"
# #275 guardrails. Pulses (owner / seat-to-seat messages, turns, tasks, cloud agents) show on the board only: never
# an inbox line, never a wake. Actionable kinds with no owner seat, or owned only by a seat with no webhook
# (roles.fallback.from, e.g. arch1), also go to the coordinator (roles.fallback.seat).
PULSE_KINDS = ("prompt", "turn", "subagent", "watcher", "cloud_agent", "cloud_", "board_", "lab_")
ACTIONABLE = ("pr_open", "review", "pr_comment", "review_comment", "issue_comment", "comment", "issue_open",
              "review_requested", "nudge", "packet")


def _env_json(name):
    try:
        v = json.loads(os.environ.get(name) or "{}")
        return v if isinstance(v, dict) else {}
    except ValueError:
        return {}


_BOT_CACHE = {}


def bot_logins():
    """login -> seat: fleet-nodes.json (seat logins) plus SEAT_BOTS {seat: login | [logins]}.
    Cached per (fleet-nodes.json mtime, SEAT_BOTS value): one build per pass, not one per event."""
    try:
        mt = NODES.stat().st_mtime_ns
    except OSError:
        mt = None
    key = (str(NODES), mt, os.environ.get("SEAT_BOTS") or "")
    if key in _BOT_CACHE:
        return _BOT_CACHE[key]
    m = {k.removesuffix("[bot]").casefold(): v for k, v in _load(NODES, {}).items() if isinstance(v, str)}
    for seat, v in _env_json("SEAT_BOTS").items():
        for login in [v] if isinstance(v, str) else v if isinstance(v, list) else []:
            if isinstance(login, str) and login:
                m[login.removesuffix("[bot]").casefold()] = str(seat).lower()
    _BOT_CACHE.clear()
    _BOT_CACHE[key] = m
    return m


def watched_by_seat(seat, event):
    """SEAT_WATCHERS {seat: {repos: [...], kinds: [...]}}: the seat runs its own watcher there, so the server skips it.
    An empty entry ({} or both lists empty) skips nothing; name repos and/or kinds (or "*") to skip."""
    w = _env_json("SEAT_WATCHERS").get(seat)
    if not isinstance(w, dict) or not (w.get("repos") or w.get("kinds")):
        return False
    repos, kinds = w.get("repos") or ["*"], w.get("kinds") or ["*"]
    return ("*" in repos or str(event.get("repo") or "") in repos) and ("*" in kinds or inbox._kind(event) in kinds)


def packet_next_seat(event, roles):
    """Packet next owner, when it names one of our seats. The opener is not a tip."""
    pk = event.get("packet")
    if not isinstance(pk, dict):
        return None
    raw = str(pk.get("next owner") or "").strip()
    if not raw:
        return None
    known = set(our_seats()) | {str(s) for s in (roles.get("routing") or {})}
    names = [raw]
    first = raw.split()[0]
    if first and first != raw:
        names.append(first)
    for name in names:
        hit = alias_seat(name, roles)
        if not hit:
            want = name.casefold().removesuffix("[bot]")
            for key, seat in aliases_of(roles).items():
                if str(key).casefold() == want:
                    hit = seat
                    break
        if not hit:
            mapped = role_seat(name.casefold(), roles)
            if mapped and mapped != name.casefold() and mapped in known:
                hit = mapped
        if hit in known:
            return hit
    return None


def _direct_all(event, roles):
    """PR #5 routes plus the extra Chat Bot seats (roles.extra_seats: kinds / merge_bases / needles)."""
    kind = inbox._kind(event)
    if kind.startswith(PULSE_KINDS):   # covers Lead prompts too ("prompt" is a pulse kind)
        return []   # a pulse is never a packet or a wake
    out = _direct_core(event, roles)
    hay = str(event.get("label") or "")
    tagged = [m for m in event.get("mentions") or [] if isinstance(m, str)]
    if tagged:   # @handles the collector read from the body (handles only, the body is never carried)
        hay += " " + " ".join("@" + m for m in tagged)
    for seat, r in (roles.get("extra_seats") or {}).items():
        if not isinstance(r, dict) or not r:
            continue
        hit = kind in (r.get("kinds") or [])
        if hit and kind == "op_deploy":
            hit = str(event.get("status") or "").upper() in ("SUCCESS", "CRASHED", "FAILED", "FAILURE", "ERROR", "REMOVED")
        hit = hit or (kind == "merged" and str(event.get("base") or "").casefold() in [b.casefold() for b in r.get("merge_bases") or []])
        hit = hit or (kind.startswith("issue") or "comment" in kind) and any(inbox._has(hay, n) for n in r.get("needles") or [])
        mention_hay = " ".join("@" + m for m in tagged)
        hit = hit or bool(mention_hay) and any(inbox._has(mention_hay, n) for n in r.get("needles") or [])
        if hit:
            line = inbox._line(event, seat, r.get("reason") or "routed")
            if line:
                out.append(line)
    ph = roles.get("pr_heads") or {}
    if kind in (ph.get("kinds") or []) and event.get("number") is not None:
        sha = str(event.get("sha") or event.get("head_sha") or (event.get("_inbox") or {}).get("sha") or "")[:12]
        key = f"pr:{event.get('repo') or ''}#{event.get('number')}@{sha or event.get('id')}"   # one line per head, whatever the event count
        for seat, reason in (ph.get("seats") or {}).items():
            line = inbox._line(event, seat, reason, line_id=key)
            if line:
                out.append(line)
    cw = roles.get("comment_watch") or {}
    if kind in (cw.get("kinds") or []) and event.get("number") is not None:
        # every comment on a PR (open, closed or merged) reaches the PR author's seat and the watch seats, mention or not
        author = alias_seat(event.get("author_seat") or event.get("to"), roles) if kind in (cw.get("author_kinds") or []) else None
        merged = " (merged PR)" if event.get("pr_merged") else ""
        if author:
            why = "comment on your issue" if kind == "issue_comment" else (cw.get("author_reason") or "comment on your PR")
            line = inbox._line(event, author, why + merged)
            if line:
                out.append(line)
        for seat, reason in (cw.get("seats") or {}).items():
            line = inbox._line(event, seat, reason + merged)
            if line:
                out.append(line)
    if kind == "review" and event.get("number") is not None:
        author = login_seat(event.get("pr_author"), roles)
        if author:
            line = inbox._line(event, author, "review on your PR")
            if line:
                out.append(line)
    if kind in ("merged", "next_parent") and event.get("door_seat") and event.get("parent") and event.get("next_issue"):
        raw_id = str(event.get("id") or "")
        line_id = raw_id if raw_id.endswith(":door") else f"{raw_id}:door"
        line = inbox._line(event, str(event.get("door_seat")), "next on parent",
                           line_id=line_id, line_type="packet")
        if line:
            line["kind"] = "ready"
            line["title"] = f"next on #{event.get('parent')}: #{event.get('next_issue')}"[:120]
            line["number"] = int(event.get("next_issue"))
            out.append(line)
    if kind in ("merged", "pr_close") and event.get("number") is not None:
        author = author_seat(event, roles)
        if author:
            why = "your PR merged" if kind == "merged" else "your PR closed"
            line = inbox._line(event, author, why, line_id=f"{event.get('id')}:info", line_type="info")
            if line:
                out.append(line)
    nxt = packet_next_seat(event, roles)
    if nxt and nxt != actor_seat(event, roles):
        line = inbox._line(event, nxt, "packet next owner")
        if line:
            out.append(line)
    ours = our_seats()
    if ours:   # a line to a seat outside ours (unknown, sample, unkeyed) is read by nobody: drop it, fall back below
        out = [l for l in out if l.get("seat") in ours]
    fb = roles.get("fallback") or {}
    if fb.get("seat") and kind in ACTIONABLE and all(l.get("seat") in (fb.get("from") or []) for l in out):
        line = inbox._line(event, fb["seat"], "no owner seat with a wake" if out else "unowned: coordinator routes")
        if line:
            out.append(line)
    me = actor_seat(event, roles)
    seen, uniq = set(), []
    for l in out:   # one line per seat per event
        k = (l.get("seat"), l.get("id"))
        if k not in seen:
            seen.add(k); uniq.append(l)
    out = uniq
    kept = []
    for l in out:
        if watched_by_seat(l.get("seat"), event):
            continue
        if l.get("type") == "info":
            kept.append(l)   # merged / pr_close tell the author even when they did it
            continue
        if me and l.get("seat") == me:
            continue
        kept.append(l)
    return kept


def aliases_of(roles):
    """name -> seat from the routing map (each seat's aliases and its login, '[bot]' dropped); legacy roles.aliases still read."""
    out = dict(roles.get("aliases") or {})
    for seat, e in (roles.get("routing") or {}).items():
        if not isinstance(e, dict):
            continue
        out.setdefault(seat, seat)   # the seat id is its own name (not a mention alias)
        for n in e.get("aliases") or []:
            out.setdefault(str(n), seat)
        if e.get("login"):
            out.setdefault(str(e["login"]).removesuffix("[bot]"), seat)
    return out


def alias_seat(name, roles):
    aliases = aliases_of(roles)
    v = str(name or "")
    for n in (v, v.removesuffix("[bot]")):
        if n in aliases:
            return aliases[n]
    return None


def login_seat(login, roles):
    """Seat for an exact GitHub login: routing.*.login, fleet-nodes.json, then SEAT_BOTS. Aliases are not logins."""
    key = str(login or "").strip().casefold()
    if not key:
        return None
    for seat, entry in (roles.get("routing") or {}).items():
        if isinstance(entry, dict) and str(entry.get("login") or "").casefold() == key:
            return seat
    nodes = _load(NODES, {})
    if isinstance(nodes, dict):
        for name, seat in nodes.items():
            if isinstance(seat, str) and str(name).casefold() == key:
                return str(seat).lower()
    for seat, value in _env_json("SEAT_BOTS").items():
        listed = [value] if isinstance(value, str) else value if isinstance(value, list) else []
        for item in listed:
            if isinstance(item, str) and item.casefold() == key:
                return str(seat).lower()
    return None


def author_seat(event, roles):
    """Seat of the PR author (event author login), or None when the login is not one of ours."""
    raw = event.get("author")
    if not isinstance(raw, str) or not raw.strip():
        return None
    return login_seat(raw, roles)


def actor_seat(event, roles):
    """Seat id of who did this (the routing map's aliases + logins map names to seat ids), or None."""
    aliases = aliases_of(roles)
    for key in ("from", "actor"):
        v = str(event.get(key) or "")
        for name in (v, v.removesuffix("[bot]")):
            if name in aliases:
                return aliases[name]
    return bot_logins().get(str(event.get("actor") or event.get("author") or "").removesuffix("[bot]").casefold())


inbox._direct = _direct_all


def cache_events():
    c = _load(CACHE, {"events": {}})
    return c, c.setdefault("events", {})


def cmd_pull(path):
    d = _load(path, {})
    c, ev = cache_events()
    for e in d.get("events") or []:
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            ev[e["id"]] = e
    c["cursor"] = d.get("cursor") or c.get("cursor")
    _save(CACHE, c)
    if d.get("reset"):   # a full resync (first pull, server restart): history, never delivered
        st = _load(STATE, {})
        seen = st.get("seen") or {}
        for e in d.get("events") or []:
            if isinstance(e, dict) and isinstance(e.get("id"), str):
                seen.setdefault(e["id"], int(_t(e)))
        st["seen"] = seen
        _save(STATE, st)
    print(c.get("cursor") or "")


def cmd_pass(now=None):
    now = now or time.time()
    c, ev = cache_events()
    for e in _load(FEED, {}).get("events") or []:
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            ev[e["id"]] = e
    for k in [k for k, e in ev.items() if now - _t(e) > KEEP_S and e.get("kind") not in ("pr_open", "issue_open")]:   # card events stay (board)
        del ev[k]
    st = _load(STATE, {})
    seen = st.get("seen") or {}
    sig = st.get("sig") if isinstance(st.get("sig"), dict) else {}
    ids = sorted(ev, key=lambda k: _t(ev[k]))
    new, changed = [], []
    for k in ids:
        e = ev[k]
        kind = str(e.get("kind") or "")
        prev = sig.get(k)
        if k not in seen:
            new.append(e)
        elif prev and prev != kind:   # same id, new kind (pending status later failed): route the update
            changed.append(e)
        if kind:
            sig[k] = kind
    first = not st.get("seeded")
    seeded_at = now if first else float(st.get("seeded_at") or 0)
    floor = max(seeded_at - SEED_GRACE_S, now - ROUTE_MAX_AGE_S)
    for e in new:
        seen[e["id"]] = int(_t(e))
    if len(seen) > MAX_SEEN:
        seen = dict(sorted(seen.items(), key=lambda kv: kv[1])[-MAX_SEEN:])
    lines = 0
    bad = sum(1 for e in new if not _t(e))
    if bad:
        print(f"inbox_pass: {bad} event(s) with missing/bad t_ct marked seen, not delivered", file=sys.stderr)
    new = [e for e in new if _t(e) >= floor]   # history (pre-seed or late backfill) is marked seen, never delivered
    changed = [e for e in changed if _t(e)]   # a kind change is live even when the original t_ct is old
    # Edited comments (#300 follow-up): the collector re-reads a comment when updated_at moves and puts it again under the
    # same id, so `seen` alone would drop a mention added on edit. Remember each comment's @handles; a handle added later
    # becomes one comment_edit event (id <comment id>:edit:<handles>) that only mention needles route: one line per newly
    # mentioned seat, never again for the same handle. A comment first noticed by this code (no record) is only recorded.
    ments = st.get("ments") or {}
    edits = []
    for e in new:
        if "comment" in str(e.get("kind") or "") and isinstance(e.get("mentions"), list):
            ments[e["id"]] = sorted({str(m).casefold() for m in e["mentions"]})
    new_ids = {e["id"] for e in new}
    for k in ids:
        e = ev[k]
        if k in new_ids or "comment" not in str(e.get("kind") or "") or not isinstance(e.get("mentions"), list):
            continue
        cur = sorted({str(m).casefold() for m in e["mentions"]})
        if k not in ments:
            ments[k] = cur
            continue
        added = [m for m in cur if m not in ments[k]]
        ments[k] = sorted(set(ments[k]) | set(cur))
        if added and not first:
            edits.append({**e, "id": f"{k}:edit:{'+'.join(added)}", "kind": "comment_edit", "mentions": added,
                          "t_ct": datetime.fromtimestamp(now, timezone.utc).isoformat(), "edited_from": k})
    ments = {k: v for k, v in ments.items() if k in seen or k in ev}
    new = new + edits + changed
    # `new` is already inside the floor: seed grace on the first pass, route max age after that.
    # History was marked seen above and is not in this list. Deliver the grace window on the seed pass too,
    # or a fresh @arch10x comment is swallowed when the route volume is empty (#620).
    if new:
        acts = []
        if ACTIVITY.is_file():
            for raw in ACTIVITY.read_text().splitlines()[-2000:]:
                try:
                    acts.append(json.loads(raw))
                except ValueError:
                    pass
        roles = json.loads(ROLES.read_text())
        written = inbox.deliver(adapt(new), adapt([ev[k] for k in ids]), directory=INBOX, roles=roles,
                                now=datetime.fromtimestamp(now, timezone.utc), activity=acts)
        lines = sum(written.values())
        cached = adapt([ev[k] for k in ids])

        def seat_named(name):
            hit = alias_seat(name, roles)
            if hit:
                return hit
            want = name.casefold().removesuffix("[bot]")
            for key, seat in aliases_of(roles).items():
                if str(key).casefold() == want and seat:
                    return seat
            return ""

        def ci_seat(repo, number):
            rows = []
            for event in cached:
                try:
                    got = int(event.get("number"))
                except (TypeError, ValueError):
                    continue
                if str(event.get("repo") or "").lower() != repo or got != number:
                    continue
                if str(event.get("kind") or "") not in ("pr_open", "issue_open", "pr_update", "pr_commit"):
                    continue
                rows.append(event)
            if not rows:
                return ""
            for event in sorted(rows, key=lambda item: str(item.get("t_ct") or ""), reverse=True):
                packet = event.get("packet") if isinstance(event.get("packet"), dict) else {}
                raw = str(packet.get("next owner") or "").strip()
                for name in ([raw, raw.split()[0]] if raw else []):
                    hit = seat_named(name)
                    if hit:
                        return hit
            newest = max(rows, key=lambda item: str(item.get("t_ct") or ""))
            for key in ("from", "actor"):
                hit = seat_named(str(newest.get(key) or ""))
                if hit:
                    return hit
            return ""

        extra = ci_inbox.ci_fail_lines(cached, adapt(new), ci_seat)
        by_seat = {}
        for line in extra:
            by_seat.setdefault(line["seat"], []).append(line)
        for seat, group in by_seat.items():
            path = INBOX / f"{seat}.jsonl"
            known = inbox._known_ids(path)
            fresh = []
            for line in group:
                if line["id"] in known or set(line) - set(inbox._FIELDS):
                    continue
                known.add(line["id"])
                fresh.append(line)
            lines += inbox._append(path, fresh)
        inbox.maybe_board(len(new), log=lambda m: print(m, file=sys.stderr))
    sig = {k: v for k, v in sig.items() if k in seen or k in ev}
    _save(STATE, {"seeded": True, "seeded_at": seeded_at, "seen": seen, "sent": st.get("sent") or [], "ments": ments, "sig": sig})
    ring()
    _save(CACHE, c)
    print(f"{len(new)} {lines}")


def ring():
    """Keep the local spool small: the last RING lines per seat (unsent lines wait here while the server is down)."""
    for p in INBOX.glob("*.jsonl"):
        rows = p.read_text(encoding="utf-8").splitlines()
        if len(rows) > RING:
            tmp = p.with_suffix(".tmp"); tmp.write_text("\n".join(rows[-RING:]) + "\n", encoding="utf-8"); os.replace(tmp, p)


def cmd_unsent(out):
    st = _load(STATE, {})
    sent = set(st.get("sent") or [])
    lines = []
    for p in sorted(INBOX.glob("*.jsonl")):
        for raw in p.read_text().splitlines():
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if isinstance(d, dict) and d.get("seat") and d.get("id") not in sent:
                lines.append(d)
    Path(out).write_text(json.dumps({"lines": lines[:500]}))
    print(len(lines[:500]))


def cmd_sent(out):
    st = _load(STATE, {})
    sent = (st.get("sent") or []) + [d["id"] for d in _load(out, {}).get("lines") or []]
    st["sent"] = sent[-20000:]
    _save(STATE, st)


if __name__ == "__main__":
    cmd, *a = sys.argv[1:] or ["pass"]
    {"pull": cmd_pull, "pass": cmd_pass, "unsent": cmd_unsent, "sent": cmd_sent, "builder-unsent": cmd_unsent, "builder-sent": cmd_sent}[cmd](*a)
