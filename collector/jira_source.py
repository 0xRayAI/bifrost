"""Jira source adapter.

Pull: the server polls Jira with JIRA_SITE, JIRA_PROJECTS, JIRA_EMAIL, and JIRA_API_TOKEN.
Push: a connector posts the same normalized events to POST /ingest/source.

The project allowlist is JIRA_PROJECTS. JIRA_EXCLUDE (comma or space separated) is never polled.
Issue descriptions and comments are not requested and are not stored.
A seat does not run this poll.
"""
import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

EXCLUDED = frozenset(p.strip().upper() for p in os.environ.get("JIRA_EXCLUDE", "").replace(",", " ").split() if p.strip())
KEY_RE = re.compile(r"^([A-Z][A-Z0-9]{1,9})-(\d+)$")
PROJECT_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
FIELDS = ["summary", "status", "updated", "created", "project", "assignee"]
POLL_S = 60
PAGE_CAP = 10
FIRST_WINDOW = "-7d"
OVERLAP = timedelta(minutes=2)
FEED_MAX = 5000


class JiraAuthError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def project_allowlist(raw):
    """None when unset (no poll). A list when set, with JIRA_EXCLUDE keys removed."""
    if raw is None or not str(raw).strip():
        return None
    out = []
    for part in re.split(r"[\s,]+", str(raw).strip()):
        key = part.strip().upper()
        if not key or key in EXCLUDED or not PROJECT_RE.fullmatch(key):
            continue
        if key not in out:
            out.append(key)
    return out


def site_host(raw):
    host = (raw or "").strip()
    if "://" in host:
        host = host.split("://", 1)[1]
    host = host.split("/")[0].split("@")[-1]
    if "@" in (raw or "") or not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", host):
        raise ValueError("bad JIRA_SITE")
    if ".." in host or host.startswith(".") or host.endswith("."):
        raise ValueError("bad JIRA_SITE")
    return host.lower()


def api_base(site, override=""):
    if override:
        base = override.strip().rstrip("/")
        if not re.fullmatch(r"https?://[A-Za-z0-9.:-]+", base):
            raise ValueError("bad JIRA_API_BASE")
        return base
    return "https://" + site


def clean(value, limit):
    text = EMAIL_RE.sub("[email]", str(value or ""))
    text = " ".join(text.split())
    return text[:limit].rstrip()


