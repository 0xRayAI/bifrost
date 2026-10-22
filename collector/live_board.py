"""Board model: cards, packets and beats from the feed's own events (no extra GitHub calls, no poller).

Sources: the box feed's events plus the seat-inbox pass's event cache ($MESH_RUN/feed/inbox-events.json, i.e. the
server's merged feed events pulled by the pusher). Card and packet fields come from the pr_open / issue_open events
the collector pass already writes (live_collect.card_fields: title, state, labels, sanitized packet).

CARD   = one GitHub issue or PR (repo#number): title, url, owner seat, stage (open > review > fix > merge > retest >
         done), state (live | held | parked | closed). A merge, an issue close, or a PR close sets state closed
         and stage done. A failed retest after merge needs a new issue. The board shows a closed card for 24 hours.
         Inside that window it takes a slot before any parked card. The cap can still cut it from the page.
         The cut card is returned on settled so /history keeps the final state. The 24h drop does not delete it.
HOLD   = the owner posts a comment whose first line is 'Held: <reason>' (optional until:), or the issue / PR
         carries a label in GITHUB_HOLD_LABEL (default on-hold). A Parked: comment still parks and wins over a hold.
         Repos in NO_NUDGE_REPOS (unset means none) stay visible and are never stalled or nudged.
PACKET = goal, constraints, path, acceptance, evidence, next owner, escalate. The amber
         'needs a brief' badge is only a packet PR (title starts with Packet, or a packet: alias)
         whose PACKET.md is missing. Issues, packet cards, release PRs, and ordinary PRs stay
         packet_ok. A body that carries a packet, or PACKET.md on the branch, sets packet_file.
         Evidence fills from the latest beat.
BEAT   = one real event: PR opened/pushed, Reviewer verdict, CI result, merge, reopen, merge-queue.md tick, Lead message, blocker.
         A watcher run whose start and end fall in the same second is never a beat.
STALL  = a live card with no beat for 60 min (red on the page; one line to fleet/inbox/coord.jsonl per stalled beat).
Also writes house/BOARD.md from the same model at most once a minute; board-static.md items are pinned cards."""
import json, os, re, time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import live_packet

CT = ZoneInfo("America/Chicago")
RUN = Path(os.environ.get("MESH_RUN", "/srv/live/run"))
CACHE = Path(os.environ.get("INBOX_CACHE", RUN / "feed" / "inbox-events.json"))
INBOX = Path(os.environ.get("LIVE_INBOX", RUN / "fleet" / "inbox"))
HOUSE = Path(os.environ.get("LIVE_HOUSE", "/srv/fleet-house/house"))
MD = Path(os.environ.get("LIVE_BOARD", HOUSE / "BOARD.md"))
STATIC = Path(os.environ.get("LIVE_BOARD_STATIC", HOUSE / "watchers" / "board-static.md"))
STAGES = ("open", "review", "fix", "merge", "retest", "done")
STALL_S = 60 * 60
CLOSED_KEEP_S = 86400   # display only. A closed card older than this leaves /cards and stays on settled.
PR_PARK_S = 72 * 3600   # a live PR with no beat for 72 h parks
MD_EVERY_S = 60
MAX_CARDS = 40
# parked: a parked/blocked/waiting label, a draft PR quiet for 7 days, or an issue quiet for 24 h (backlog, no stall).
# The hold label (default on-hold) is a hold, not a park.
PARKED = re.compile(r"\b(parked|blocked|waiting|icebox)\b", re.I)
RELEASE_TITLE = re.compile(r"^release\b", re.I)
_last_md = [0.0]


def brief_exempt(card, packet=None):
    """The badge is only a packet PR whose PACKET.md is missing.

    A packet PR has a title that starts with Packet, or a packet: alias. packet_file
    (the body carries a packet or names PACKET.md, or the branch file exists) clears it.
    Issues, packet cards, release titles, and ordinary PRs such as docs #388 and hotfix
    #500 do not show the badge. Acceptance and next owner are not the badge.
    """
    if not isinstance(card, dict) or card.get("pinned"):
        return True
    kind = str(card.get("kind") or "")
    title = str(card.get("title") or "").strip()
    alias = str(card.get("alias") or "").lower()
    packet_pr = kind == "pr" and (bool(re.match(r"(?i)^packet\b", title)) or alias.startswith("packet:"))
    if not packet_pr:
        return True
    return bool(card.get("packet_file"))


