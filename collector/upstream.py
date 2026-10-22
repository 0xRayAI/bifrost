"""One pinned upstream card plus threads that involve this fleet.

UPSTREAM_REPO (or XRAY_REPO) names the public repo. Unset means this source is off.
UPSTREAM_PINNED is a comma list of owner/name#N. Unset means nothing is pinned.
XRAY_OURS is the login list (with or without [bot]) that counts as this fleet for
author, assignee, review request, and @-mention. Unset means no login counts.

Auth: the read token when it can read the repo. On 401/403/404 the source falls back
to unauthenticated requests (public data, 60/h). _pulls skips entirely when unauthenticated.
This module never writes to the repo. Bodies are read only to set flags and are never stored.
"""
import json, os, re, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import live_packet

API = os.environ.get("UPSTREAM_API", os.environ.get("XRAY_API", "https://api.github.com"))
FLEET = "Upstream"
PARKED_RE = re.compile(r"^\s*parked:", re.I)
ASK_RE = re.compile(r"\?|\b(could|can|would) you\b|\bplease\b|\b(share|confirm|add|send|let us know)\b", re.I)
KEEP_DAYS = 14
EVERY_S = float(os.environ.get("UPSTREAM_EVERY_S", os.environ.get("XRAY_EVERY_S", "60")))
UNAUTH_EVERY_S = float(os.environ.get("UPSTREAM_UNAUTH_EVERY_S", os.environ.get("XRAY_UNAUTH_EVERY_S", "240")))