def parse_time(raw):
    text = str(raw or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if re.search(r"[+-]\d{4}$", text):
        text = text[:-2] + ":" + text[-2:]
    return datetime.fromisoformat(text)


def iso_utc(raw):
    moment = parse_time(raw).astimezone(timezone.utc)
    millis = moment.microsecond // 1000
    stamp = moment.strftime("%Y-%m-%dT%H:%M:%S")
    if millis:
        return f"{stamp}.{millis:03d}Z"
    return stamp + "Z"


def later(a, b):
    if not a:
        return b or ""
    if not b:
        return a
    return a if parse_time(a) >= parse_time(b) else b


def relative_window(watermark, now):
    """Jira reads an unzoned stamp in the API user's zone, so the window is relative."""
    if not watermark:
        return FIRST_WINDOW
    age = (now - parse_time(watermark).astimezone(timezone.utc)).total_seconds()
    if age < 0:
        age = 0
    minutes = max(int(OVERLAP.total_seconds() // 60), (int(age + OVERLAP.total_seconds()) + 59) // 60)
    return f"-{minutes}m"


def jql_for(projects, watermark, now=None):
    now = now or datetime.now(timezone.utc)
    names = ", ".join(projects)
    return f"project in ({names}) AND updated >= {relative_window(watermark, now)} ORDER BY updated ASC"


def _same_moment(created, updated):
    if not created or not updated:
        return False
    try:
        return abs((parse_time(created) - parse_time(updated)).total_seconds()) <= 2
    except ValueError:
        return created == updated


def classify(fields, prev):
    category = (((fields.get("status") or {}).get("statusCategory") or {}).get("key") or "").lower()
    state = "closed" if category == "done" else "open"
    if state == "closed":
        kind = "closed"
    elif prev == "closed":
        kind = "reopened"
    elif prev is None and _same_moment(fields.get("created"), fields.get("updated")):
        kind = "opened"
    else:
        kind = "updated"
    return kind, state


def actor_of(fields):
    name = clean(((fields.get("assignee") or {}).get("displayName") or ""), 80)
    if not name or name == "[email]" or "@" in name:
        return ""
    return name


def normalize(issue, projects, site, prev):
    """One normalized event, or None when the issue is outside the allowlist."""
    key = str((issue or {}).get("key") or "")
    match = KEY_RE.fullmatch(key)
    if not match:
        return None
    project = match.group(1)
    fields = issue.get("fields") or {}
    reported = str(((fields.get("project") or {}).get("key") or project)).upper()
    if reported in EXCLUDED or reported not in projects or project in EXCLUDED or project not in projects:
        return None
    updated = fields.get("updated") or ""
    if not updated:
        return None
    kind, state = classify(fields, prev)
    title = clean(fields.get("summary") or "", 200)
    event = {
        "id": f"jira:{key}:{iso_utc(updated)}",
        "source": "jira",
        "t": iso_utc(updated),
        "kind": kind,
        "key": key,
        "url": f"https://{site}/browse/{key}",
        "state": state,
        "project": project,
    }
    if title and title != "[email]":
        event["title"] = title
    actor = actor_of(fields)
    if actor:
        event["actor"] = actor
    status_name = clean(((fields.get("status") or {}).get("name") or ""), 80)
    if status_name and status_name != "[email]" and "@" not in status_name:
        event["status"] = status_name
    return event


def search_body(jql, page_token=None):
    body = {"jql": jql, "maxResults": 50, "fields": list(FIELDS)}
    if page_token:
        body["nextPageToken"] = page_token
    return body


def poll_once(projects, site, fetch, cursor, now=None):
    """fetch(body) -> (status, payload). Returns (events, cursor). Raises JiraAuthError on 401/403.

    The overlap window returns issues we already stored. Those are skipped by key + updated (the event id)."""
    now = now or datetime.now(timezone.utc)
    state = dict(cursor.get("state") or {})
    watermark = cursor.get("watermark") or ""
    seen_ids = [s for s in (cursor.get("seen") or []) if isinstance(s, str)]
    seen_set = set(seen_ids)
    events = []
    body = search_body(jql_for(projects, watermark, now))
    pages = set()
    for _ in range(PAGE_CAP):
        status, payload = fetch(body)
        if status in (401, 403):
            raise JiraAuthError()
        if status != 200 or not isinstance(payload, dict):
            raise RuntimeError(f"http {status}")
        for issue in payload.get("issues") or []:
            fields = issue.get("fields") or {}
            watermark = later(watermark, fields.get("updated") or "")
            key = str(issue.get("key") or "")
            event = normalize(issue, projects, site, state.get(key))
            if not event or event["id"] in seen_set:
                continue
            events.append(event)
            seen_ids.append(event["id"])
            seen_set.add(event["id"])
            state[key] = event["state"]
        token = payload.get("nextPageToken")
        if payload.get("isLast") or not token or token in pages:
            break
        pages.add(token)
        body = search_body(body["jql"], token)
    if len(state) > 2000:
        state = {k: state[k] for k in list(state)[-2000:]}
    if len(seen_ids) > FEED_MAX:
        seen_ids = seen_ids[-FEED_MAX:]
    return events, {"watermark": watermark, "state": state, "seen": seen_ids}


def load_cursor(path):
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {"watermark": "", "state": {}}
    if not isinstance(data, dict):
        return {"watermark": "", "state": {}}
    state = data.get("state") if isinstance(data.get("state"), dict) else {}
    seen = [s for s in (data.get("seen") or []) if isinstance(s, str)]
    return {"watermark": str(data.get("watermark") or ""), "state": state, "seen": seen}


def atomic_write(path, text):
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(text)
    os.replace(tmp, dest)


def load_feed(path):
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return []
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list):
        return []
    return [e for e in events if isinstance(e, dict) and isinstance(e.get("id"), str)]


def merge_events(existing, incoming, limit=FEED_MAX):
    """First copy of an id wins. The newest `limit` events are kept."""
    by_id = {}
    for event in existing:
        if isinstance(event, dict) and isinstance(event.get("id"), str):
            by_id.setdefault(event["id"], event)
    for event in incoming:
        if isinstance(event, dict) and isinstance(event.get("id"), str):
            by_id.setdefault(event["id"], event)
    events = sorted(by_id.values(), key=lambda event: event.get("t") or "")
    if len(events) > limit:
        events = events[-limit:]
    return events


def _with_feed_lock(path, fn):
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    lock = dest.with_name(dest.name + ".lock")
    for _ in range(40):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 5:
                    lock.unlink()
            except OSError:
                pass
            time.sleep(0.025)
            continue
        try:
            return fn()
        finally:
            os.close(fd)
            try:
                lock.unlink()
            except OSError:
                pass
    raise RuntimeError("feed lock busy")


def write_feed(path, events):
    def write():
        merged = merge_events(load_feed(path), events)
        payload = {
            "source": "jira",
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "events": merged,
        }
        atomic_write(path, json.dumps(payload, ensure_ascii=False))
        return merged

    return _with_feed_lock(path, write)


def config_from_env(env=None):
    env = os.environ if env is None else env
    site = site_host(env.get("JIRA_SITE") or "")
    projects = project_allowlist(env.get("JIRA_PROJECTS"))
    email = env.get("JIRA_EMAIL") or ""
    token = env.get("JIRA_API_TOKEN") or ""
    if not email or not token:
        raise ValueError("missing Jira credentials")
    return {
        "site": site,
        "projects": projects or [],
        "email": email,
        "token": token,
        "base": api_base(site, env.get("JIRA_API_BASE") or ""),
    }


def auth_header(email, token):
    raw = base64.b64encode(f"{email}:{token}".encode()).decode()
    return "Basic " + raw


def http_fetch(cfg):
    url = cfg["base"].rstrip("/") + "/rest/api/3/search/jql"
    opener = urllib.request.build_opener(_NoRedirect)

    def fetch(body):
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": auth_header(cfg["email"], cfg["token"]),
                "User-Agent": "bifrost-jira-source",
            },
        )
        try:
            with opener.open(req, timeout=30) as res:
                return res.status, json.loads(res.read().decode() or "null")
        except urllib.error.HTTPError as err:
            err.read()
            return err.code, None

    return fetch


