# Vendored from example-org/xray PR #5 (cursor/seat-inbox-2826 @ 547c0c3a2) house/live/inbox.py; keep in sync, do not edit here.
"""Route new feed events into per-seat inbox files.

The feed loop calls deliver() once per pass. A line is appended only when its
event id is not already in that seat's file. Bodies, prompt text, and secrets
are not copied. Files keep the last keep_days of lines.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

LIVE_INBOX = os.path.join(os.environ.get("LIVE_HOME", "/srv/live"), "run", "fleet", "inbox")
MIRROR_SEAT = "builder"
_BANNED = re.compile(r"body|text|message", re.I)
_SECRET = re.compile(r"ghs_|github_pat_|BEGIN PRIVATE|AKIA[0-9A-Z]{16}")
_SEAT_FILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
_FIELDS = ("id", "t_ct", "seat", "type", "repo", "number", "sha", "title", "url", "reason")


def default_roles() -> dict:
    path = Path(__file__).resolve().parent / "inbox-roles.json"
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"keep_days": 7, "stall_hours": 6, "seats": {}}


def load_roles(path: str | None = None) -> dict:
    chosen = path if path is not None else os.environ.get("LIVE_INBOX_ROLES", "").strip()
    if not chosen:
        return default_roles()
    file = Path(chosen)
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise SystemExit("inbox roles file must be JSON") from exc
    if not isinstance(data, dict):
        raise SystemExit("inbox roles must be an object")
    return data


def inbox_dir(default: str = "fleet/inbox") -> Path:
    return Path(os.environ.get("LIVE_INBOX", default))


def _hints(event: dict) -> dict:
    extra = event.get("_inbox")
    return extra if isinstance(extra, dict) else {}


def _field(event: dict, key: str):
    extra = _hints(event)
    if key in extra and extra[key] is not None:
        return extra[key]
    return event.get(key)


def _stamp(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _hay(event: dict) -> str:
    parts: list[str] = []
    for key in ("title", "label", "detail", "actor", "from", "name", "context", "text"):
        val = _field(event, key)
        if isinstance(val, str):
            parts.append(val)
    labels = _field(event, "labels") or []
    if isinstance(labels, list):
        parts.extend(str(item) for item in labels if item is not None)
    needles = _field(event, "needles") or []
    if isinstance(needles, list):
        parts.extend(str(item) for item in needles if item is not None)
    return " ".join(parts)


def _has(hay: str, needle: str) -> bool:
    folded = hay.casefold()
    want = needle.casefold()
    if not want:
        return False
    return re.search(r"(?<![a-z0-9])" + re.escape(want) + r"(?![a-z0-9])", folded) is not None


def _labels(event: dict) -> list[str]:
    raw = _field(event, "labels") or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if item]


def _sha(event: dict) -> str:
    raw = _field(event, "sha") or ""
    text = str(raw).strip().lower()
    if len(text) < 7 or any(ch not in "0123456789abcdef" for ch in text):
        return ""
    return text


def _same_sha(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return left.startswith(right) or right.startswith(left)


def _kind(event: dict) -> str:
    return str(event.get("kind") or "")


def _green(event: dict) -> bool:
    kind = _kind(event)
    if kind.startswith("deploy") or kind.startswith("reviewer"):
        return False
    if kind == "ci_pass":
        return True
    if kind == "ci_fail":
        return False
    conclusion = str(_field(event, "conclusion") or _field(event, "state") or "").lower()
    name = " ".join(str(_field(event, key) or "") for key in ("name", "context", "app")).lower()
    if "reviewer" in name:
        return False
    if "railway" in name:
        return False
    if kind in ("check_run", "workflow_run", "check_suite") and conclusion == "success":
        return True
    return False


def _critic_pass(event: dict) -> bool:
    return _kind(event) == "critic_pass"


def _number(event: dict) -> int:
    raw = event.get("number")
    if raw is None:
        raw = _field(event, "number")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def _title(event: dict) -> str:
    raw = _field(event, "title")
    if not isinstance(raw, str) or not raw.strip():
        raw = event.get("label") if isinstance(event.get("label"), str) else ""
    text = " ".join(raw.split())
    return text[:120]


def _url(event: dict) -> str:
    raw = event.get("source") if isinstance(event.get("source"), str) else ""
    if raw.startswith("https://") or raw.startswith("http://"):
        return raw[:300]
    return ""


def _line(event: dict, seat: str, reason: str, line_id: str | None = None, line_type: str | None = None) -> dict | None:
    title = _title(event)
    blob = title + " " + reason
    if _BANNED.search(reason) or _SECRET.search(blob):
        return None
    line = {
        "id": line_id or str(event.get("id") or ""),
        "t_ct": event.get("t_ct") if isinstance(event.get("t_ct"), str) else "",
        "seat": seat,
        "type": line_type or _kind(event),
        "repo": str(event.get("repo") or ""),
        "number": _number(event),
        "title": title,
        "url": _url(event),
        "reason": reason[:80],
    }
    sha = _sha(event)
    if sha:
        line["sha"] = sha
    if not line["id"] or not line["t_ct"] or not _SEAT_FILE.match(seat):
        return None
    if any(_BANNED.search(key) for key in line):
        return None
    return line


def _seat_rules(roles: dict, seat: str) -> dict:
    seats = roles.get("seats") or {}
    rules = seats.get(seat) or {}
    return rules if isinstance(rules, dict) else {}


def _direct(event: dict, roles: dict) -> list[dict]:
    out: list[dict] = []
    kind = _kind(event)
    hay = _hay(event)
    labels = [item.casefold() for item in _labels(event)]
    reviewer = _seat_rules(roles, "reviewer")
    if kind in set(reviewer.get("kinds") or ["pr_open", "pr_update"]):
        line = _line(event, "reviewer", "new or updated pr")
        if line:
            out.append(line)
    tester = _seat_rules(roles, "tester")
    bases = [str(item).casefold() for item in (tester.get("merge_bases") or roles.get("develop_branches") or ["develop"])]
    base = str(_field(event, "base") or "").casefold()
    if kind == "merged" and base in bases:
        line = _line(event, "tester", "merge to develop")
        if line:
            out.append(line)
    operator = _seat_rules(roles, "operator")
    op_kinds = set(operator.get("kinds") or ["deploy", "deploy_fail", "deploy_pending", "deploy_hold"])
    if kind in op_kinds or _field(event, "hold") is True:
        reason = "railway hold" if "hold" in kind or "pending" in kind or _field(event, "hold") is True else "railway deploy"
        line = _line(event, "operator", reason, line_type="deploy_hold" if reason == "railway hold" else kind)
        if line:
            out.append(line)
    op_needles = list(operator.get("needles") or [])
    op_labels = [str(item).casefold() for item in (operator.get("labels") or [])]
    lab_label = any(item in labels for item in op_labels) or any(_has(hay, item) and item == "lab" for item in op_labels)
    mentioned = [needle for needle in op_needles if _has(hay, needle)]
    issue_like = kind.startswith("issue") or kind in ("comment", "issue_comment", "pr_comment")
    if issue_like and (lab_label or mentioned):
        extra = [needle for needle in mentioned if not (lab_label and needle.casefold() == "lab")]
        if lab_label and not extra:
            reason = "lab issue"
        elif any(needle.casefold() in ("operator", "ops-app") for needle in extra) and not any(
            needle.casefold() in ("railway", "lab", "labtest", "cloud agent", "cloud agents") for needle in extra
        ):
            reason = "mentions operator"
        else:
            reason = "asks for railway, lab, or cloud agents"
        line = _line(event, "operator", reason)
        if line:
            out.append(line)
    coord = _seat_rules(roles, "coord")
    cos_labels = [str(item).casefold() for item in (coord.get("labels") or [])]
    cos_needles = list(coord.get("needles") or [])
    hit = any(item in labels for item in cos_labels) or any(_has(hay, needle) for needle in cos_needles)
    if hit:
        line = _line(event, "coord", "needs decision")
        if line:
            out.append(line)
    return out


def _ready_lines(events: list[dict], roles: dict) -> list[dict]:
    if not _seat_rules(roles, "builder").get("ready", True):
        return []
    groups: dict[tuple, dict] = {}
    for event in events:
        sha = _sha(event)
        number = event.get("number")
        if not sha or number is None:
            continue
        try:
            number_key = int(number)
        except (TypeError, ValueError):
            continue
        key = (str(event.get("repo") or ""), number_key)
        slot = groups.setdefault(key, {"pass": [], "states": []})
        if _critic_pass(event):
            slot["pass"].append(event)
        state = ""
        if _kind(event) == "ci_fail":
            state = "fail"
        elif _green(event):
            state = "green"
        else:
            conclusion = str(_field(event, "conclusion") or "").lower()
            name = str(_field(event, "name") or _field(event, "app") or "").lower()
            if (conclusion in ("failure", "cancelled", "timed_out", "startup_failure")
                    and "reviewer" not in name and not _kind(event).startswith(("reviewer", "deploy"))):
                state = "fail"
        if state:
            slot["states"].append((_stamp(event.get("t_ct")) or datetime.min.replace(tzinfo=timezone.utc), state, event))
    out = []
    for (repo, number), slot in groups.items():
        if not slot["pass"] or not slot["states"]:
            continue
        latest = max(slot["states"], key=lambda item: item[0])
        if latest[1] != "green":
            continue
        slot["green"] = [item[2] for item in slot["states"] if item[1] == "green"]
        for passed in slot["pass"]:
            match = next((item for item in slot["green"] if _same_sha(_sha(passed), _sha(item))), None)
            if match is None:
                continue
            sha = _sha(match) if len(_sha(match)) >= len(_sha(passed)) else _sha(passed)
            sample = dict(match)
            sample["repo"] = repo
            sample["number"] = number
            sample["_inbox"] = dict(_hints(match))
            sample["_inbox"]["sha"] = sha
            sample["_inbox"]["title"] = _title(passed) or _title(match)
            if not sample.get("source"):
                sample["source"] = passed.get("source") or ""
            if not sample.get("t_ct"):
                sample["t_ct"] = passed.get("t_ct")
            line = _line(
                sample, "builder", "reviewer pass and green ci",
                line_id=f"ready:{repo}#{number}:{sha}", line_type="ready")
            if line:
                out.append(line)
            break
    return out


def _open_prs(events: list[dict]) -> dict[tuple, dict]:
    grouped: dict[tuple, list] = {}
    for event in events:
        if event.get("number") is None or not event.get("repo"):
            continue
        if _kind(event) not in ("pr_open", "pr_update", "merged", "pr_close", "review", "comment", "pr_comment", "critic_pass", "critic_fail", "ci_pass", "ci_fail"):
            continue
        key = (str(event["repo"]), int(event["number"]))
        grouped.setdefault(key, []).append(event)
    open_prs = {}
    for key, rows in grouped.items():
        if not any(_kind(row) in ("pr_open", "pr_update") for row in rows):
            continue
        last = max(rows, key=lambda row: _stamp(row.get("t_ct")) or datetime.min.replace(tzinfo=timezone.utc))
        closed = [row for row in rows if _kind(row) in ("merged", "pr_close")]
        if closed:
            close_at = max(_stamp(row.get("t_ct")) or datetime.min.replace(tzinfo=timezone.utc) for row in closed)
            last_at = _stamp(last.get("t_ct")) or datetime.min.replace(tzinfo=timezone.utc)
            if close_at >= last_at:
                continue
        open_prs[key] = last
    return open_prs


def _stall_lines(events: list[dict], roles: dict, now: datetime) -> list[dict]:
    if not _seat_rules(roles, "coord").get("stalls", True):
        return []
    hours = float(roles.get("stall_hours") or 6)
    out = []
    for (repo, number), last in _open_prs(events).items():
        last_at = _stamp(last.get("t_ct"))
        if last_at is None or now - last_at < timedelta(hours=hours):
            continue
        sample = dict(last)
        sample["repo"] = repo
        sample["number"] = number
        line = _line(
            sample, "coord", "stall",
            line_id=f"stall:{repo}#{number}:{last.get('id')}", line_type="stall")
        if line:
            line["t_ct"] = now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
            out.append(line)
    return out


def _watcher_gap_lines(roles: dict, now: datetime, activity: list[dict]) -> list[dict]:
    if not _seat_rules(roles, "coord").get("watcher_gaps", True):
        return []
    hours = float(roles.get("watcher_gap_hours") or roles.get("stall_hours") or 6)
    seats = list(roles.get("watcher_seats") or [])
    out = []
    for seat in seats:
        if not isinstance(seat, str) or not _SEAT_FILE.match(seat):
            continue
        latest = None
        latest_id = "none"
        for line in activity or []:
            if not isinstance(line, dict):
                continue
            if str(line.get("kind") or "") != "watcher":
                continue
            if str(line.get("seat") or "").casefold() != seat.casefold():
                continue
            stamp = _stamp(line.get("t_ct"))
            if stamp is None:
                continue
            if latest is None or stamp > latest:
                latest = stamp
                latest_id = str(line.get("tag") or line.get("t_ct") or "line")
        if latest is not None and now - latest < timedelta(hours=hours):
            continue
        line = _line(
            {"id": f"watcher-gap:{seat}:{latest_id}", "t_ct": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
             "kind": "watcher_gap", "repo": "", "number": 0, "label": seat, "source": ""},
            "coord", "watcher gap", line_id=f"watcher-gap:{seat}:{latest_id}", line_type="watcher_gap")
        if line:
            out.append(line)
    return out


def _known_ids(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    found = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            item = json.loads(raw)
        except ValueError:
            continue
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            found.add(item["id"])
    return found


def _append(path: Path, lines: list[dict]) -> int:
    if not lines:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for line in lines:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")
    return len(lines)


def trim_inbox(directory: Path, now: datetime, keep_days: float) -> None:
    """Drop lines older than keep_days. A line with no time stays."""
    if not directory.is_dir():
        return
    cutoff = now - timedelta(days=keep_days)
    for path in directory.glob("*.jsonl"):
        kept = []
        changed = False
        for raw in path.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            try:
                item = json.loads(raw)
            except ValueError:
                changed = True
                continue
            stamp = _stamp(item.get("t_ct")) if isinstance(item, dict) else None
            if stamp is not None and stamp < cutoff:
                changed = True
                continue
            kept.append(raw)
        if not changed:
            continue
        tmp = path.with_suffix(".jsonl.tmp")
        tmp.write_text(("\n".join(kept) + ("\n" if kept else "")), encoding="utf-8")
        os.replace(tmp, path)


def deliver(new_events: list[dict], all_events: list[dict] | None = None, directory: Path | None = None,
            roles: dict | None = None, now: datetime | None = None, activity: list[dict] | None = None) -> dict[str, int]:
    """Append one line per new routed id. Return seat -> lines written."""
    roles = roles if roles is not None else load_roles()
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    directory = directory or inbox_dir()
    all_events = list(all_events if all_events is not None else new_events)
    try:
        import deploy_status
    except ImportError:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        import deploy_status
    hold_ids = set(deploy_status.classify(all_events, now)["holds"])
    op_rules = (roles.get("seats") or {}).get("operator") or {}
    op_seat = op_rules.get("seat") if isinstance(op_rules, dict) and isinstance(op_rules.get("seat"), str) else "operator"
    routed: list[dict] = []
    for event in new_events or []:
        if isinstance(event, dict):
            lines = _direct(event, roles)
            # A non-hold pending is not work. Drop it for the operator role (kit name or the mapped seat).
            if str(event.get("kind") or "") == "deploy_pending" and event.get("id") not in hold_ids:
                lines = [line for line in lines if line.get("seat") not in ("operator", op_seat)]
            routed.extend(lines)
    routed.extend(_ready_lines(all_events, roles))
    routed.extend(_stall_lines(all_events, roles, now))
    if activity is None:
        activity_path = os.environ.get("LIVE_ACTIVITY", "fleet/activity.jsonl").strip()
        activity = []
        if activity_path and Path(activity_path).is_file():
            for raw in Path(activity_path).read_text(encoding="utf-8").splitlines():
                try:
                    activity.append(json.loads(raw))
                except ValueError:
                    continue
    routed.extend(_watcher_gap_lines(roles, now, activity or []))
    written: dict[str, int] = {}
    by_seat: dict[str, list] = {}
    for line in routed:
        by_seat.setdefault(line["seat"], []).append(line)
    for seat, lines in by_seat.items():
        if not _SEAT_FILE.match(seat):
            continue
        path = directory / f"{seat}.jsonl"
        known = _known_ids(path)
        fresh = []
        seen = set()
        for line in lines:
            if line["id"] in known or line["id"] in seen:
                continue
            if set(line) - set(_FIELDS):
                continue
            seen.add(line["id"])
            fresh.append(line)
        count = _append(path, fresh)
        if count:
            written[seat] = count
    keep = float(roles.get("keep_days") or 7)
    trim_inbox(directory, now, keep)
    return written


def _board():
    name = "board_builder"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parent / "board.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def maybe_board(new_count: int, log=None, env: dict | None = None) -> str:
    try:
        return _board().maybe_board(new_count, env=env, log=log)
    except Exception as exc:
        if log:
            log(f"board failed ({type(exc).__name__})")
        return "failed"


def scrub_event(event: dict) -> dict:
    event.pop("_inbox", None)
    return event


def scrub_feed(feed: dict) -> dict:
    for event in feed.get("events") or []:
        if isinstance(event, dict):
            scrub_event(event)
    return feed