def _t(e):
    try:
        return datetime.fromisoformat(str(e.get("t_ct")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _ct(ts):
    return datetime.fromtimestamp(ts, CT).strftime("%-I:%M %p CT") if ts else ""


PROMPT_STAMP = re.compile(r"(?m)^Prompt:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,79})\s*$")


def prompt_stamp(body):
    found = PROMPT_STAMP.search(str(body or ""))
    return found.group(1) if found else ""


def stored_prompt(evs, pid):
    for e in evs:
        if str(e.get("kind") or "") not in ("prompt", "seat_prompt"):
            continue
        eid = str(e.get("id") or "")
        if eid == pid or eid == f"act:{pid}":
            return e
    return None


def prepend_owner_prompt(card, event, prompts, used):
    """One earlier beat when the open event carries Prompt: <id>. A repeated id does not mark a second card.

    Time and note come only from the prompts list. A prompt row that exists only among the card events is ignored.
    """
    pid = str(event.get("prompt") or "") or prompt_stamp(event.get("body"))
    if not pid or pid in used:
        return
    used.add(pid)
    src = stored_prompt(prompts or [], pid)
    beat = {"t": int((_t(src) if src else _t(event)) * 1000), "what": "owner prompt", "url": "", "id": pid, "_ev": ""}
    note = str((src or {}).get("note") or "")
    if note:
        beat["note"] = note
    card["_beats"].append(beat)


def beat_of(e):
    """-> short beat word, or None. Only real events that move a card."""
    k = str(e.get("kind") or "")
    if re.search(r"watcher|turn|subagent", k):
        if e.get("idle") or e.get("dur_s") == 0 or (e.get("start_ct") and e.get("start_ct") == e.get("end_ct")):
            return None                                   # idle watcher run: never a beat
        return None                                       # watcher runs are not card work
    if k in ("pr_open", "issue_open", "pr_ready"):
        return "opened"
    if k in ("pr_reopen", "issue_reopen"):
        return "reopened"
    if k == "review":
        st = str(e.get("state") or "").upper()
        if st == "APPROVED":
            return "Reviewer PASS"
        if st == "CHANGES_REQUESTED":
            return "Reviewer FAIL"
    if k in ("pr_commit", "pr_force_push", "pr_update"):
        return "pushed"
    if k.startswith("critic_"):
        v = e.get("recheck_result") or k.split("_", 1)[1].upper()
        return f"Reviewer {str(v).upper()}"
    if k in ("check_run", "workflow_run", "ci_pass", "ci_fail") and (e.get("conclusion") or k.startswith("ci_")):
        return "CI " + (e.get("conclusion") or k[3:])
    if k == "merged":
        return "merged"
    if k == "deploy":
        return "ship"
    if k == "deploy_fail":
        return "ship fail"
    if k == "op_deploy":
        st = str(e.get("status") or "").upper()
        if st == "SUCCESS":
            return "ship"
        if st in ("CRASHED", "FAILED", "FAILURE", "ERROR", "REMOVED"):
            return "ship fail"
        return None
    if k.startswith("lab_retest_"):
        return "retest " + k.rsplit("_", 1)[1].upper()
    if k.startswith("prompt") and str(e.get("from")) == "Lead":
        return "Lead message"
    if (k in ("issue_labeled", "pr_labeled") and re.search(r"block", str(e.get("detail") or ""), re.I)) or "blocker" in k:
        return "blocker"
    return None


def _evidence(e, what):
    if what == "merged":
        sha = e.get("merge_sha") or e.get("sha")
        return f"merge {str(sha)[:7]}" if sha else "merged"
    if what.startswith("retest"):
        return "merge-queue.md tick: " + what
    if what.startswith(("CI", "Reviewer")) and str(e.get("source", "")).startswith("https://"):
        return live_packet.clean(e["source"])
    return ""


def _events(extra):
    ev = {}
    try:
        for k, e in (json.loads(CACHE.read_text()).get("events") or {}).items():
            if isinstance(e, dict):
                ev[k] = e
    except (OSError, ValueError):
        pass
    for e in extra or []:
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            ev[e["id"]] = e
    import live_collect   # same fleet-only rule as the feed: the cache never expires, so old unmapped entries stay out
    return sorted(live_collect.fleet_only(list(ev.values())), key=_t)


_CLAIM = {"mill", "blinky", "critic", "arch1"}
_REPLACE_OWNER = {"forge", "github", "-", ""}
_MENTION = re.compile(r"#(\d{1,6})\b")


def _claim_seat(e):
    """A non-forge seat named by the trailer, the credit, or the sender. Forge does not take a card back."""
    for key in ("seat_trailer", "credit", "from"):
        v = str(e.get(key) or "").strip().lower()
        if v in _CLAIM:
            return v
    return None


def _apply_owner(cards, key, seat):
    c = cards.get(key) if key else None
    if not c or not seat:
        return
    cur = str(c.get("owner") or "").strip().lower()
    if cur in _REPLACE_OWNER:
        c["owner"] = seat


def _claim_owners(cards, evs, sha_num):
    for e in evs:
        seat = _claim_seat(e)
        if not seat:
            continue
        _apply_owner(cards, _key(e, sha_num), seat)
        repo = str(e.get("repo") or "").lower()
        try:
            own = int(e["number"]) if e.get("number") is not None else None
        except (TypeError, ValueError):
            own = None
        blob = " ".join(str(e.get(x) or "") for x in ("message", "label"))
        for raw in _MENTION.findall(blob):
            n = int(raw)
            if own is not None and n == own:
                continue
            _apply_owner(cards, f"{repo}#{n}", seat)


_FLEET_FROM = None


START_AFTER_CAP_S = 30 * 86400   # a Start after: date further out than this is ignored


def keep_start_after(raw, who, owner, now):
    """A start_after sticks only from the card owner or a fleet seat, and only inside the cap."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    sender = str(who or "")
    if sender != str(owner or "") and not fleet_from(sender):
        return None
    text = raw.strip()[:40]
    try:
        when = datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None
    if when > now + START_AFTER_CAP_S:
        return None
    return text


def fleet_from(name):
    """True when `from` is a fleet seat or a node mapped to one. Others, GitHub, and CI are not."""
    global _FLEET_FROM
    if _FLEET_FROM is None:
        names = set()
        try:
            roster = json.loads((Path(__file__).resolve().parent / "fleet-roster.json").read_text())
            names.update(str(s).lower() for s in roster.get("seats") or [])
        except (OSError, ValueError):
            pass
        try:
            import live_collect
            names.update(str(v).lower() for v in live_collect.NODE.values())
        except (OSError, ValueError, ImportError):
            pass
        names -= {"ci", "github", "others", ""}
        _FLEET_FROM = names
    return str(name or "").strip().lower() in _FLEET_FROM


def _key(e, sha_num):
    repo = e.get("repo")
    if not repo:
        return None
    n = e.get("number")
    if n is None:
        sha = e.get("sha") or e.get("head_sha")
        n = sha_num.get(f"{repo}@{str(sha)[:7]}") if sha else None
    try:
        return f"{str(repo).lower()}#{int(n)}" if n is not None else None
    except (TypeError, ValueError):
        return None


def pinned():
    """board-static.md bullets ('- **Title.** ...') -> pinned cards (title only)."""
    out, sec = [], ""
    try:
        text = STATIC.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        if line.startswith("## "):
            sec = line[3:].strip()
        m = re.match(r"^\s*-\s+\*\*(.+?)\*\*", line)
        if m and sec:
            title = live_packet.clean(m.group(1).rstrip(".:"))[:120]
            out.append({"key": f"pin:{len(out) + 1}", "kind": "pin", "repo": "", "number": 0, "title": title, "url": "",
                        "owner": "Lead" if "lead" in sec.lower() else "Coord", "stage": "open", "state": "parked",
                        "section": live_packet.clean(sec)[:40], "pinned": True, "packet": {}, "packet_ok": True,
                        "missing": [], "beats": [], "last_beat_t": 0, "stall": False})
    return out[:12]


def _keep_push(beats, limit):
    """Keep the newest pushed beat when the window would drop it. Order stays by time."""
    window = beats[-limit:]
    if len(beats) <= limit:
        return window
    latest = next((b for b in reversed(beats) if b.get("what") == "pushed"), None)
    if not latest or any(b.get("id") == latest.get("id") for b in window):
        return window
    window = [latest, *window[1:]]
    window.sort(key=lambda b: b.get("t") or 0)
    return window


def _ref_name(value):
    text = str(value or "").strip()
    if text.startswith("refs/heads/"):
        text = text[len("refs/heads/"):]
    return text[:200]


def _branch_names(event):
    """Branch refs on a collector event. A commit carries branches (a list); a push carries branch."""
    if not isinstance(event, dict):
        return []
    names = []

    def add(value):
        name = _ref_name(value)
        if name and name not in names:
            names.append(name)

    add(event.get("branch"))
    add(event.get("head_ref"))
    add(event.get("ref"))
    branches = event.get("branches")
    if isinstance(branches, list):
        for name in branches:
            add(name)
    return names


def _sha_of(event):
    if not isinstance(event, dict):
        return ""
    raw = event.get("sha") or event.get("head_sha") or ""
    return re.sub(r"[^0-9a-f]", "", str(raw).lower())


def _branch_of(event):
    names = _branch_names(event)
    return names[0] if names else ""


def _head_of(event):
    return _branch_of(event) or _ref_name(event.get("head") if isinstance(event, dict) else "")


def _sha_branch_index(events):
    found = {}
    for event in events:
        sha = _sha_of(event)
        names = _branch_names(event)
        if not sha or not names:
            continue
        bucket = found.setdefault(sha, [])
        for name in names:
            if name not in bucket:
                bucket.append(name)
    return found


def _base_by_sha(events):
    """pr_open.base is the target ref, not the head branch."""
    found = {}
    for event in events:
        if not isinstance(event, dict) or event.get("kind") != "pr_open":
            continue
        sha = _sha_of(event)
        base = _ref_name(event.get("base"))
        if not sha or not base:
            continue
        found.setdefault(sha, set()).add(base)
    return found


def _chosen_branch(event, bases):
    names = _branch_names(event)
    if not names:
        return ""
    skip = bases.get(_sha_of(event), ())
    for name in names:
        if name not in skip:
            return name
    return names[0]


def _pr_links(events):
    """pr_commit maps a sha to (repo, number). A commit has no number of its own."""
    found = {}
    for event in events:
        if not isinstance(event, dict) or event.get("kind") != "pr_commit":
            continue
        sha = _sha_of(event)
        repo = str(event.get("repo") or "").lower()
        if not sha or not repo or not _positive_event(event):
            continue
        pair = (repo, int(event["number"]))
        bucket = found.setdefault(sha, [])
        if pair not in bucket:
            bucket.append(pair)
    return found


def _sha_linked(event, card, links):
    sha = _sha_of(event)
    repo = str(card.get("repo") or "").lower()
    numbers = [number for (linked_repo, number) in links.get(sha, ()) if linked_repo == repo]
    if not numbers:
        return False
    try:
        card_number = int(card.get("number"))
    except (TypeError, ValueError):
        card_number = None
    if card_number is not None and card_number >= 1 and card_number not in numbers:
        return False
    return True


def _feature_branch(card):
    """A develop or main stamp is the merge base, not the PR head."""
    branch = _ref_name(card.get("branch") if isinstance(card, dict) else "")
    if not branch or branch in ("develop", "main"):
        return ""
    return branch


def _branch_for(card, events, cards, bases, links):
    """Prefer a non-base ref whose sha a pr_commit names. A base commit is not the head."""
    touching = []
    for event in events:
        if event.get("kind") in ("pr_open", "issue_open"):
            continue
        branch = _chosen_branch(event, bases)
        if not branch or not _event_touches(card, event, cards):
            continue
        touching.append((event, branch))
    linked = [(event, branch) for event, branch in touching if _sha_linked(event, card, links)]
    pool = linked or touching
    for _event, branch in pool:
        if branch not in ("develop", "main"):
            return branch
    return ""


def _agreed_open(event, links):
    """pr_open and pr_commit name the same repo, number, and sha."""
    if not isinstance(event, dict) or event.get("kind") != "pr_open" or not _positive_event(event):
        return False
    sha = _sha_of(event)
    if not sha:
        return False
    repo = str(event.get("repo") or "").lower()
    number = int(event["number"])
    return any(linked_repo == repo and linked_number == number for linked_repo, linked_number in links.get(sha, ()))


def _branch_hit(event, sha_branches, links, feature):
    sha = _sha_of(event)
    named = _head_of(event) == feature
    by_sha = bool(sha) and feature in sha_branches.get(sha, ())
    if not named and not by_sha:
        return False
    pairs = links.get(sha, ())
    if not pairs:
        return True
    repo = str(event.get("repo") or "").lower()
    number = int(event["number"])
    return any(linked_repo == repo and linked_number == number for linked_repo, linked_number in pairs)


def _join_event(card, events, sha_branches, links, cards):
    """One pr_open for this holding card.

    A feature branch already on the card picks the open whose head matches.
    With no feature branch, pr_open and pr_commit must share one number and sha.
    """
    feature = _feature_branch(card)
    hits = []
    agreed = []
    for event in events:
        if not isinstance(event, dict) or event.get("kind") != "pr_open" or not _positive_event(event):
            continue
        if not _event_touches(card, event, cards):
            continue
        if feature and _branch_hit(event, sha_branches, links, feature):
            hits.append(event)
        if _agreed_open(event, links):
            agreed.append(event)
    if hits:
        return hits[0]
    numbers = {(str(event.get("repo") or "").lower(), int(event["number"])) for event in agreed}
    if not feature and len(numbers) == 1:
        return agreed[0]
    return None


def _branch_from_open(event):
    ref = _ref_name(event.get("head_ref") if isinstance(event, dict) else "")
    if ref:
        return ref
    head = _head_of(event)
    base = _ref_name(event.get("base") if isinstance(event, dict) else "")
    if head and head != base:
        return head
    return ""


def _positive_event(event):
    if not isinstance(event, dict) or not event.get("repo"):
        return False
    try:
        return int(event.get("number")) >= 1
    except (TypeError, ValueError):
        return False


def _event_touches(card, event, cards):
    if not isinstance(event, dict):
        return False
    key = str(card.get("key") or "").lower()
    named = str(event.get("card") or "").strip().lower()
    if named and named == key:
        return True
    repo = str(event.get("repo") or "").lower()
    card_repo = str(card.get("repo") or "").lower()
    try:
        number = int(event.get("number"))
    except (TypeError, ValueError):
        number = None
    try:
        card_number = int(card.get("number"))
    except (TypeError, ValueError):
        card_number = None
    if repo and repo == card_repo and number is not None and number >= 1 and card_number == number:
        return True
    if not named and key.startswith("packet:") and repo and repo == card_repo:
        only = [c for c in cards if str(c.get("key") or "").lower().startswith("packet:") and str(c.get("repo") or "").lower() == repo]
        return len(only) == 1 and only[0] is card
    return False


def attach_held(held, events):
    """Rewrite a holding card onto the PR that pr_open and pr_commit share.

    commit_event names only develop and main. pr_commit carries sha plus
    number. pr_open carries base plus that sha, and the head ref poll_pulls
    stored. That number and sha become one card. A feature branch already on
    the card still selects its own head.
    """
    cards = [dict(card) for card in (held or []) if isinstance(card, dict)]
    evs = [event for event in (events or []) if isinstance(event, dict)]
    bases = _base_by_sha(evs)
    sha_branches = _sha_branch_index(evs)
    links = _pr_links(evs)
    for card in cards:
        if card.get("branch"):
            continue
        branch = _branch_for(card, evs, cards, bases, links)
        if branch:
            card["branch"] = branch
    gone = set()
    for card in cards:
        key = str(card.get("key") or "")
        if not key.lower().startswith("packet:") or id(card) in gone:
            continue
        hit = _join_event(card, evs, sha_branches, links, cards)
        if not hit:
            continue
        next_key = f"{str(hit['repo']).lower()}#{int(hit['number'])}"
        branch = _feature_branch(card) or _branch_from_open(hit) or _ref_name(card.get("branch"))
        existing = next((other for other in cards if other is not card and id(other) not in gone and str(other.get("key") or "").lower() == next_key), None)
        if existing is not None:
            existing.setdefault("alias", key)
            if branch and not _feature_branch(existing):
                existing["branch"] = branch
            gone.add(id(card))
            continue
        card["alias"] = key
        card["key"] = next_key
        card["repo"] = hit["repo"]
        card["number"] = int(hit["number"])
        if branch:
            card["branch"] = branch
        url = hit.get("url") or hit.get("source") or ""
        if url:
            card["url"] = str(url)[:300]
    return [card for card in cards if id(card) not in gone]


def _merge_attached(cards, attached, now):
    by = {}
    order = []
    for card in cards:
        by[str(card.get("key") or "").lower()] = card
        order.append(card)
    for card in attached:
        key = str(card.get("key") or "").lower()
        if key in by:
            dest = by[key]
            if card.get("branch") and not dest.get("branch"):
                dest["branch"] = card["branch"]
            if card.get("alias") and not dest.get("alias"):
                dest["alias"] = card["alias"]
            continue
        if not card.get("last_beat_t"):
            card["last_beat_t"] = int(now * 1000)
        if not card.get("state"):
            card["state"] = "live"
        order.append(card)
        by[key] = card
    return order


def _actor(event, card):
    event = event if isinstance(event, dict) else {}
    credit = event.get("credit")
    seat = credit if isinstance(credit, str) and credit else event.get("from") or (card.get("owner") if isinstance(card, dict) else "") or ""
    login = ""
    for cand in (event.get("actor"), event.get("author"), event.get("merged_by")):
        if isinstance(cand, str) and cand.strip():
            login = cand.strip()
            break
        if isinstance(cand, dict) and isinstance(cand.get("login"), str) and cand.get("login").strip():
            login = cand["login"].strip()
            break
    bc = ""
    bags = [event.get("bc"), event.get("bcId"), event.get("bc_id")]
    actor = event.get("actor")
    if isinstance(actor, dict):
        bags.append(actor.get("bc"))
    for cand in bags:
        if isinstance(cand, str) and cand.lower().startswith("bc-"):
            bc = cand
            break
    return {"seat": str(seat)[:80], "login": str(login)[:80], "bc": str(bc)[:80]}


def _card_transitions(card, beats, by_id, merged, explicit_close, close_id):
    """One row per verb, before the 14-day filter and the 40-card cap. A merge keeps its own source id."""
    rows = []
    stage = "open" if card.get("kind") == "issue" else "review"
    state = "live"
    was_held = False

    def emit(verb, to_state, to_stage, beat, source=None):
        nonlocal stage, state, was_held
        sid = source or str((beat or {}).get("id") or "")
        if not sid:
            return
        ev = by_id.get(sid) or {}
        t = 0
        if beat and beat.get("t"):
            t = beat["t"] / 1000
        elif ev:
            t = _t(ev)
        if not t:
            return
        title = str(card.get("title") or ev.get("title") or "")[:200]
        rows.append({
            "card": str(card.get("key") or "").lower(),
            "transition": verb,
            "from_state": state,
            "to_state": to_state,
            "from_stage": stage,
            "to_stage": to_stage,
            "actor": _actor(ev, card),
            "t_ct": datetime.fromtimestamp(t, CT).isoformat(timespec="seconds"),
            "source_id": sid[:200],
            "packet": title,
        })
        state, stage = to_state, to_stage

    for b in beats:
        what = b.get("what") or ""
        if what == "opened":
            emit("opened", "live", "review" if card.get("kind") == "pr" else stage, b)
            was_held = False
        elif what == "reopened":
            emit("reopened", "live", "review" if card.get("kind") == "pr" else "open", b)
            was_held = False
        elif what == "parked":
            emit("parked", "parked", stage, b)
        elif what == "held":
            emit("held", "held", stage, b)
            was_held = True
        elif what == "merged":
            if was_held:
                emit("released", "live", stage, b)
                was_held = False
            emit("merged", "closed", "done", b)
        elif what in ("Reviewer FAIL", "Reviewer HOLD") or what in ("CI failure", "CI timed_out"):
            if stage != "fix":
                emit("stage", "closed" if state == "closed" else "live", "fix", b)
        elif what.startswith("Reviewer PASS") and state != "closed" and stage != "merge":
            emit("stage", state, "merge", b)
        elif was_held:
            emit("released", "live" if state != "closed" else state, stage, b)
            was_held = False
    if explicit_close and not merged and not any(r["transition"] == "closed" for r in rows):
        emit("closed", "closed", "done", None, source=close_id or f"close:{card.get('key')}")
    return rows


def model(extra_events=None, now=None, prompts=None, held=None):
    now = now or time.time()
    evs = _events(extra_events)
    sha_num = {}
    for e in evs:
        if e.get("number") is not None and (e.get("sha") or e.get("head_sha")):
            sha_num[f"{e['repo']}@{str(e.get('sha') or e.get('head_sha'))[:7]}"] = e["number"]
    cards = {}
    for e in evs:                                          # cards from the open events (latest copy wins)
        if e.get("kind") not in ("pr_open", "issue_open"):
            continue
        k = _key(e, sha_num)
        if not k:
            continue
        pk = e.get("packet") if isinstance(e.get("packet"), dict) else {}
        pk = {f: live_packet.clean(v) for f, v in pk.items() if f in live_packet.FIELDS and v}
        title = e.get("title") or re.sub(r"^.*?opened · ", "", str(e.get("label") or ""))
        cards[k] = {"key": k, "kind": "pr" if e["kind"] == "pr_open" else "issue", "repo": e["repo"],
                    "number": int(e["number"]), "title": live_packet.clean(title)[:120],
                    "url": live_packet.clean(e.get("source") or ""), "owner": str(e.get("from") or "-")[:24],
                    "labels": [live_packet.clean(x)[:30] for x in (e.get("labels") or [])][:6],
                    "packet": pk, "packet_file": bool(e.get("packet_file")),
                    "_closed": e.get("pr_state") == "closed", "_closed_t": _t({"t_ct": e.get("closed_at")}) if e.get("closed_at") else 0,
                    "_draft": bool(e.get("draft")), "_beats": [], "_stop": False, "_known": "pr_state" in e}
    _claim_owners(cards, evs, sha_num)             # mill (trailer, credit, or git name) takes a card forge opened
    used_prompts = set()
    prompt_rows = list(prompts or [])
    merged_keys = {_key(e, sha_num) for e in evs if e.get("kind") == "merged"}
    fixed_by = {}                                          # card key -> "#P" when a merged PR says it fixes / supersedes it
    for e in evs:
        if e.get("kind") == "pr_open" and e.get("fixes") and _key(e, sha_num) in merged_keys:
            for n in e["fixes"]:
                fixed_by.setdefault(f"{str(e['repo']).lower()}#{int(n)}", f"#{int(e['number'])}")
    for e in evs:                                          # beats, in time order; a closed card stops collecting
        k = _key(e, sha_num)
        c = cards.get(k) if k else None
        kind = str(e.get("kind") or "")
        reopen = kind.endswith("_reopen")
        if not c or (c["_stop"] and not reopen and kind not in ("pr_comment", "issue_comment", "pr_review", "review_comment")):
            continue                                       # a stopped (closed) card still takes comments and a reopen
        kept = keep_start_after(e.get("start_after"), e.get("from"), c.get("owner"), now)
        if kept:
            c["start_after"] = kept
        if reopen:
            c["_closed"], c["_closed_t"], c["_stop"] = False, 0, False
        if kind == "pr_draft":
            c["_draft_park"] = True
        elif kind == "pr_ready":
            c["_draft_park"] = False
        if kind in ("issue_close", "pr_close"):
            c["_closed"], c["_closed_t"] = True, _t(e)
            if e.get("id") is not None:
                c["_close_id"] = str(e["id"])
        w = beat_of(e)
        is_comment = e.get("kind") in ("pr_comment", "issue_comment", "pr_review", "review_comment")
        if is_comment and e.get("parked"):                 # Coord rule: a 'Parked:' comment parks the card (no nudges)
            c["_parked_c"] = True
            c["_hold"] = None
            c["_beats"].append({"t": int(_t(e) * 1000), "what": "parked", "url": "", "id": e["id"], "_ev": ""})
            continue
        hold = e.get("hold") if isinstance(e.get("hold"), dict) else None
        if is_comment and hold and str(e.get("from") or "") == str(c.get("owner") or ""):
            c["_parked_c"] = False
            c["_hold"] = {"reason": live_packet.clean(hold.get("reason"))[:live_packet.HOLD_MAX],
                          "until": live_packet.clean(hold.get("until"))[:live_packet.HOLD_MAX],
                          "by": str(e.get("from") or "")[:24], "t": _t(e)}
            c["_beats"].append({"t": int(_t(e) * 1000), "what": "held", "url": "", "id": e["id"], "_ev": ""})
            continue
        if w or is_comment:
            c["_parked_c"] = False                         # a newer beat or a non-'Parked:' comment unparks it
            if c.get("_hold") and str(e.get("from") or "") == str(c.get("owner") or ""):
                c["_hold"] = None
        if not w and kind in ("pr_comment", "issue_comment", "pr_review"):
            who = str(e.get("from") or "")
            # the owner, or any other fleet seat. a stranger (Others) is not a beat.
            if who == c["owner"] or (fleet_from(who) and not (c["_closed"] or c.get("_merged_t"))):
                if who == c["owner"]:
                    w = "owner: resolved" if e.get("resolved") else "owner comment"
                    if e.get("resolved"):
                        c["_resolved"] = "owner says resolved"
                else:
                    w = "comment"
        if not w and is_comment and (c["_closed"] or c.get("_merged_t")):
            # a comment on a merged or closed card is a beat: the card stays on the board (24h from the comment)
            w = "comment after merge" if c.get("_merged_t") else "comment after close"
        if w and c.get("_merged_t") and not w.startswith(("retest", "owner", "comment")):
            continue                                       # after the merge only merge-queue.md ticks move the card
        if not w:
            if c["_closed"] and not c.get("_merged_t") and c["_closed_t"] and _t(e) >= c["_closed_t"]:
                c["_stop"] = True
            continue
        if w == "opened" and kind in ("pr_open", "issue_open"):
            prepend_owner_prompt(c, e, prompt_rows, used_prompts)
        b = {"t": int(_t(e) * 1000), "what": w, "url": live_packet.clean(e.get("source") or "")[:160] if w.startswith(("CI", "Reviewer")) else "",
             "id": e["id"], "_ev": _evidence(e, w)}
        sha = re.sub(r"[^0-9a-f]", "", str(e.get("sha") or e.get("head_sha") or "").lower())[:7]
        if w.startswith("Reviewer"):
            b["kind"] = "reviewer verdict"                   # tied to the head SHA it was given at
        if sha and (w.startswith("Reviewer") or w == "pushed"):
            b["sha"] = sha
        c["_beats"].append(b)
        if w == "merged":
            c["_merged_t"] = _t(e)
            mb = e.get("merged_by")
            if isinstance(mb, str) and mb.strip():
                c["merged_by"] = mb.strip()[:80]
    out, settled, transitions = [], [], []
    by_id = {}
    for e in evs:
        eid = e.get("id")
        if eid is not None:
            by_id[str(eid)] = e
    for c in cards.values():
        beats = c.pop("_beats")
        merged = any(b["what"] == "merged" for b in beats)
        closed_t = c.pop("_closed_t") or (c.get("_merged_t") or 0)
        last = beats[-1] if beats else None
        # stage from the trail
        stage = "open" if c["kind"] == "issue" else "review"
        for b in beats:
            w = b["what"]
            if w in ("opened", "pushed"):
                stage = "review" if c["kind"] == "pr" else stage
            elif w in ("Reviewer FAIL", "Reviewer HOLD") or w in ("CI failure", "CI timed_out"):
                stage = "fix"
            elif w.startswith("Reviewer PASS") or (w == "CI success" and stage == "merge"):
                stage = "merge" if stage != "fix" or w.startswith("Reviewer PASS") else stage
            elif w == "merged":
                stage = "retest"
            elif w in ("retest PASS", "retest FAIL"):
                stage = "done"                             # a merge-queue.md PASS / FAIL tick ends the card's retest
        if not c.pop("_known") and not merged and (not last or now - last["t"] / 1000 > 86400):
            continue          # open event from before the collector captured state, quiet a day: state unknown, not shown
        resolved = c.pop("_resolved", None) or (f"fixed by {fixed_by[c['key']]}" if c["key"] in fixed_by else None)
        if resolved:
            stage = "done"                                 # owner says resolved / a later merged PR fixes or supersedes it
        explicit_close = bool(c.pop("_closed"))
        closed = explicit_close or (merged and stage == "done") or bool(resolved)
        if c["kind"] == "issue" and closed:
            stage = "done"
        if merged or explicit_close:
            # A merge, an issue close, or a PR close ends the card. It does not stay live for a retest tick.
            # A failed retest after merge needs a new issue.
            closed = True
            stage = "done"
            closed_t = closed_t or (last["t"] / 1000 if last else now)
        if closed and last and last["what"].startswith(("comment", "owner")):
            closed_t = max(closed_t or 0, last["t"] / 1000)   # a late comment keeps the closed card visible
        display_drop = bool(closed and closed_t and now - closed_t > CLOSED_KEEP_S)
        quiet = bool(last) and now - last["t"] / 1000 > 86400
        pr_quiet = c["kind"] == "pr" and bool(last) and now - last["t"] / 1000 > PR_PARK_S
        parked = (not closed) and (c.pop("_parked_c", False) or c.pop("_draft_park", False) or pr_quiet or (c["kind"] == "issue" and quiet) or any(PARKED.search(x) for x in c["labels"]) or (c.pop("_draft") and (not last or now - last["t"] / 1000 > 7 * 86400)))
        sa = c.get("start_after")
        if isinstance(sa, str) and not closed:
            try:
                when = datetime.fromisoformat(sa).timestamp()
            except ValueError:
                when = 0
            if when > now:
                parked = True
        c.pop("_draft", None); c.pop("_parked_c", None); c.pop("_draft_park", None)
        c.pop("_stop", None); c.pop("_merged_t", None)
        state = "closed" if closed else "parked" if parked else "live"
        pk = dict(c["packet"])
        if not pk.get("evidence"):
            ev = next((b["_ev"] for b in reversed(beats) if b["_ev"]), "")
            if ev:
                pk["evidence"] = ev
        last_t = last["t"] / 1000 if last else 0
        stall = state == "live" and bool(last_t) and now - last_t > STALL_S
        heads = [b["sha"] for b in beats if b["what"] == "pushed" and b.get("sha")]
        head = heads[-1] if heads else None
        crit = next((b for b in reversed(beats) if b.get("kind") == "reviewer verdict"), None)
        cis = [b["what"] for b in beats if b["what"].startswith("CI ")]
        ci_ok = not cis or cis[-1] in ("CI success", "CI skipped", "CI neutral")
        at_head = bool(crit) and (not head or not crit.get("sha") or head.startswith(crit["sha"]) or crit["sha"].startswith(head))
        if head:
            c["head"] = head
        if crit:
            c["reviewer"] = {"verdict": crit["what"].split()[1] if len(crit["what"].split()) > 1 else "", "sha": crit.get("sha"), "t": crit["t"], "at_head": at_head}
        if stage == "retest" and state == "live":
            c["nudge_to"] = "tester"                        # Tester owns the retest: merged cards nudge the lab tester
            c["nudge_via"] = "retest owner"
            pk.setdefault("next owner", "Tester")
        elif not merged and state == "live" and crit and crit["what"].startswith("Reviewer PASS") and at_head and ci_ok:
            stage = "merge"                                # PASS at the current head + green CI: Builder merges
            c["nudge_to"], c["nudge_via"] = "builder", "merge (Reviewer PASS at head)"
            pk["next owner"] = "Builder"
        elif not merged and re.search(r"tester", str(pk.get("next owner") or ""), re.I):
            c["nudge_to"], c["nudge_via"] = "builder", "unmerged (Tester only retests after merge)"
        hold = c.pop("_hold", None)
        label = live_packet.labels_held(c.get("labels"))
        if hold and hold.get("reason") and not closed and not parked:
            state, stall = "held", False
            c.pop("nudge_to", None); c.pop("nudge_via", None)
            c["hold"] = {"reason": hold["reason"], "until": hold["until"], "by": hold["by"],
                         "at": int((hold["t"] or 0) * 1000)}
        elif label and not closed and not parked:
            state, stall = "held", False
            c.pop("nudge_to", None); c.pop("nudge_via", None)
            c["hold"] = {"reason": live_packet.clean(label)[:live_packet.HOLD_MAX] or "on-hold",
                         "until": "", "by": "github", "at": int((last_t or now) * 1000)}
        if live_packet.repo_no_nudge(c.get("repo")):
            c.pop("nudge_to", None); c.pop("nudge_via", None)
            stall = False
        missing = [] if brief_exempt(c, pk) else ["PACKET.md"]
        if resolved:
            c["resolved"] = resolved
        shown = _keep_push(beats, 5)
        if closed:
            c["verb"] = "merged" if merged else "closed"
        c.update(stage=stage, state=state, packet=pk, packet_ok=not missing, missing=missing,
                 beats=[{k: v for k, v in b.items() if not k.startswith("_")} for b in shown],
                 last_beat_t=int(last_t * 1000), stall=stall, closed_t=int(closed_t * 1000) if closed else 0)
        close_id = str(c.pop("_close_id", "") or "")
        transitions.extend(_card_transitions(c, beats, by_id, merged, explicit_close, close_id))
        if display_drop:
            settled.append(c)                              # off the board; /history still gets this final state
        else:
            out.append(c)
    # live/parked need a beat in 14 days. Closed rows already passed the 24h display window.
    out = [c for c in out if c["state"] == "closed" or (c["last_beat_t"] and now - c["last_beat_t"] / 1000 < 14 * 86400)]
    # Closed cards inside the window take a slot before the parked backlog. Live and held stay first.
    rank = {"live": 0, "held": 0, "closed": 1, "parked": 2}
    out.sort(key=lambda c: (rank[c["state"]], STAGES.index(c["stage"]), -c["last_beat_t"]))
    visible = out[:MAX_CARDS]
    for c in out[MAX_CARDS:]:
        if c.get("state") == "closed":
            settled.append(c)
    cards = pinned() + visible
    if held:
        cards = _merge_attached(cards, attach_held(held, evs), now)
    return {"updated_ct": datetime.fromtimestamp(now, CT).isoformat(timespec="seconds"),
            "stages": list(STAGES), "stats": stats(evs, now, prompt_rows), "cards": cards, "settled": settled,
            "transitions": transitions}


def reconcile(wave, open_now, now=None):
    """Close every non-closed issue, PR, or packet-born card whose item GitHub reports closed or missing."""
    if not open_now or not isinstance(wave, dict) or not isinstance(wave.get("cards"), list):
        return 0
    now = now or time.time()
    n = 0
    for c in wave["cards"]:
        born_packet = c.get("born") == "packet" or str(c.get("key") or "").lower().startswith("packet:") or str(c.get("alias") or "").lower().startswith("packet:")
        if c.get("pinned") or c.get("state") == "closed" or (c.get("kind") not in ("issue", "pr") and not born_packet):
            continue
        key = str(c.get("key") or "")
        if "#" not in key:
            continue
        repo, _, num = key.rpartition("#")
        nums = open_now.get(repo.lower())
        if nums is None:
            continue
        try:
            missing = int(num) not in nums
        except ValueError:
            continue
        if missing:
            c["state"], c["stage"], c["closed_t"], c["stall"] = "closed", "done", int(now * 1000), False
            c.pop("nudge_to", None); c.pop("nudge_via", None)
            n += 1
    return n


def stats(evs, now=None, prompts=None):
    """Board stats strip, from the same feed events (no GitHub calls): last 24 h + open now."""
    now = now or time.time()
    day = lambda e: now - _t(e) <= 86400
    opened, closed, merged, unmerged = {}, {}, {}, {}
    for e in evs:
        k, key = e.get("kind"), (e.get("repo"), e.get("number"))
        if key[1] is None:
            continue
        if k in ("pr_open", "issue_open"):
            opened[key] = e
            if e.get("pr_state") == "closed":
                closed[key] = e
        elif k in ("issue_close", "pr_close"):
            closed[key] = e
        elif k == "merged":
            merged[key] = e; closed[key] = e
        if k == "pr_close":
            if e.get("merged_at") or e.get("merged") is True:
                merged[key] = e
                closed[key] = e
            unmerged[key] = e
    is_pr = lambda key: opened.get(key, {}).get("kind") == "pr_open" or key in merged or key in unmerged
    iss = [k for k in opened if not is_pr(k)]
    prs = [k for k in opened if is_pr(k)]

    def sid(repo, number) -> str:
        """Same repo#number shape as a card key, so a tile click can find the card or the event."""
        try:
            return f"{str(repo).lower()}#{int(number)}"
        except (TypeError, ValueError):
            return f"{repo}#{number}"

    def window_ids(rows):
        ids = [sid(repo, number) for (repo, number), e in rows if day(e)]
        return len(ids), ids

    issues_opened_n, issues_opened_ids = window_ids((k, opened[k]) for k in iss)
    issues_closed_n, issues_closed_ids = window_ids((k, e) for k, e in closed.items() if not is_pr(k))
    prs_opened_n, prs_opened_ids = window_ids((k, opened[k]) for k in prs)
    prs_merged_n, prs_merged_ids = window_ids(merged.items())
    prs_unmerged_n, prs_unmerged_ids = window_ids((k, e) for k, e in unmerged.items() if k not in merged)
    open_issues = [k for k in iss if k not in closed and "pr_state" in opened[k]]
    open_prs = [k for k in prs if k not in closed and "pr_state" in opened[k]]
    out = {"issues_opened_24h": issues_opened_n, "issues_opened_24h_ids": issues_opened_ids,
           "issues_closed_24h": issues_closed_n, "issues_closed_24h_ids": issues_closed_ids,
           "prs_opened_24h": prs_opened_n, "prs_opened_24h_ids": prs_opened_ids,
           "prs_merged_24h": prs_merged_n, "prs_merged_24h_ids": prs_merged_ids,
           "prs_closed_unmerged_24h": prs_unmerged_n, "prs_closed_unmerged_24h_ids": prs_unmerged_ids,
           "issues_open": len(open_issues), "prs_open": len(open_prs),
           "open_total_ids": [sid(repo, number) for repo, number in open_issues + open_prs]}
    out["open_total"] = out["issues_open"] + out["prs_open"]
    prompt_rows = owner_prompt_rows(evs, now, prompts)
    out["owner_prompts_24h"] = len(prompt_rows)
    out["owner_prompts_24h_ids"] = [activity_id(e) for e in prompt_rows]
    out["owner_prompts_24h_bytes"] = sum(archived_bytes(e) for e in prompt_rows)
    return out


OWNER_NAME = re.compile(r"[A-Za-z0-9 ._:@#+/-]{1,40}")


def _owner_token(text):
    line = ""
    if text:
        parts = str(text).splitlines()
        line = parts[0].strip() if parts else ""
    return line if line and OWNER_NAME.fullmatch(line) else ""


def owner_name():
    """Configured owner. LIVE_OWNER, then LIVE_OWNER_FILE, then the name: line under ## Owner."""
    env = _owner_token(os.environ.get("LIVE_OWNER", ""))
    if env:
        return env
    named = os.environ.get("LIVE_OWNER_FILE", "").strip()
    if named:
        try:
            got = _owner_token(Path(named).read_text(encoding="utf-8"))
        except OSError:
            got = ""
        if got:
            return got
    raw = os.environ.get("HOUSE", "").strip()
    path = None
    if raw:
        candidate = Path(raw).expanduser()
        if candidate.is_file():
            path = candidate
    if path is None:
        for candidate in (HOUSE / "HOUSE.md", Path("house") / "HOUSE.md"):
            if candidate.is_file():
                path = candidate
                break
    if path is None:
        return ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    section = ""
    for part in re.split(r"(?m)^##\s+", text):
        if part.startswith("Owner"):
            section = part
            break
    found = re.search(r"(?m)^name:\s*(\S.*?)\s*$", section)
    return found.group(1).strip() if found else ""


def activity_id(e):
    eid = str(e.get("id") or "")
    if eid.startswith("act:"):
        return eid[4:]
    return eid


def archived_bytes(e):
    """Byte size of the archived JSON line. An integer bytes field is that size already."""
    if isinstance(e.get("bytes"), int):
        return e["bytes"]
    raw = json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n"
    return len(raw.encode("utf-8"))


def owner_prompt_rows(evs, now, prompts=None):
    owner = owner_name().casefold()
    if not owner:
        return []
    rows = []
    seen = set()
    for e in list(prompts or []) + list(evs):
        if str(e.get("kind") or "") not in ("prompt", "seat_prompt"):
            continue
        eid = activity_id(e)
        if eid in seen:
            continue
        seen.add(eid)
        if str(e.get("from") or "").casefold() != owner:
            continue
        if now - _t(e) > 86400:
            continue
        rows.append(e)
    rows.sort(key=lambda e: (_t(e), activity_id(e)))
    return rows


def stall_lines(m, now=None):
    """One fleet/inbox/coord.jsonl line per stalled live card (keyed by its last beat, so once per stall)."""
    lines = []
    for c in m["cards"]:
        if not c.get("stall") or not c.get("beats"):
            continue
        b = c["beats"][-1]
        lines.append({"id": f"stall60:{c['key']}:{b['id']}", "t_ct": datetime.fromtimestamp(now or time.time(), CT).isoformat(timespec="seconds"),
                      "seat": "coord", "type": "stall", "repo": c["repo"], "number": c["number"], "title": c["title"][:120],
                      "url": c["url"][:300], "reason": f"no beat for 60 min ({c['stage']})"})
    if not lines:
        return 0
    INBOX.mkdir(parents=True, exist_ok=True)
    p = INBOX / "coord.jsonl"
    known = set()
    if p.is_file():
        for raw in p.read_text(encoding="utf-8").splitlines():
            try:
                known.add(json.loads(raw).get("id"))
            except ValueError:
                pass
    fresh = [l for l in lines if l["id"] not in known]
    if fresh:
        with p.open("a", encoding="utf-8") as fh:
            for l in fresh:
                fh.write(json.dumps(l, ensure_ascii=False) + "\n")
    return len(fresh)


def write_md(m, now=None, force=False):
    """house/BOARD.md from the same model, at most once a minute."""
    now = now or time.time()
    if not force and now - _last_md[0] < MD_EVERY_S:
        return False
    _last_md[0] = now
    L = ["<!-- GENERATED by live-mesh feed/live_board.py from the live feed model (cards / packets / beats);",
         "     do not hand-edit; pinned items come from watchers/board-static.md. -->", "",
         "# \U0001F30A BOARD (live)", "", f"**Updated: {datetime.fromtimestamp(now, CT).strftime('%a %b %-d, %Y %-I:%M %p')} CT** · "
         "cards = GitHub issues / PRs · stage open > review > fix > merge > retest > done", ""]
    pins = [c for c in m["cards"] if c.get("pinned")]
    if pins:
        L += ["## Pinned", ""] + [f"- **{c['title']}** ({c['section']}, {c['owner']})" for c in pins] + [""]
    for st in STAGES:
        cs = [c for c in m["cards"] if not c.get("pinned") and c["stage"] == st and c["state"] != "closed"]
        if not cs:
            continue
        L += [f"## {st.capitalize()} ({len(cs)})", ""]
        for c in cs:
            flags = []
            if c["state"] == "parked":
                flags.append("parked")
            if c["stall"]:
                flags.append("STALL 60m+")
            if not c["packet_ok"]:
                flags.append("no packet")
            last = c["beats"][-1] if c["beats"] else None
            L.append(f"- [{c['repo'].split('/')[-1]} #{c['number']}]({c['url']}) {c['title']} · owner {c['owner']}"
                     + (f" · last beat {last['what']} {_ct(last['t'] / 1000)}" if last else "")
                     + (f" · next {c['packet'].get('next owner')}" if c['packet'].get('next owner') else "")
                     + (f" · start after {c['start_after']}" if c.get("start_after") else "")
                     + (" · **" + ", ".join(flags) + "**" if flags else ""))
        L.append("")
    closed = [c for c in m["cards"] if c["state"] == "closed"]
    if closed:
        L += ["## Closed (last 24 hours)", ""] + [f"- {c['repo'].split('/')[-1]} #{c['number']} {c['title']}" for c in closed] + [""]
    try:
        MD.parent.mkdir(parents=True, exist_ok=True)
        tmp = MD.with_suffix(f".md.{os.getpid()}.tmp")
        tmp.write_text("\n".join(L), encoding="utf-8")
        os.replace(tmp, MD)
        return True
    except OSError:
        return False


def held_from_disk():
    """Packet cards the server already wrote, so a collector pass can attach them."""
    raw = os.environ.get("LIVE_HELD_CARDS", "").strip()
    path = Path(raw) if raw else RUN / "live" / "cards.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    cards = data.get("cards") if isinstance(data, dict) else data
    if not isinstance(cards, list):
        return None
    held = []
    for card in cards:
        if not isinstance(card, dict) or str(card.get("state") or "").lower() == "closed":
            continue
        key = str(card.get("key") or "").lower()
        if key.startswith("packet:") or card.get("born") == "packet":
            held.append(card)
    return held or None


def run(extra_events=None, write=True, prompts=None, held=None):
    """One feed pass: model for the page header, coord stall lines, BOARD.md (debounced). Never raises."""
    try:
        if held is None:
            held = held_from_disk()
        m = model(extra_events, prompts=prompts, held=held)
        if write and os.environ.get("LIVE_BOARD_LOCAL") == "1":   # retired: the server holds cards + nudges
            stall_lines(m)
            write_md(m)
        return m
    except Exception as ex:  # the feed must keep writing
        print(f"[board] cards: step failed ({type(ex).__name__}: {ex})", flush=True)
        return None