def one_pull(cfg, out):
    cursor_path = Path(out).with_name("jira-cursor.json")
    cursor = load_cursor(cursor_path)
    events, nxt = poll_once(cfg["projects"], cfg["site"], http_fetch(cfg), cursor)
    if events:
        write_feed(out, events)
        print(f"jira: {len(events)} events", file=sys.stderr)
    atomic_write(cursor_path, json.dumps(nxt))


def post_events(url, secret, events):
    dest = url.rstrip("/") + "/ingest/source"
    body = json.dumps({"source": "jira", "events": events}).encode()
    req = urllib.request.Request(
        dest,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-Live-Ingest": secret, "User-Agent": "bifrost-jira-source"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status
    except urllib.error.HTTPError as err:
        err.read()
        return err.code


def run_pull(out, once):
    cfg = config_from_env()
    if not cfg["projects"]:
        print("jira: off (no allowed projects)", file=sys.stderr)
        return 0
    while True:
        try:
            one_pull(cfg, out)
        except JiraAuthError:
            print("jira: auth failed", file=sys.stderr)
        except Exception as err:
            print(f"jira: poll failed ({type(err).__name__})", file=sys.stderr)
        if once:
            return 0
        time.sleep(POLL_S)


def run_push(url):
    secret = os.environ.get("INGEST_SECRET") or ""
    if not secret:
        print("jira: push needs INGEST_SECRET", file=sys.stderr)
        return 2
    cfg = config_from_env()
    if not cfg["projects"]:
        print("jira: off (no allowed projects)", file=sys.stderr)
        return 0
    cursor = load_cursor(Path(os.environ.get("JIRA_CURSOR") or os.devnull))
    try:
        events, _nxt = poll_once(cfg["projects"], cfg["site"], http_fetch(cfg), cursor)
    except JiraAuthError:
        print("jira: auth failed", file=sys.stderr)
        return 1
    if not events:
        print("jira: 0 events", file=sys.stderr)
        return 0
    status = post_events(url, secret, events)
    print(f"jira: pushed {len(events)} ({status})", file=sys.stderr)
    return 0 if status == 200 else 1


def main(argv=None):
    parser = argparse.ArgumentParser(prog="jira_source")
    sub = parser.add_subparsers(dest="mode", required=True)
    pull = sub.add_parser("pull")
    pull.add_argument("--out", required=True)
    pull.add_argument("--once", action="store_true")
    push = sub.add_parser("push")
    push.add_argument("--url", required=True)
    args = parser.parse_args(argv)
    if args.mode == "pull":
        return run_pull(args.out, args.once)
    return run_push(args.url)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ValueError as err:
        print(f"jira: {err}", file=sys.stderr)
        sys.exit(2)
