#!/usr/bin/env python3
"""Live mesh feed: poll GitHub for the ping-pong volley and write live-events.json.

Ping-pong = the PR/issue volley between seats (open, review, fix, re-Light, merge).
Also: muse-house Deployments (deploy/deploy_fail), a mymuse.house /health probe that emits on
state change (health_ok/health_fail), and X both ways from herald's JSONL ledger (--x-ledger) or,
as an interim hand log, an existing feed file (--merge-x). No X API calls; nothing is posted.

Output keeps the capture shape the mesh renderer already reads:
  {title, sources, repo, repos, seats, services, notes, generated_at, event_count,
   events: [{id, t_ct, from, to, kind, direction, label, source, src_file,
             repo?, number?, post_id?, handle?, in_reply_to?, note?, reported_by?}]}

Stdlib only (urllib; openssl CLI signs the App JWT). Auth, one of:
  - GitHub App (preferred for --watch): GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and
    GITHUB_APP_PRIVATE_KEY_PATH. The poller mints its own installation token, re-mints before
    it is 55 min old and on a 401, and ignores GITHUB_TOKEN/GH_TOKEN. No other fallback.
  - GITHUB_TOKEN or GH_TOKEN (any token that can read the repos; not refreshed).

  python3 fetch_feed.py --out feed/live-events.json              # one pass
  python3 fetch_feed.py --out feed/live-events.json --watch 120  # poll every 120s

Every pass rewrites live-events.json atomically (tmp + rename) and appends only the
events it had not seen before to live-events.jsonl (one JSON object per line), so a
watcher can either re-read the JSON or `tail -f` the JSONL stream.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import http.client
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CT = ZoneInfo("America/Chicago")
API = "https://api.github.com"
DEFAULT_REPOS = ["0xRayAI/muse-house", "0xRayAI/xray"]
SEATS = ["blinky", "mill", "forge", "critic", "herald", "minime0x"]
SERVICES = ["GitHub", "X", "mymuse.house"]

# GitHub login -> mesh node. Bots are the seats' App identities.
LOGIN_SEAT = {
    "forge0x1[bot]": "forge",
    "minime0x[bot]": "minime0x",
    "0xray-critic[bot]": "critic",
    "critic0x1[bot]": "critic",
    "herald0x1[bot]": "herald",
    "blinky0x1[bot]": "blinky",
    "htafolla": "Blaze0x1",
    "github-actions[bot]": "GitHub",
}
# Branch prefix names the seat that drove the PR when it rides another seat's App
# (mill ships through the forge0x1 App on mill/* branches).
BRANCH_SEAT = {"mill/": "mill", "forge/": "forge", "critic/": "critic",
               "herald/": "herald", "blinky/": "blinky", "minime/": "minime0x"}

# A verdict is "Light PASS/FAIL" (optionally "critic"/"Verify" before Light) or "critic PASS/FAIL",
# with at most a separator between the words. Verdict must be uppercase so prose like
# "critic Light gates every PR ... pass" does not count.
VERDICT_RE = re.compile(r"(?i:\b(?:(?:critic|verify)\s+)?light|\bcritic)\s*[:\-\u2014\u00b7]?\s*(PASS|FAIL)\b")
SUPERSEDE_RE = re.compile(r"\bsupersed(?:e|ed|es|ing)\b", re.I)
BANNED = ("Dist", "emergence", "compaction")  # never shown on the mesh


def log(msg: str) -> None:
    print(f"[live-mesh {datetime.now(CT):%H:%M:%S} CT] {msg}", file=sys.stderr, flush=True)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class MintError(RuntimeError):
    pass


class AuthExpired(Exception):
    """GitHub returned 401. Not an OSError, so a handler that catches a dropped
    connection cannot swallow it and then rewrite the feed as fresh."""


class AppToken:
    """GitHub App installation token: App JWT (RS256, signed by the openssl CLI) ->
    POST /app/installations/{id}/access_tokens. Installation tokens live 1h; re-mint at 55 min,
    or 5 min before expires_at if sooner. The token is never logged."""
    REMINT_AFTER = 55 * 60
    ENV = ("GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_PATH")

    def __init__(self, app_id: str, installation_id: str, key_path: str):
        self.app_id, self.installation_id, self.key_path = app_id, installation_id, key_path
        self.token: str | None = None
        self.minted_at = 0.0
        self.expires_at = 0.0

    @classmethod
    def from_env(cls) -> "AppToken | None":
        vals = [os.environ.get(k, "").strip() for k in cls.ENV]
        if not any(vals):
            return None
        if not all(vals):
            missing = [k for k, v in zip(cls.ENV, vals) if not v]
            raise SystemExit(f"App auth needs {', '.join(cls.ENV)}; missing {', '.join(missing)}")
        return cls(*vals)

    def stale(self, now: float | None = None) -> bool:
        # Wall clock (time.time), so a paused VM that jumps the clock re-mints.
        now = time.time() if now is None else now
        return (not self.token or now - self.minted_at >= self.REMINT_AFTER
                or bool(self.expires_at and self.expires_at - now < 300))

    def jwt(self) -> str:
        now = int(time.time())
        head = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
        body = b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": self.app_id}).encode())
        signing = f"{head}.{body}".encode()
        try:
            sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", self.key_path], input=signing,
                                 capture_output=True, check=True, timeout=30).stdout
        except (OSError, subprocess.SubprocessError) as e:
            raise MintError(f"JWT sign failed ({type(e).__name__})") from None
        return f"{head}.{body}.{b64url(sig)}"

    def mint(self) -> str:
        req = urllib.request.Request(
            f"{API}/app/installations/{self.installation_id}/access_tokens", data=b"", method="POST",
            headers={"Authorization": f"Bearer {self.jwt()}", "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "xray-live-mesh-feed"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raise MintError(f"access_tokens HTTP {e.code}") from None
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError) as e:
            raise MintError(f"access_tokens {type(e).__name__}") from None
        if not resp.get("token"):
            raise MintError("access_tokens response had no token")
        self.token, self.minted_at = resp["token"], time.time()
        exp = resp.get("expires_at")
        self.expires_at = datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() if exp else 0.0
        log(f"minted App installation token (expires {datetime.fromtimestamp(self.expires_at, CT):%H:%M} CT)"
            if exp else "minted App installation token")
        return self.token


class GitHub:
    def __init__(self, token: str | None, app: AppToken | None = None):
        self.token = token
        self.app = app
        self.calls = 0
        self.not_modified = 0   # conditional 304s (free against the rate limit when authenticated)
        self.etags: dict[str, tuple[str, object]] = {}

    def get_cached(self, path: str, params: dict | None = None):
        """GET with If-None-Match; a 304 returns the body cached from the last 200."""
        url = (path if path.startswith("http") else API + path) + (
            "?" + urllib.parse.urlencode(params) if params else "")
        hit = self.etags.get(url)
        try:
            data, etag = self.get(url, etag=hit[0] if hit else "")
        except urllib.error.HTTPError as e:
            if e.code == 304 and hit:
                self.not_modified += 1
                return hit[1]
            raise
        if etag:
            self.etags[url] = (etag, data)
        return data

    def get(self, path: str, params: dict | None = None, etag: str | None = None):
        url = path if path.startswith("http") else API + path
        if params:
            # urlencode so "+00:00" in since= becomes %2B00:00 (a raw "+" decodes to a space).
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        if self.app and self.app.stale():
            self.token = self.app.mint()
        try:
            return self._get(url, etag)
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            # A token younger than a minute, or a token this process cannot re-mint:
            # fail the request. Do not keep using the body-less error as a network blip.
            if not self.app or time.time() - self.app.minted_at < 60:
                raise AuthExpired("GitHub HTTP 401") from None
            log("GitHub HTTP 401; re-minting App token")
            self.token = self.app.mint()
            try:
                return self._get(url, etag)
            except urllib.error.HTTPError as again:
                if again.code == 401:
                    raise AuthExpired("GitHub HTTP 401") from None
                raise

    def _get(self, url: str, etag: str | None = None):
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "xray-live-mesh-feed",
            **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            **({"If-None-Match": etag} if etag else {}),   # etag "" = no condition, but return the ETag
        })
        self.calls += 1
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
            return (data, r.headers.get("ETag")) if etag is not None else data

    def pages(self, path: str, params: dict | None = None, limit: int = 5):
        params = dict(params or {}, per_page=100)
        for page in range(1, limit + 1):
            batch = self.get(path, dict(params, page=page))
            if not batch:
                return
            yield from batch
            if len(batch) < 100:
                return


def to_ct(iso: str) -> str:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(CT).isoformat()


def clean(text: str) -> str:
    for b in BANNED:
        text = text.replace(b, "…")
    return " ".join(text.split())


def seat_of(login: str | None, branch: str | None = None) -> str:
    if branch:
        for prefix, seat in BRANCH_SEAT.items():
            if branch.startswith(prefix):
                return seat
    return LOGIN_SEAT.get(login or "", "GitHub")


def short(repo: str) -> str:
    return repo.split("/", 1)[1]


def ev(eid, t, frm, to, kind, label, source, repo, number, note=None):
    e = {"id": eid, "t_ct": to_ct(t) if t.endswith("Z") else t, "from": frm, "to": to,
         "kind": kind, "direction": "internal", "label": clean(label)[:54], "source": source,
         "src_file": "github-api", "repo": repo}
    if number is not None:
        e["number"] = number
    if note:
        e["note"] = note
    return e


def verdict(body: str) -> str | None:
    m = VERDICT_RE.search(body or "")
    return m.group(1).upper() if m else None


def pr_events(gh: GitHub, repo: str, pr: dict, since: datetime) -> list[dict]:
    n, title = pr["number"], pr["title"]
    url, tag = pr["html_url"], f"{short(repo)} #{n}"
    author = seat_of(pr["user"]["login"], pr["head"]["ref"])
    out: list[dict] = []
    t_since = since.isoformat()
    head = pr.get("head") or {}
    base = (pr.get("base") or {}).get("ref")
    labels = [lb.get("name") for lb in (pr.get("labels") or []) if isinstance(lb, dict) and lb.get("name")]
    packet = _burst_cards().parse_packet(pr.get("body") or "")

    def add(event: dict, **more):
        hints = {"sha": head.get("sha"), "base": base, "title": title, "labels": labels}
        if packet:
            hints["packet"] = packet
        hints.update(more)
        kept = {key: val for key, val in hints.items() if val not in (None, "", [])}
        if kept:
            event["_inbox"] = kept
        out.append(event)
        return event

    def recent(t: str | None) -> bool:
        return bool(t) and datetime.fromisoformat(t.replace("Z", "+00:00")) >= since

    opened = recent(pr["created_at"])
    if opened:
        add(ev(f"{repo}#{n}:open", pr["created_at"], author, "GitHub", "pr_open",
                      f"{tag} opened · {title}", url, repo, n))
    # Pushes after open = fix / update volley.
    commits = list(gh.pages(f"/repos/{repo}/pulls/{n}/commits", limit=3))
    rep = REPRESENTED.setdefault(repo, set())
    rep.update(c["sha"] for c in commits)   # pr_open (first) + pr_update (rest) already show these
    if pr.get("merged_at") and pr.get("merge_commit_sha"):
        rep.add(pr["merge_commit_sha"])      # the merge/squash commit is the merged event
    for c in commits[1:]:
        t = c["commit"]["committer"]["date"]
        if recent(t) and t > pr["created_at"]:
            add(ev(f"{repo}#{n}:push:{c['sha'][:12]}", t, author, "GitHub", "pr_update",
                   f"{tag} update · {c['commit']['message'].splitlines()[0]}",
                   f"{url}/commits/{c['sha']}", repo, n), sha=c["sha"])
    # #287: the commit list above is capped (oldest first) and dated by committer time, so a new head on a
    # long or rebased PR can be missed. Queue one pr_update whenever head.sha differs from the last head seen;
    # the id matches the per-commit one, so the stream dedupe keeps it to one line per head.
    head_sha, key = head.get("sha"), f"{repo}#{n}"
    if head_sha and HEADS.get(key) != head_sha:
        shown = {e["id"] for e in out}
        hid = f"{repo}#{n}:push:{head_sha[:12]}"
        t = pr.get("updated_at") or ""
        if hid not in shown and not (opened and len(commits) <= 1) and recent(t) and t > pr["created_at"]:
            add(ev(hid, t, author, "GitHub", "pr_update", f"{tag} update · new head {head_sha[:7]}",
                   f"{url}/commits/{head_sha}", repo, n), sha=head_sha)
        HEADS[key] = head_sha
        rep.add(head_sha)
    # Reviews: critic App reviews or any review whose body carries a Light verdict.
    for r in gh.pages(f"/repos/{repo}/pulls/{n}/reviews", limit=2):
        t = r.get("submitted_at")
        if not recent(t):
            continue
        who = seat_of(r["user"]["login"])
        v = verdict(r.get("body") or "") or {"APPROVED": "PASS", "CHANGES_REQUESTED": "FAIL"}.get(r["state"])
        if who == "critic" and v:
            add(ev(f"{repo}#{n}:review:{r['id']}", t, "critic", author, f"critic_{v.lower()}",
                   f"critic {v} · {tag}", r["html_url"], repo, n))
        else:
            add(ev(f"{repo}#{n}:review:{r['id']}", t, who, author, "review",
                   f"{who} review {r['state'].lower()} · {tag}", r["html_url"], repo, n))
    # Issue comments: critic Light notes, supersede notes, other seat chatter on the PR.
    for c in gh.pages(f"/repos/{repo}/issues/{n}/comments", {"since": t_since}, limit=2):
        out.extend(comment_events(repo, n, tag, author, c))
    # Check runs on head: any critic App run is a Light verdict. Only the "CI Summary" roll-up
    # becomes ci_*, on purpose: one CI event per head instead of one per job.
    try:
        runs = gh.get(f"/repos/{repo}/commits/{pr['head']['sha']}/check-runs", {"per_page": 100})
    except AuthExpired:
        raise
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise AuthExpired("GitHub HTTP 401") from None
        runs = {"check_runs": []}
        # Fine-grained host tokens have no Checks permission (403). Derive the
        # same working signal from Actions runs/jobs and commit statuses.
        if e.code == 403:
            for noted in _host_ci_notes(gh, repo, pr["head"]["sha"], author, pr.get("merged_at")):
                CHECK_NOTES.append(noted)
    for cr in runs.get("check_runs", []):
        noted = _burst_working().note_check(
            author, pr.get("merged_at"), cr.get("status"), cr.get("conclusion"),
            cr.get("started_at"), cr.get("completed_at"))
        if noted:
            CHECK_NOTES.append(noted)
        t, concl = cr.get("completed_at"), cr.get("conclusion")
        if not recent(t) or concl not in ("success", "failure"):
            continue
        slug = (cr.get("app") or {}).get("slug", "")
        v = "PASS" if concl == "success" else "FAIL"
        if "critic" in slug or "critic" in cr["name"].lower():
            add(ev(f"{repo}#{n}:check:{cr['id']}", t, "critic", author, f"critic_{v.lower()}",
                   f"critic {v} · {tag}", cr["html_url"], repo, n))
        elif cr["name"] == "CI Summary":
            add(ev(f"{repo}#{n}:ci:{cr['id']}", t, "GitHub", author, f"ci_{v.lower()}",
                   f"CI {v.lower()} · {tag}", cr["html_url"], repo, n),
                conclusion="success" if v == "PASS" else "failure", name=cr["name"])
    if pr.get("merged_at") and recent(pr["merged_at"]):
        merger = seat_of((pr.get("merged_by") or {}).get("login")) if pr.get("merged_by") else "forge"
        if merger == "GitHub":
            merger = "forge"
        add(ev(f"{repo}#{n}:merged", pr["merged_at"], merger, "GitHub", "merged",
               f"merged {tag} · {title}", url, repo, n), sha=pr.get("merge_commit_sha") or head.get("sha"))
    elif pr.get("closed_at") and recent(pr["closed_at"]):
        add(ev(f"{repo}#{n}:closed", pr["closed_at"], author, "GitHub", "pr_close",
               f"closed {tag} unmerged", url, repo, n))
    return out


def _carry_text(events: list[dict], text: str) -> list[dict]:
    """Keep comment text on a private hint. write() strips it before the feed file."""
    if not text:
        return events
    for event in events:
        hints = dict(event.get("_inbox") or {})
        hints["text"] = text
        event["_inbox"] = hints
    return events


def comment_events(repo: str, n: int, tag: str, author: str, c: dict) -> list[dict]:
    who = seat_of(c["user"]["login"])
    body = c.get("body") or ""
    v = verdict(body)
    eid = f"{repo}#{n}:comment:{c['id']}"
    if who == "critic" and v:
        return _carry_text([ev(eid, c["created_at"], "critic", author, f"critic_{v.lower()}",
                               f"critic {v} · {tag}", c["html_url"], repo, n)], body)
    out = []
    if v:
        # A seat comment that states a Light verdict (e.g. forge: "Superseded ... after Light FAIL").
        # The verdict is real but reported second-hand; the time is when it was reported.
        r = ev(f"{eid}:light", c["created_at"], "critic", author, f"critic_{v.lower()}",
               f"Light {v} (via {who}) · {tag}", c["html_url"], repo, n,
               note=f"reported in {who} comment; Light time <= this time")
        r["reported_by"] = who
        out.append(r)
    if SUPERSEDE_RE.search(body):
        out.append(ev(eid, c["created_at"], who, "GitHub", "supersede",
                      f"{who} supersede note · {tag}", c["html_url"], repo, n))
    elif not v:
        out.append(ev(eid, c["created_at"], who, author if author != who else "GitHub", "comment",
                      f"{who} comment · {tag}", c["html_url"], repo, n))
    return _carry_text(out, body)


def issue_events(gh: GitHub, repo: str, since: datetime) -> list[dict]:
    out = []
    for i in gh.pages(f"/repos/{repo}/issues", {"state": "all", "since": since.isoformat(),
                                                 "sort": "updated", "direction": "desc"}, limit=2):
        if "pull_request" in i:
            continue
        n, tag = i["number"], f"{short(repo)} issue #{i['number']}"
        who = seat_of(i["user"]["login"])
        created = datetime.fromisoformat(i["created_at"].replace("Z", "+00:00"))
        labels = [lb.get("name") for lb in (i.get("labels") or []) if isinstance(lb, dict) and lb.get("name")]
        if created >= since:
            opened = ev(f"{repo}!{n}:open", i["created_at"], who, "GitHub", "issue_open",
                        f"{tag} opened · {i['title']}", i["html_url"], repo, n)
            hints = {"title": i.get("title") or "", "labels": labels, "text": i.get("body") or ""}
            packet = _burst_cards().parse_packet(i.get("body") or "")
            if packet:
                hints["packet"] = packet
            opened["_inbox"] = hints
            out.append(opened)
        if i.get("closed_at") and datetime.fromisoformat(i["closed_at"].replace("Z", "+00:00")) >= since:
            out.append(ev(f"{repo}!{n}:closed", i["closed_at"], who, "GitHub", "issue_close",
                          f"{tag} closed", i["html_url"], repo, n))
        if i.get("comments"):
            for c in gh.pages(f"/repos/{repo}/issues/{n}/comments", {"since": since.isoformat()}, limit=1):
                for e in comment_events(repo, n, tag, who, c):
                    e["id"] = e["id"].replace("#", "!", 1)
                    out.append(e)
    return out


def light_note_events(path: Path, since: datetime) -> list[dict]:
    """In-room critic Lights that never touch GitHub, recorded one JSON object per line:
    {"t": ISO time, "repo": "0xRayAI/xray", "number": 214, "verdict": "PASS"|"FAIL",
     "to": "mill", "note": "..."}"""
    out = []
    if not path.exists():
        return out
    for k, line in enumerate(path.read_text().splitlines()):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rec = json.loads(line)
        t = datetime.fromisoformat(rec["t"].replace("Z", "+00:00"))
        if t < since:
            continue
        v = rec["verdict"].upper()
        repo, n = rec["repo"], int(rec["number"])
        e = ev(f"{repo}#{n}:light:{t.isoformat()}", t.astimezone(CT).isoformat(), "critic",
               rec.get("to", "mill"), f"critic_{v.lower()}", f"critic {v} · {short(repo)} #{n}",
               f"https://github.com/{repo}/pull/{n}", repo, n, note=rec.get("note") or "in-room Light")
        e["src_file"] = "light-notes.jsonl"
        out.append(e)
    return out


# ---------------------------------------------------------------- kinds, direction, order

ENG_KINDS = ["pr_open", "pr_update", "supersede", "critic_fail", "critic_pass", "ci_pass", "ci_fail",
             "review", "comment", "merged", "pr_close", "issue_open", "issue_close"]
SITE_KINDS = ["deploy", "deploy_fail", "health_ok", "health_fail"]
X_IN = ["x_in_mention", "x_in_reply"]
X_OUT = ["x_out_reply", "x_out_root", "x_like"]
PUSH_KINDS = ["push", "feed_push"]
KINDS = ENG_KINDS + SITE_KINDS + X_IN + X_OUT + PUSH_KINDS
LEGACY = {"fix": "pr_update", "probe": "health_ok", "x_root": "x_out_root"}
# Ties at the same instant: cause before effect.
_RANK_ORDER = [["push"], ["pr_open"], ["pr_update"], ["ci_pass", "ci_fail"], ["critic_pass", "critic_fail"],
               ["supersede"], ["review", "comment"], ["merged"], ["pr_close"], ["issue_open"], ["issue_close"],
               ["deploy", "deploy_fail"], ["health_ok", "health_fail"], X_IN, ["x_out_reply", "x_out_root"],
               ["x_like"], ["feed_push"]]
KIND_RANK = {k: i for i, ks in enumerate(_RANK_ORDER) for k in ks}
# Dedupe precedence when two sources give the same id (lower wins).
SRC_RANK = {"github-api": 0, "github-deployments": 0, "x-api": 0, "health-probe": 0,
            "x-ledger.jsonl": 1, "light-notes.jsonl": 2, "feed-pushes.jsonl": 1,
            "box-events.jsonl": 1}
MERGE_X_RANK = 3
HERALD_HANDLES = {"0xRayAI", "herald"}


def normalize_kind(kind: str, frm: str = "") -> str:
    """Legacy kinds are accepted on read and written in canonical form."""
    if kind == "x_reply":
        return "x_out_reply" if frm in HERALD_HANDLES else "x_in_reply"
    return LEGACY.get(kind, kind)


def direction_of(kind: str) -> str:
    if kind in X_IN:
        return "in"
    if kind in X_OUT:
        return "out"
    return "internal"


def instant(t_ct: str) -> datetime:
    return datetime.fromisoformat(t_ct.replace("Z", "+00:00")).astimezone(timezone.utc)


def order_key(e: dict):
    return (instant(e["t_ct"]), KIND_RANK.get(e["kind"], 99), e["id"])


def src_rank(e: dict) -> int:
    return SRC_RANK.get(e.get("src_file", ""), MERGE_X_RANK)


# ---------------------------------------------------------------- site: deployments + /health

DEPLOY_CACHE: dict = {}  # deployment id -> event (terminal states only)


def deploy_events(gh: GitHub, repo: str, since: datetime) -> list[dict]:
    """GitHub Deployments (Railway posts them) -> deploy / deploy_fail on a terminal status."""
    out = []
    for d in gh.pages(f"/repos/{repo}/deployments", limit=2):
        if datetime.fromisoformat(d["created_at"].replace("Z", "+00:00")) < since:
            break  # newest first
        if d["id"] in DEPLOY_CACHE:
            out.append(DEPLOY_CACHE[d["id"]])
            continue
        statuses = gh.get(f"/repos/{repo}/deployments/{d['id']}/statuses", {"per_page": 30})
        final = next((s for s in statuses if s["state"] in ("success", "failure", "error")), None)
        if not final:
            continue  # queued / in_progress: picked up on a later pass
        ok = final["state"] == "success"
        sha7 = d["sha"][:7]
        e = ev(f"{repo}:deploy:{d['id']}", final["created_at"], "GitHub", "mymuse.house",
               "deploy" if ok else "deploy_fail",
               f"deploy · {short(repo)} {sha7}" if ok else f"deploy FAIL · {short(repo)} {sha7}",
               final.get("target_url") or final.get("environment_url") or d["url"], repo, None,
               note=f"env {d.get('environment')}; sha {d['sha'][:8]}")
        e["src_file"] = "github-deployments"
        env_name = str(d.get("environment") or "")
        e["_inbox"] = {"sha": d.get("sha") or "", "title": e["label"], "name": env_name,
                       "hold": "hold" in env_name.casefold()}
        DEPLOY_CACHE[d["id"]] = e
        out.append(e)
    return out


def probe(url: str) -> tuple[bool, str]:
    """HTTP status code only. The response body is not a signal and is not read."""
    req = urllib.request.Request(url, headers={"User-Agent": "xray-live-mesh-feed"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            code = r.getcode()
            return (code == 200, str(code))
    except urllib.error.HTTPError as e:
        return False, str(e.code)
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):
        return False, "unreachable"


def health_events(args, state_path: Path, deploys: list[dict], since: datetime) -> list[dict]:
    """Probe /health; emit only on a state change, or the first ok after a newer deploy.
    Emitted events live in health-state.json so later passes keep them in the window."""
    st = json.loads(state_path.read_text()) if state_path.exists() else {"events": []}
    now = time.time()
    due = now - st.get("last_probe_unix", 0) >= args.health_every or st.get("url") != args.health
    if due:
        ok, code = probe(args.health)
        state = "ok" if ok else "fail"
        last_t = st.get("last_emit_t")
        newest_deploy = max((instant(d["t_ct"]) for d in deploys if d["kind"] == "deploy"), default=None)
        after_deploy = ok and newest_deploy and (not last_t or newest_deploy > instant(last_t))
        if state != st.get("state") or st.get("url") != args.health or after_deploy:
            t = datetime.now(CT).replace(microsecond=0)
            e = {"id": f"health:{state}:{t.strftime('%Y-%m-%dT%H:%M')}", "t_ct": t.isoformat(),
                 "from": "mymuse.house", "to": "blinky", "kind": f"health_{state}",
                 "direction": "internal", "label": "/health ok" if ok else f"/health FAIL {code}",
                 "source": args.health, "src_file": "health-probe"}
            st["events"].append(e)
            st["last_emit_t"] = e["t_ct"]
        st.update(state=state, url=args.health, last_probe_unix=now,
                  last_probe_t=datetime.now(CT).replace(microsecond=0).isoformat())
        state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=2) + "\n")
        os.replace(tmp, state_path)
    return [e for e in st["events"] if instant(e["t_ct"]) >= since]


# ---------------------------------------------------------------- X: ledger + merge-x

def x_label(kind: str, handle: str, tag: str | None) -> str:
    sfx = f" · {tag}" if tag else ""
    return {"x_in_mention": f"IN @{handle} · mention", "x_in_reply": f"IN @{handle} · reply in",
            "x_out_reply": f"HERALD reply on X{sfx}", "x_out_root": f"HERALD root{sfx}",
            "x_like": f"LIKE @{handle}{sfx}"}[kind]


def x_id(kind: str, post_id: str) -> str:
    return f"x:like:{post_id}" if kind == "x_like" else f"x:{post_id}:{kind}"


def handle_from_url(url: str) -> str | None:
    m = re.search(r"x\.com/([^/]+)/status/", url or "")
    return m.group(1) if m else None


def x_nodes(kind: str, handle: str) -> tuple[str, str]:
    if kind in X_IN:
        return (handle if handle not in HERALD_HANDLES else "X"), "herald"
    return "herald", "X"


def ledger_events(path: Path, since: datetime) -> list[dict]:
    """herald appends one line per X action: {"t","kind","post_id","handle","in_reply_to"?,"url","tag"?,"note"?}.
    Inbound handle = author; outbound = 0xRayAI; likes = author of the liked post."""
    out = []
    if not path.exists():
        return out
    for k, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            rec = json.loads(line)
            t = datetime.fromisoformat(rec["t"].replace("Z", "+00:00"))
            handle = str(rec["handle"]).lstrip("@")
            kind = normalize_kind(rec["kind"], handle)
            post_id = str(rec["post_id"])
        except (ValueError, KeyError) as err:
            log(f"{path.name}:{k} skipped ({err})")
            continue
        if kind not in X_IN + X_OUT:
            log(f"{path.name}:{k} skipped (kind {kind})")
            continue
        if t < since:
            continue
        frm, to = x_nodes(kind, handle)
        url = rec.get("url") or (f"https://x.com/0xRayAI/status/{post_id}" if kind in ("x_out_reply", "x_out_root")
                                 else f"https://x.com/{handle}/status/{post_id}")
        e = {"id": x_id(kind, post_id), "t_ct": t.astimezone(CT).isoformat(), "from": frm, "to": to,
             "kind": kind, "direction": direction_of(kind),
             "label": clean(x_label(kind, handle, rec.get("tag")))[:54], "source": url,
             "src_file": "x-ledger.jsonl", "post_id": post_id, "handle": handle}
        if rec.get("in_reply_to"):
            e["in_reply_to"] = str(rec["in_reply_to"])
        if rec.get("note"):
            e["note"] = rec["note"]
        out.append(e)
    return out


def x_events(path: Path, since: datetime) -> list[dict]:
    """Interim X input: copy x_* events from a hand-built feed (e.g. herald v2) and normalize
    legacy kinds. This is a hand log, not a live X read."""
    if not path.exists():
        return []
    out = []
    for e in json.loads(path.read_text()).get("events", []):
        if not str(e.get("kind", "")).startswith("x_"):
            continue
        if instant(e["t_ct"]) < since:
            continue
        e = dict(e)
        e["kind"] = normalize_kind(e["kind"], e.get("from", ""))
        post_id = e.get("post_id") or (re.search(r"/status/(\d+)", e.get("source", "")) or [None, None])[1]
        if post_id:
            e["post_id"] = str(post_id)
        handle = handle_from_url(e.get("source", ""))
        if e["kind"] in X_IN:
            e["from"] = e.get("from") if e.get("from") not in (None, "X") else (handle or "X")
            e["to"] = "herald"
        else:
            e["from"], e["to"] = "herald", "X"
        if handle:
            e.setdefault("handle", handle)
        e["direction"] = direction_of(e["kind"])
        e["label"] = clean(e.get("label", x_label(e["kind"], handle or "?", None)))[:54]
        e.setdefault("id", x_id(e["kind"], e["post_id"]) if post_id else f"x:{e['t_ct']}:{e['kind']}")
        e["src_file"] = path.name
        out.append(e)
    return out


PR_CACHE: dict = {}  # (repo, number) -> (signature, fetched_at, events); watch mode only
CHECK_NOTES: list = []  # busy/fail checks this pass; one time per seat is derived later
BRANCH_TIPS: dict = {}  # (repo, branch) -> tip sha; first sight is a baseline, not an event
TIP_EVENTS: dict = {}  # (repo, sha) -> tip push event; kept so the packet stays in the window
PUSHED_HEADS: dict[str, set[str]] = {}  # repo -> heads already shown by push_events or a tip event

# ---------------------------------------------------------------- pushes

HEADS: dict[str, str] = {}  # "repo#n" -> last PR head.sha seen this process (#287)
REPRESENTED: dict[str, set[str]] = {}  # repo -> commit SHAs already shown by pr_open/pr_update/merged
PUSH_MSG: dict[tuple[str, str], str] = {}  # (repo, sha) -> first line of the commit message
# The tripwire's replay branch never becomes a push event: its pushes come in as feed_push from
# the tripwire's own ledger, and a push event for it would change the feed and trip another push.
PUSH_SKIP_BRANCHES = {"live-wire"}


def push_events(gh: GitHub, repo: str, since: datetime) -> list[dict]:
    """Fleet pushes from the repo events feed (one conditional call per pass; a 304 costs nothing
    against the rate limit). One event per push, skipped when its head is already on the mesh as a
    PR open/update/merge, so a merge never counts twice."""
    out = []
    rep = REPRESENTED.get(repo, set())
    for e in gh.get_cached(f"/repos/{repo}/events", {"per_page": 100}) or []:
        if e.get("type") != "PushEvent":
            continue
        t = e["created_at"]
        if datetime.fromisoformat(t.replace("Z", "+00:00")) < since:
            continue
        p = e.get("payload") or {}
        ref = p.get("ref") or ""
        branch = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ""
        head = p.get("head") or ""
        seat = seat_of((e.get("actor") or {}).get("login"), branch)
        if not branch or branch in PUSH_SKIP_BRANCHES or not head or seat not in SEATS:
            continue
        if head in rep or (repo, head) in TIP_EVENTS:
            continue
        PUSHED_HEADS.setdefault(repo, set()).add(head)
        commits = p.get("commits") or []
        msg = next((c.get("message") for c in commits if c.get("sha") == head), None) or \
            (commits[-1].get("message") if commits else None)
        if msg is None:
            if (repo, head) not in PUSH_MSG:
                PUSH_MSG[(repo, head)] = gh.get(f"/repos/{repo}/commits/{head}")["commit"]["message"]
            msg = PUSH_MSG[(repo, head)]
        msg = (msg or "").splitlines()[0] if msg else ""
        out.append(ev(f"{repo}:push:{e['id']}", t, seat, "GitHub", "push",
                      f"pushed {short(repo)} {branch} · {msg}", f"https://github.com/{repo}/commit/{head}",
                      repo, None, note=f"{branch} {head[:8]}"))
    return out


def feed_push_events(path: Path, since: datetime) -> list[dict]:
    """Real live-wire pushes, recorded by tripwire_push.py one JSON event per line after each push.
    The tripwire ignores feed_push events when deciding to push, so folding these in never loops."""
    out = []
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rec = json.loads(line)
        if rec.get("kind") != "feed_push" or instant(rec["t_ct"]) < since:
            continue
        rec["src_file"] = "feed-pushes.jsonl"
        out.append(rec)
    return out


def box_events(path: Path, since: datetime) -> list[dict]:
    """Local signals the box pushed. One JSON event per line. Merged by id on the next pass."""
    out = []
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict) or not rec.get("id") or not rec.get("t_ct"):
            continue
        if instant(rec["t_ct"]) < since:
            continue
        rec["src_file"] = "box-events.jsonl"
        out.append(rec)
    return out


def next_cursor(out: Path) -> str:
    """epoch.seq for this feed file. The epoch is created once. seq increments every write."""
    epoch_path = out.parent / "burst-epoch"
    seq_path = out.parent / "burst-seq"
    if not epoch_path.exists():
        epoch_path.write_text(secrets.token_hex(4), encoding="utf-8")
    epoch = epoch_path.read_text(encoding="utf-8").strip()
    seq = 0
    if seq_path.exists():
        try:
            seq = int(seq_path.read_text(encoding="utf-8").strip() or "0")
        except ValueError:
            seq = 0
    seq += 1
    seq_path.write_text(str(seq), encoding="utf-8")
    return f"{epoch}.{seq}"


def merge(events: list[dict]) -> list[dict]:
    """Dedupe by id keeping the higher-precedence source; fill optional fields the winner lacks."""
    best: dict[str, dict] = {}
    for e in events:
        e["kind"] = normalize_kind(e["kind"], e.get("from", ""))
        e.setdefault("direction", direction_of(e["kind"]))
        cur = best.get(e["id"])
        if cur is None:
            best[e["id"]] = e
            continue
        win, lose = (e, cur) if src_rank(e) < src_rank(cur) else (cur, e)
        for k, v in lose.items():
            win.setdefault(k, v)
        best[e["id"]] = win
    return sorted(best.values(), key=order_key)


def _burst_cards():
    name = "burst_cards"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parents[1] / "burst" / "cards.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _burst_inbox():
    name = "burst_inbox"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parents[1] / "burst" / "inbox.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _burst_working():
    name = "burst_working"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parents[1] / "burst" / "working.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _host_ci_notes(gh: GitHub, repo: str, sha: str, author: str, merged_at):
    """Actions runs, their jobs, and commit statuses. A 401 still fails the pass."""
    def grab(path, params=None):
        try:
            return gh.get(path, params)
        except AuthExpired:
            raise
        except urllib.error.HTTPError as err:
            if err.code == 401:
                raise AuthExpired("GitHub HTTP 401") from None
            return {}

    runs = grab(f"/repos/{repo}/actions/runs", {"head_sha": sha, "per_page": 20}) or {}
    status = grab(f"/repos/{repo}/commits/{sha}/status") or {}
    jobs = []
    for run in (runs.get("workflow_runs") or [])[:5]:
        run_id = run.get("id")
        if not run_id:
            continue
        got = grab(f"/repos/{repo}/actions/runs/{run_id}/jobs", {"per_page": 20}) or {}
        jobs.extend(got.get("jobs") or [])
    return _burst_working().notes_from_host_ci(
        author, merged_at, runs.get("workflow_runs"), jobs, status)


def _supervise():
    name = "burst_supervise"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parents[1] / "burst" / "supervise.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def token_wall_expired(now: float | None = None) -> bool:
    """True when BURST_TOKEN_MINTED is older than the wall-clock re-mint limit, or is not a number."""
    raw = os.environ.get("BURST_TOKEN_MINTED", "").strip()
    if not raw:
        return False
    now = time.time() if now is None else now
    try:
        minted = float(raw)
    except ValueError:
        log("BURST_TOKEN_MINTED is not a unix wall time")
        return True
    if _supervise().remint_due(minted, now):
        log("token age reached on the wall clock")
        return True
    return False


def branch_tip_events(gh: GitHub, repo: str, since: datetime) -> list[dict]:
    """New branch tips this pass. Any branch except live-wire. The commit message is not stored.

    The first time a branch is seen it is a baseline, so a restart does not replay every tip.
    A later tip change is a push, including on a branch that is not main or develop.
    """
    out = []
    branches = gh.get_cached(f"/repos/{repo}/branches", {"per_page": 100}) or []
    for b in branches:
        name = b.get("name") or ""
        sha = ((b.get("commit") or {}).get("sha")) or ""
        if not name or not sha or name in PUSH_SKIP_BRANCHES:
            continue
        key = (repo, name)
        prev = BRANCH_TIPS.get(key)
        BRANCH_TIPS[key] = sha
        if prev is None or prev == sha or sha in REPRESENTED.get(repo, set()) \
                or sha in PUSHED_HEADS.get(repo, set()) or (repo, sha) in TIP_EVENTS:
            continue
        commit = gh.get(f"/repos/{repo}/commits/{sha}")
        cmt = commit.get("commit") or {}
        when = (cmt.get("committer") or {}).get("date") or ""
        if not when:
            continue
        t = datetime.fromisoformat(when.replace("Z", "+00:00"))
        if t < since:
            continue
        login = ((commit.get("author") or {}).get("login"))
        seat = seat_of(login, name)
        if seat not in SEATS:  # fleet-only, same rule as push_events (#236)
            continue
        out.append(ev(
            f"{repo}:tip:{name}:{sha[:10]}", when, seat, "GitHub", "push",
            f"pushed {short(repo)} {name} · {sha[:7]}",
            f"https://github.com/{repo}/commit/{sha}", repo, None,
            note=f"{name} {sha[:8]}",
        ))
        TIP_EVENTS[(repo, sha)] = out[-1]
        PUSHED_HEADS.setdefault(repo, set()).add(sha)
    # A tip is seen once; re-emit it each pass while it is inside the window, or it would vanish
    # from the next rebuilt feed. A head the events feed already showed is not a second packet.
    fresh = {id(e) for e in out}
    for (r, _sha), e in TIP_EVENTS.items():
        if r == repo and id(e) not in fresh and instant(e["t_ct"]) >= since:
            out.append(e)
    return out


def _seats_config():
    path = os.environ.get("BURST_SEATS", "").strip()
    if not path or not Path(path).is_file():
        return {}
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log(f"BURST_SEATS not read ({type(exc).__name__})")
        return {}


def _jsonl_lines(path):
    if not path or not Path(path).is_file():
        return []
    try:
        return _burst_working().read_jsonl(path)
    except OSError as exc:
        log(f"{Path(path).name} not read ({type(exc).__name__})")
        return []


def _working_map(now: float) -> tuple:
    mod = _burst_working()
    until = mod.check_working(list(CHECK_NOTES), now)
    CHECK_NOTES.clear()
    labs_path = os.environ.get("BURST_LABS", "").strip()
    if labs_path:
        try:
            labs = json.loads(Path(labs_path).read_text())
            for seat, ts in mod.WATCH.scan(labs, now).items():
                until[seat] = max(until.get(seat, 0), ts)
        except (OSError, ValueError) as exc:
            log(f"BURST_LABS not read ({type(exc).__name__})")
    aliases = mod.alias_map(_seats_config())
    prompts = _jsonl_lines(os.environ.get("BURST_PROMPTS", "fleet/prompts.jsonl").strip())
    pulses = mod.prompt_pulses(prompts, aliases, now)
    for seat, ts in mod.prompt_working(pulses, now).items():
        until[seat] = max(until.get(seat, 0), ts)
    activity_path = os.environ.get("BURST_ACTIVITY", "fleet/activity.jsonl").strip()
    activity_lines = _jsonl_lines(activity_path)
    box = None
    if activity_path and Path(activity_path).is_file():
        box = mod.activity_working(activity_lines, now, aliases=aliases)
        for seat, ts in box.items():
            until[seat] = max(until.get(seat, 0), ts)
    missing = mod.missing_activity(pulses, activity_lines, aliases, now)
    iso = {seat: datetime.fromtimestamp(ts, CT).isoformat() for seat, ts in until.items()}
    box_iso = None if box is None else {
        seat: datetime.fromtimestamp(ts, CT).isoformat() for seat, ts in box.items()}
    return iso, box_iso, missing


def build(args, gh: GitHub) -> dict:
    CHECK_NOTES.clear()
    since = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    if args.since:
        since = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
        if since.tzinfo is None:
            since = since.replace(tzinfo=CT)
    events: list[dict] = []
    for repo in args.repos:
        for pr in gh.pages(f"/repos/{repo}/pulls", {"state": "all", "sort": "updated",
                                                    "direction": "desc"}, limit=3):
            if datetime.fromisoformat(pr["updated_at"].replace("Z", "+00:00")) < since:
                break
            key = (repo, pr["number"])
            sig = (pr["updated_at"], pr["head"]["sha"], since.isoformat()[:13])
            hit = PR_CACHE.get(key)
            # Closed PRs are stable; open PRs are re-read at least every 10 min for CI/check runs.
            if hit and hit[0] == sig and (pr["state"] == "closed" or time.time() - hit[1] < 600):
                events.extend(hit[2])
                continue
            got = pr_events(gh, repo, pr, since)
            PR_CACHE[key] = (sig, time.time(), got)
            events.extend(got)
        if not args.no_issues:
            events.extend(issue_events(gh, repo, since))
        if not args.no_pushes:
            events.extend(push_events(gh, repo, since))
            events.extend(branch_tip_events(gh, repo, since))
    deploys: list[dict] = []
    if args.deploy_repo:
        deploys = deploy_events(gh, args.deploy_repo, since)
        events.extend(deploys)
    if args.health:
        events.extend(health_events(args, Path(args.health_state), deploys, since))
    # allow --deploy-repo '' / --health '' to disable
    events.extend(light_note_events(Path(args.light_notes), since))
    events.extend(feed_push_events(Path(args.feed_pushes), since))
    box_path = getattr(args, "box_events", None)
    if box_path:
        events.extend(box_events(Path(box_path), since))
    x_ledger = ledger_events(Path(args.x_ledger), since)
    events.extend(x_ledger)
    x_merged = x_events(Path(args.merge_x), since) if args.merge_x else []
    events.extend(x_merged)
    uniq = merge(events)
    kinds = sorted({e["kind"] for e in uniq})
    x_note = ("X events: none in window." if not (x_ledger or x_merged) else
              "X events: " + ", ".join(filter(None, [
                  f"{len(x_ledger)} from x-ledger.jsonl (herald's machine ledger)" if x_ledger else "",
                  f"{len(x_merged)} from {Path(args.merge_x).name} via --merge-x (hand log, not a live X read)"
                  if x_merged else ""])) + ".")
    feed = {
        "title": "muse / 0xRay ping-pong live events",
        # Local inputs are recorded by file name only (no box paths in a committed feed).
        "sources": [f"https://github.com/{r}" for r in args.repos]
                   + ([f"https://github.com/{args.deploy_repo}/deployments"] if args.deploy_repo else [])
                   + ([args.health] if args.health else [])
                   + [Path(args.light_notes).name, Path(args.x_ledger).name]
                   + ([Path(args.merge_x).name] if args.merge_x else []),
        "repo": args.repos[0],
        "repos": args.repos,
        "seats": SEATS,
        "services": SERVICES,
        "notes": [
            "Generated by house/live-mesh/fetch_feed.py: GitHub REST (PRs, issues, deployments), "
            "a /health probe, and JSONL ledgers. No markdown is read.",
            f"Window: events at or after {since.astimezone(CT).isoformat()}.",
            "critic_* events come from: critic App reviews/check runs, critic comments with Light PASS/FAIL, "
            "light-notes.jsonl (in-room Lights), or a seat comment that states a Light verdict "
            "(reported_by set; time = when reported).",
            "PR author seat: mill/* branch -> mill even when the PR rides the forge0x1 App.",
            "/health events are emitted on a state change (or first ok after a deploy) at probe time.",
            x_note,
            "Order: (UTC instant, kind rank, id). Same id from two sources: "
            "API > x-ledger > light-notes > --merge-x.",
        ],
        "generated_at": datetime.now(CT).isoformat(),
        "kinds": kinds,
        "event_count": len(uniq),
        "events": uniq,
    }
    working, box, missing = _working_map(time.time())
    feed["working"] = working
    feed["fleet"] = {"missing_activity": missing}
    if box is not None:
        feed["working_box"] = box
    return feed


def _keep_box_working(feed: dict, out: Path) -> None:
    """A host rewrite keeps box lights this pass did not recompute, until their cap."""
    if "working_box" in feed:
        return
    if not out.exists():
        return
    try:
        old = json.loads(out.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    now = time.time()
    kept = {}
    for seat, iso in (old.get("working_box") or {}).items():
        try:
            ts = datetime.fromisoformat(str(iso)).timestamp()
        except (TypeError, ValueError):
            continue
        if ts > now:
            kept[seat] = iso
    if not kept:
        return
    feed["working_box"] = kept
    working = dict(feed.get("working") or {})
    for seat, iso in kept.items():
        working.setdefault(seat, iso)
    feed["working"] = working


def _scrub_private(feed: dict) -> None:
    """Drop routing hints before the feed is written. Bodies never land in the file."""
    for event in feed.get("events") or []:
        if isinstance(event, dict):
            event.pop("_inbox", None)


def _keep_public(feed: dict, out: Path) -> None:
    """Keep a previous public:true when this write omits the flag. Never invent true."""
    if "public" in feed:
        return
    try:
        old = json.loads(out.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        return
    if isinstance(old, dict) and old.get("public") is True:
        feed["public"] = True


def write(feed: dict, out: Path) -> int:
    _keep_public(feed, out)
    _keep_box_working(feed, out)
    feed["cursor"] = next_cursor(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    stream = out.with_suffix(".jsonl")
    old_ids: set[str] = set()
    if stream.exists():
        for line in stream.read_text().splitlines():
            if line.strip():
                old_ids.add(json.loads(line).get("id", ""))
    new = [e for e in feed["events"] if e["id"] not in old_ids]
    try:
        routed = _burst_inbox()
        routed.deliver(new, feed.get("events") or [])
        routed.maybe_waveboard(len(new), log=log)
    except Exception as exc:
        log(f"inbox route skipped ({type(exc).__name__})")
    try:
        _burst_cards().publish(feed, out.parent, log=log)
    except Exception as exc:
        log(f"waveboard skipped ({type(exc).__name__})")
    finally:
        _scrub_private(feed)
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(feed, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, out)
    if new:
        with stream.open("a") as f:
            for e in new:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
    return len(new)


def main() -> int:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default=str(here / "feed" / "live-events.json"))
    p.add_argument("--repos", nargs="+", default=DEFAULT_REPOS)
    p.add_argument("--hours", type=float, default=48.0, help="lookback window (default 48h)")
    p.add_argument("--since", help="ISO start time; overrides --hours (naive = CT)")
    p.add_argument("--light-notes", help="in-room critic Lights JSONL (default: <out dir>/light-notes.jsonl)")
    p.add_argument("--x-ledger", help="herald X ledger JSONL (default: <out dir>/x-ledger.jsonl)")
    p.add_argument("--merge-x", help="interim: copy + normalize x_* events from a hand-built feed JSON")
    p.add_argument("--deploy-repo", default="0xRayAI/muse-house", help="repo whose Deployments map to deploy*; '' = off")
    p.add_argument("--health", default="https://mymuse.house/health", help="/health URL to probe; '' = off")
    p.add_argument("--health-every", type=float, default=60, help="min seconds between probes")
    p.add_argument("--health-state", help="probe state file (default: <out dir>/health-state.json)")
    p.add_argument("--no-issues", action="store_true")
    p.add_argument("--no-pushes", action="store_true", help="skip fleet push events (repo events feed)")
    p.add_argument("--feed-pushes", help="tripwire live-wire push ledger (default: <out dir>/feed-pushes.jsonl)")
    p.add_argument("--box-events", help="box delta ledger (default: <out dir>/box-events.jsonl)")
    p.add_argument("--watch", type=float, default=0, help="poll every N seconds (0 = one pass)")
    args = p.parse_args()
    out_dir = Path(args.out).parent
    args.light_notes = args.light_notes or str(out_dir / "light-notes.jsonl")
    args.x_ledger = args.x_ledger or str(out_dir / "x-ledger.jsonl")
    args.health_state = args.health_state or str(out_dir / "health-state.json")
    args.feed_pushes = args.feed_pushes or str(out_dir / "feed-pushes.jsonl")
    args.box_events = args.box_events or str(out_dir / "box-events.jsonl")
    args.deploy_repo = args.deploy_repo or None
    args.health = args.health or None
    if os.environ.get("X_BEARER_TOKEN"):
        log("X_BEARER_TOKEN is set but the X API adapter is not built; X still comes from the ledger / --merge-x")
    read_token = os.environ.get("GITHUB_READ_TOKEN", "").strip()
    if read_token:
        # The host collector uses a read-only fine-grained token. Do not load an
        # App private key here: that key can mint a write token.
        app = None
        token = read_token
        log("host GITHUB_READ_TOKEN: read-only; GitHub App private key is not loaded")
    else:
        app = AppToken.from_env()
        token = None if app else (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"))
    if app:
        log(f"App auth (installation {app.installation_id}): self-minting tokens; GITHUB_TOKEN/GH_TOKEN ignored")
    elif read_token:
        pass
    elif not token:
        log("no GITHUB_TOKEN/GH_TOKEN: private repos will 404 and the rate limit is 60/h")
    elif args.watch:
        log("static GITHUB_TOKEN/GH_TOKEN: not refreshed; set GITHUB_APP_* to self-mint")
    gh = GitHub(token, app)
    out = Path(args.out)
    while True:
        if token_wall_expired():
            log("exiting 75 without writing")
            return 75
        try:
            gh.calls = gh.not_modified = 0
            feed = build(args, gh)
            n_new = write(feed, out)
            log(f"{feed['event_count']} events ({n_new} new) -> {out} [{gh.calls} API calls, {gh.not_modified} 304]")
        except AuthExpired:
            log("GitHub HTTP 401; pass failed loudly, feed not written")
            return 75
        except urllib.error.HTTPError as e:
            log(f"GitHub HTTP {e.code} on {e.url}; keeping last feed")
            if not args.watch:
                return 1
        except MintError as e:
            log(f"App token mint failed: {e}; no fallback token, keeping last feed, retry next poll")
            if not args.watch:
                return 1
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
            # OSError covers ConnectionError/RemoteDisconnected; HTTPException covers IncompleteRead etc.
            log(f"network error ({type(e).__name__}); keeping last feed")
            if not args.watch:
                return 1
        if not args.watch:
            return 0
        time.sleep(args.watch)


if __name__ == "__main__":
    sys.exit(main())