def _csv(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return list(default)
    return [v.strip() for v in re.split(r"[\s,]+", raw) if v.strip()]


def repo_name():
    return (os.environ.get("UPSTREAM_REPO") or os.environ.get("XRAY_REPO") or "").strip()


def enabled():
    return bool(repo_name())


def our_logins():
    return {v.lower() for v in _csv("XRAY_OURS", [])}


def mention_re():
    handles = tuple(sorted({re.sub(r"\[bot\]$", "", v) for v in our_logins() if v}))
    if not handles:
        return None
    return re.compile(r"(?<![\w/])@(?:%s)(?:\[bot\])?\b" % "|".join(re.escape(h) for h in handles), re.I)


def pinned_numbers(repo=None):
    repo = (repo or repo_name()).lower()
    out = []
    if not repo:
        return out
    for v in _csv("UPSTREAM_PINNED", []):
        r, _, n = v.rpartition("#")
        if r.lower() == repo and n.isdigit():
            out.append(int(n))
    return out


def ct(t):
    if not t:
        return t
    return datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(ZoneInfo("America/Chicago")).isoformat(timespec="seconds")


def ours(login):
    low = str(login or "").lower()
    return bool(low) and (low in our_logins() or re.sub(r"\[bot\]$", "", low) in our_logins())


def involves_us(it):
    return (ours(it.get("author")) or any(ours(a) for a in it.get("assignees") or [])
            or any(ours(a) for a in it.get("reviewers") or []) or bool(it.get("mentioned")))


def node(login, uc_node=None):
    if ours(login):
        return uc_node(login) if uc_node else "Operator"
    return FLEET if login else "GitHub"


class UpstreamCollector:
    def __init__(self, store: Path, token: str = "", uc_node=None, log=print):
        self.path = Path(store) / "upstream.json"
        self.token, self.uc_node, self.log = token, uc_node, log
        try:
            self.st = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.st = {}
        for k, v in (("items", {}), ("comments", {}), ("reviews", {}), ("etags", {}), ("cur", {})):
            self.st.setdefault(k, v)
        self.auth = bool(token)
        self.last_run = 0.0
        self.calls = 0

    def get(self, path, params=None, etag_key=None):
        url = (path if path.startswith("http") else API + path) + ("?" + urllib.parse.urlencode(params) if params else "")
        for attempt in (0, 1):
            h = {"Accept": "application/vnd.github+json", "User-Agent": "bifrost-upstream"}
            if self.auth and self.token:
                h["Authorization"] = "Bearer " + self.token
            if etag_key and self.st["etags"].get(etag_key):
                h["If-None-Match"] = self.st["etags"][etag_key]
            self.calls += 1
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=30) as r:
                    if etag_key and r.headers.get("ETag"):
                        self.st["etags"][etag_key] = r.headers["ETag"]
                    m = re.search(r'<([^>]+)>;\s*rel="next"', r.headers.get("Link") or "")
                    return 200, json.loads(r.read() or b"null"), (m.group(1) if m else None)
            except urllib.error.HTTPError as e:
                e.read(); e.close()
                if e.code == 304:
                    return 304, None, None
                if e.code in (401, 403, 404) and self.auth and attempt == 0:
                    self.auth = False
                    self.log(f"upstream: read token answered {e.code}; using unauthenticated public reads")
                    continue
                raise
        return 0, None, None

    def pages(self, path, params, etag_key, max_pages=5):
        st, data, nxt = self.get(path, params, etag_key)
        if st != 200:
            return
        for _ in range(max_pages):
            for it in data or []:
                yield it
            if not nxt:
                return
            st, data, nxt = self.get(nxt)

    def due(self, now=None):
        now = now or time.time()
        return now - self.last_run >= (EVERY_S if self.auth else UNAUTH_EVERY_S)

    def run(self, now=None):
        if not enabled():
            return []
        now = now or time.time()
        if not self.due(now):
            return self.events()
        self.last_run = now
        floor = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            self._issues(self.st["cur"].get("issues") or floor)
            self._pulls()
            for n in pinned_numbers():
                self._ensure_item(n)
            self._comments(self.st["cur"].get("comments") or floor)
            self._review_comments(self.st["cur"].get("rcomments") or floor)
            self._reviews()
        except (urllib.error.URLError, OSError, ValueError) as e:
            self.log(f"upstream: pass failed ({type(e).__name__}); keeping last events")
        self._prune(floor)
        self._save()
        return self.events()

    def _item(self, it):
        n = int(it["number"]); prev = self.st["items"].get(str(n), {})
        login = (it.get("user") or {}).get("login")
        text = f"{it.get('title') or ''}\n{it.get('body') or ''}"
        pr = it.get("pull_request") or None
        mentioned = bool(prev.get("mentioned"))
        rx = mention_re()
        if rx and rx.search(text):
            mentioned = True
        self.st["items"][str(n)] = {
            "n": n, "pr": bool(pr), "author": login, "title": (it.get("title") or "")[:120], "url": it.get("html_url") or "",
            "state": it.get("state"), "created": it.get("created_at"), "closed": it.get("closed_at"),
            "merged": (pr or {}).get("merged_at"), "draft": bool(it.get("draft")), "updated": it.get("updated_at"),
            "labels": [l.get("name", "")[:30] for l in it.get("labels") or []][:6],
            "assignees": [(a or {}).get("login") for a in it.get("assignees") or [] if (a or {}).get("login")][:10],
            "reviewers": prev.get("reviewers") or [],
            "mentioned": mentioned}
        self._retrack(n)

    def _retrack(self, n):
        it = self.st["items"].get(str(n))
        if it is not None:
            it["tracked"] = involves_us(it) or n in pinned_numbers()

    def _pulls(self):
        """Open PRs: requested reviewers. Skipped when unauthenticated (the issues list has no reviewer field)."""
        if not self.auth:
            return
        repo = repo_name()
        if not repo:
            return
        for pr in self.pages(f"/repos/{repo}/pulls", {"state": "open", "per_page": 100}, "pulls", max_pages=3):
            it = self.st["items"].get(str(pr.get("number")))
            if it is None:
                continue
            it["reviewers"] = [(u or {}).get("login") for u in pr.get("requested_reviewers") or [] if (u or {}).get("login")][:10]
            self._retrack(int(pr["number"]))

    def _issues(self, since):
        repo = repo_name()
        newest = since
        for it in self.pages(f"/repos/{repo}/issues", {"state": "all", "sort": "updated", "direction": "desc", "since": since, "per_page": 100}, "issues"):
            self._item(it); newest = max(newest, it.get("updated_at") or newest)
        self.st["cur"]["issues"] = newest

    def _ensure_item(self, n):
        if str(n) not in self.st["items"]:
            st, it, _ = self.get(f"/repos/{repo_name()}/issues/{n}")
            if st == 200 and it:
                self._item(it)

    def _flags(self, body):
        rx = mention_re()
        flags = {"mention": bool(rx and rx.search(body)), "parked": bool(PARKED_RE.match(body)),
                 "ask": bool(ASK_RE.search(body))}
        hold = live_packet.parse_hold(body)
        if hold:
            flags["hold"] = hold
        return flags

    def _comments(self, since):
        newest = since
        for cm in self.pages(f"/repos/{repo_name()}/issues/comments", {"sort": "updated", "direction": "desc", "since": since, "per_page": 100}, "comments"):
            newest = max(newest, cm.get("updated_at") or newest)
            n = int(str(cm.get("issue_url", "")).rsplit("/", 1)[-1] or 0)
            if not n:
                continue
            f = self._flags(cm.get("body") or "")
            self.st["comments"][str(cm["id"])] = {"n": n, "t": cm["created_at"], "login": (cm.get("user") or {}).get("login"), "url": cm.get("html_url", ""), **f}
            if f["mention"]:
                self._ensure_item(n)
                if str(n) in self.st["items"]:
                    self.st["items"][str(n)]["mentioned"] = True
                    self._retrack(n)
        self.st["cur"]["comments"] = newest

    def _review_comments(self, since):
        newest = since
        for cm in self.pages(f"/repos/{repo_name()}/pulls/comments", {"sort": "updated", "direction": "desc", "since": since, "per_page": 100}, "rcomments"):
            newest = max(newest, cm.get("updated_at") or newest)
            n = int(str(cm.get("pull_request_url", "")).rsplit("/", 1)[-1] or 0)
            if not n:
                continue
            f = self._flags(cm.get("body") or "")
            self.st["comments"]["r" + str(cm["id"])] = {"n": n, "t": cm["created_at"], "login": (cm.get("user") or {}).get("login"), "url": cm.get("html_url", ""), "review": True, **f}
            if f["mention"]:
                self._ensure_item(n)
                if str(n) in self.st["items"]:
                    self.st["items"][str(n)]["mentioned"] = True
                    self._retrack(n)
        self.st["cur"]["rcomments"] = newest

    def _reviews(self):
        for k, it in self.st["items"].items():
            if not (it.get("tracked") and it.get("pr")) or it.get("reviews_at") == it.get("updated"):
                continue
            if (it.get("updated") or "") < (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ"):
                it["reviews_at"] = it.get("updated"); continue
            st, data, _ = self.get(f"/repos/{repo_name()}/pulls/{it['n']}/reviews", {"per_page": 100})
            if st != 200:
                continue
            for rv in data or []:
                if not rv.get("submitted_at"):
                    continue
                f = self._flags(rv.get("body") or "")
                self.st["reviews"][str(rv["id"])] = {"n": it["n"], "t": rv["submitted_at"], "login": (rv.get("user") or {}).get("login"),
                                                    "url": rv.get("html_url", ""), "verdict": rv.get("state"), **f}
            it["reviews_at"] = it.get("updated")

    def _prune(self, floor):
        for d in ("comments", "reviews"):
            for k in [k for k, v in self.st[d].items() if (v.get("t") or "") < floor]:
                del self.st[d][k]
        for k in [k for k, v in self.st["items"].items() if not v.get("tracked") and (v.get("updated") or "") < floor]:
            del self.st["items"][k]

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp"); tmp.write_text(json.dumps(self.st)); os.replace(tmp, self.path)

    def events(self):
        repo = repo_name()
        if not repo:
            return []
        out = []
        pins = pinned_numbers()
        rx = mention_re()
        said = set()
        if rx:
            said = {c.get("n") for d in ("comments", "reviews") for c in self.st[d].values() if c.get("mention")}
        for k, v in self.st["items"].items():
            v["mentioned"] = bool(v.get("mentioned")) or int(k) in said
            v["tracked"] = involves_us(v) or int(k) in pins
        tracked = {int(k): v for k, v in self.st["items"].items() if v.get("tracked")}
        for n, it in tracked.items():
            base = {"repo": repo, "number": n, "src_file": "github-api", "direction": "internal", "external": "upstream",
                    "source": it["url"], "upstream": "pinned" if n in pins else "involves_us"}
            kind = "pr_open" if it["pr"] else "issue_open"
            fr = node(it["author"], self.uc_node)
            out.append({**base, "id": f"{repo}#{n}:open", "t_ct": ct(it["created"]), "from": fr, "to": "GitHub", "kind": kind,
                        "label": f"{fr} opened · upstream #{n}"[:54], "title": it["title"], "actor": it["author"],
                        "pr_state": "closed" if it["state"] == "closed" else "open", "closed_at": ct(it.get("closed")),
                        "draft": it.get("draft"), "labels": it.get("labels") or [], "packet": {}})
            if it.get("merged"):
                out.append({**base, "id": f"{repo}#{n}:merged", "t_ct": ct(it["merged"]), "from": FLEET, "to": "GitHub", "kind": "merged",
                            "label": f"merged upstream #{n}", "base": "main"})
            elif it["state"] == "closed" and it.get("closed"):
                out.append({**base, "id": f"{repo}#{n}:close", "t_ct": ct(it["closed"]), "from": FLEET, "to": "GitHub",
                            "kind": "pr_close" if it["pr"] else "issue_close", "label": f"closed upstream #{n}"})
        for d, kind in (("comments", None), ("reviews", "pr_review")):
            for cid, c in self.st[d].items():
                it = tracked.get(c["n"])
                if not it:
                    continue
                k = kind or ("pr_comment" if it["pr"] else "issue_comment")
                fr = node(c["login"], self.uc_node)
                e = {"repo": repo, "number": c["n"], "src_file": "github-api", "direction": "internal", "external": "upstream",
                     "id": f"{repo}#{c['n']}:{'review' if kind else 'comment'}:{cid}", "t_ct": ct(c["t"]), "from": fr, "to": "GitHub",
                     "kind": k, "label": f"{c['login'] or '?'} {'review' if kind else 'comment'} · upstream #{c['n']}"[:54],
                     "source": c.get("url", ""), "actor": c["login"]}
                if c.get("parked"):
                    e["parked"] = True
                if isinstance(c.get("hold"), dict):
                    e["hold"] = {"reason": c["hold"].get("reason") or "", "until": c["hold"].get("until") or ""}
                out.append(e)
        return out
