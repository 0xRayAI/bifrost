"""Bifrost full-history GitHub collector (read-only token; metadata only, never bodies).

Backfill once (GraphQL for PR commits/reviews/CI and develop/main history+CI; paged REST for lists),
then poll incrementally (REST page 1 with ETag; a 304 does not count against the rate limit).
State persists in <out dir>/store/<repo>.json so supervisor restarts never re-backfill.
"""
from __future__ import annotations
import json, os, re, time, urllib.request, urllib.error, urllib.parse, http.client
from datetime import datetime, timedelta, timezone
from pathlib import Path

import live_packet
import live_site

API = "https://api.github.com"
REST_FLOOR = int(os.environ.get("LIVE_REST_FLOOR", "1500"))   # leave this much core budget for the fleet
GQL_FLOOR = int(os.environ.get("LIVE_GQL_FLOOR", "1000"))
BACKFILL_SECONDS = float(os.environ.get("LIVE_BACKFILL_SECONDS", "150"))   # per pass
BRAND = os.environ.get("LIVE_BRAND") or live_site.SITE["name"]   # display name the product names below are relabelled to
BRAND_RE = re.compile(os.environ.get("LIVE_BRAND_RE", r"(?i)(?:acmeco|acme)(?![-/])"))   # repo names stay as identifiers
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")   # never ship addresses
CRITIC = "reviewer-app[bot]"


def critic_logins() -> set[str]:
    """Exact critic logins from fleet-nodes.json, plus the template Reviewer app. Bare names are not added."""
    found = {CRITIC}
    path = Path(__file__).resolve().parent / "fleet-nodes.json"
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return found
    if not isinstance(raw, dict):
        return found
    for login, seat in raw.items():
        if str(seat).strip().lower() != "critic":
            continue
        name = str(login).strip()
        if name:
            found.add(name)
    return found


CRITIC_LOGINS = critic_logins()   # critic verdict comments become critic_* beats
CI_FAIL = {"failure", "timed_out", "cancelled", "startup_failure", "action_required"}
CI_KINDS = frozenset({"workflow_run", "check_suite", "check_run", "ci_pass", "ci_fail"})
PUSH_SKIP_BRANCHES = {"live-wire"}


def ci_result_kind(conclusion, status) -> str | None:
    """A completed workflow run is ci_pass or ci_fail. Anything still running is neither."""
    if status != "completed":
        return None
    word = str(conclusion or "").lower()
    if word == "success":
        return "ci_pass"
    if word in CI_FAIL:
        return "ci_fail"
    return None
CRITIC_RE = re.compile(r"^\*\*Reviewer(?:: (PASS|FAIL|HOLD)\b| re-check:\s*(?:\**\s*)?(PASS|FAIL)?\b)")
MENTION_RE = re.compile(r"(?<![\w`/.])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?)(?![\w-])")


def mentions(body: str | None) -> list | None:
    """@handles in a body (lower-cased, max 10, code spans skipped); the body itself is never stored."""
    text = re.sub(r"```.*?```|`[^`]*`", " ", body or "", flags=re.S)
    out = sorted({m.lower() for m in MENTION_RE.findall(text)})[:10]
    return out or None


SHA_RE = re.compile(r"@\s*`?([0-9a-f]{7,40})\b")
NODE = {"builder-app[bot]": "Builder", "reviewer-app[bot]": "Reviewer", "reviewer-app": "Reviewer", "ops-app[bot]": "Operator",
        "lead-alt": "Lead", "lead-login": "Lead", "github-actions[bot]": "CI"}   # a person can have several logins
# Per-fleet login -> node map, merged over the template defaults: LIVE_NODE_MAP='{"forge0x1[bot]":"forge"}'
# (JSON object, or a path to a JSON file). Keeps a fleet's seats out of the kit.
def _node_map_env() -> dict:
    raw = os.environ.get("LIVE_NODE_MAP", "").strip()
    if not raw:
        return {}
    try:
        m = json.loads(Path(raw).read_text() if not raw.startswith("{") else raw)
    except (OSError, ValueError):
        return {}
    return {str(k): v for k, v in m.items() if isinstance(v, str) and v} if isinstance(m, dict) else {}


def _human_aliases() -> dict:
    """HUMAN_ALIASES is a comma or space list of human GitHub logins. Each one is the owner node (Blaze)."""
    raw = os.environ.get("HUMAN_ALIASES", "")
    return {p: "Blaze" for p in re.split(r"[\s,]+", raw.strip()) if p}


NODE.update(_human_aliases())
NODE.update(_node_map_env())   # an explicit LIVE_NODE_MAP login wins over HUMAN_ALIASES
NODE_LC = {k.lower(): v for k, v in NODE.items()}   # logins are case-insensitive (lead-alt / lead-alt)
ALIAS = {"lead-alt": "Lead", "lead-login": "Lead"}   # stored node names from before the fold
# Cursor cloud agents (cursoragent, cursor-agent, ...); Bugbot (cursor[bot]) is NOT one of them
CLOUD_AGENT_RE = re.compile(r"(?i)^cursor-?(?:cloud-?)?agents?(?:\[bot\])?$")
MERGE_BASES = ("develop", "main")
# Fine-grained read-only token (Railway collector): GitHub offers no Checks permission for those, so REST
# check-suites/check-runs answer 403 and GraphQL checkSuites is FORBIDDEN. With LIVE_NO_CHECKS=1 the collector
# skips both and derives the github-actions part from Actions instead (same event ids): every workflow run is its
# check suite (check_suite_id) and every job is its check run (job id == check run id). Lost: suites/runs of other
# apps (railway-app, cursor/Bugbot); Railway deploys still arrive as commit statuses.
NO_CHECKS = os.environ.get("LIVE_NO_CHECKS") == "1"
# Logins not in NODE/LIVE_NODE_MAP would publish as 'Others' with their login + commit/PR title. Dropped by default
# (privacy: outside contributors stay off the page); LIVE_SHOW_UNMAPPED=1 opts back in.
SHOW_UNMAPPED = os.environ.get("LIVE_SHOW_UNMAPPED") == "1"
JOBS_WINDOW_S = 2 * 3600       # jobs are fetched for runs created in the last 2 h (ETag'd until completed)


def _brand_sub(m) -> str:
    a, b = m.string[m.start() - 1:m.start()], m.string[m.end():m.end() + 1]
    inside = bool(re.match(r"[A-Za-z0-9_]", a or " ") or re.match(r"[A-Za-z0-9_]", b or " "))
    return BRAND   # inside an identifier (DirectXClient, X_sdk.zip): no dot


def brand(s: str | None) -> str:
    return EMAIL_RE.sub("[email]", BRAND_RE.sub(_brand_sub, " ".join((s or "").split())))


SEAT_TRAILER_RE = re.compile(r"(?im)^Seat:\s*([a-z0-9-]{2,16})\s*$")


# Git author names that are seats. A mapped login still wins; forge0x1[bot] stays forge.
SEAT_GIT_NAMES = frozenset({"blinky", "critic", "forge", "arch1", "herald", "magnet", "nibbler", "sound"})


def seat_trailer(msg: str | None) -> str | None:
    """`Seat: <seat>` trailer in a commit message (last one wins); it overrides the login map for credit."""
    found = SEAT_TRAILER_RE.findall(msg or "")
    return found[-1].lower() if found else None


def credit(login: str | None) -> str | None:
    """Seat an event is credited to: the login -> seat map (fleet-nodes.json via LIVE_NODE_MAP, over NODE), else
    a git author whose name is a seat (mill commits as name "mill" with no GitHub login), else
    "other" for any unknown login. None when there is no login (GitHub-originated). forge0x1[bot] commits cannot be
    told apart from mill's work (mill commits through forge's identity), so they credit forge unless the git name
    or a Seat: trailer says mill."""
    if not login:
        return None
    if CLOUD_AGENT_RE.match(login):
        return "CloudAgents"
    low = login.lower()
    n = NODE_LC.get(low)
    if n:
        return CREDIT_ALIAS.get(n.lower(), n)
    if low.startswith("git:") and low[4:] in SEAT_GIT_NAMES:   # only commit_login's no-User git-name path
        return low[4:]
    return "github" if low.endswith("[bot]") else "other"   # unmapped bot / CI -> the github node


CREDIT_ALIAS = {"ci": "github", "github": "github", "blaze0x1": "Blaze", "blaze": "Blaze", "lead": "Blaze"}
LOGIN_KEYS = ("actor", "author", "sender", "triggering_actor", "merged_by", "user")


def node(login: str | None) -> str:
    """Mesh node for an actor. Unknown actors (e.g. Tester's new App) are kept as 'Others' + actor=login.
    A git author whose name is a seat (no User login) is that seat, not Others."""
    if login and CLOUD_AGENT_RE.match(login):
        return "CloudAgents"
    low = (login or "").lower()
    mapped = NODE_LC.get(low)
    if mapped:
        return mapped
    if low.startswith("git:") and low[4:] in SEAT_GIT_NAMES:   # a GitHub login is never a seat by name
        return low[4:]
    return "Others" if login else "GitHub"


def gql_login(actor) -> str | None:
    """GraphQL returns a Bot's login without the REST '[bot]' suffix; normalize to the REST form."""
    if not actor or not actor.get("login"):
        return None
    return actor["login"] + "[bot]" if actor.get("__typename") == "Bot" else actor["login"]


def commit_login(cm) -> str | None:
    a = cm.get("author") or {}
    if (a.get("user") or {}).get("login"):
        return a["user"]["login"]
    name = (a.get("name") or "").strip()
    if name.endswith("[bot]"):
        return name   # bot authors have no User; their git name is the login
    return "git:" + name.lower() if name.lower() in SEAT_GIT_NAMES else None   # ":" never occurs in a GitHub login


def rest_author_login(cm) -> str | None:
    """REST pull commit: author.login when GitHub has one, else the git author name when it is a seat."""
    login = (cm.get("author") or {}).get("login")
    if login:
        return login
    git = ((cm.get("commit") or {}).get("author") or {})
    return commit_login({"author": {"name": git.get("name") or "", "user": None}})


_CLOSE_WORD = re.compile(r"\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|supersede[sd]?|replace[sd]?)\b", re.I)
_CLOSE_NUM = re.compile(r"#(\d{1,6})\b")
_CLOSE_SEP = re.compile(r"(?:,|\band\b)?\s+", re.I)


def closing_numbers(body, own=None):
    """Every #number after fix/close/resolve/supersede/replace, including a run (#294 #295).
    Refs does not close. Own number is dropped. Sorted, capped so a long trailer cannot flood the card."""
    text = body or ""
    found = set()
    try:
        own_n = int(own) if own is not None else None
    except (TypeError, ValueError):
        own_n = None
    for m in _CLOSE_WORD.finditer(text):
        i = m.end()
        while i < len(text) and text[i] in " \t:":
            i += 1
        while i < len(text):
            nm = _CLOSE_NUM.match(text, i)
            if not nm:
                break
            n = int(nm.group(1))
            if n != own_n:
                found.add(n)
            i = nm.end()
            sep = _CLOSE_SEP.match(text, i)
            if not sep or sep.end() == i or not _CLOSE_NUM.match(text, sep.end()):
                break
            i = sep.end()
    return sorted(found)[:16] or None
PARKED_COMMENT_RE = re.compile(r"^\s*parked:", re.I)   # Coord rule: a comment starting 'Parked:' parks the card
START_AFTER_RE = re.compile(
    r"^\s*start after:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?[+-]\d{2}:\d{2})\s*$", re.I)


def comment_start_after(body):
    """First line `Start after: <ISO with offset>` -> that timestamp. Anything else is ignored."""
    first = next((ln for ln in str(body or "").replace("\r\n", "\n").splitlines() if ln.strip()), "")
    m = START_AFTER_RE.match(first)
    return m.group(1) if m else None
RESOLVED_RE = re.compile(r"\b(resolved|superseded|fixed (?:in|by) #\d+|nothing (?:on #\d+ )?(?:is )?(?:waiting|left|pending)|"
                         r"no (?:further )?action (?:needed|required)|can be closed)\b", re.I)


PROMPT_STAMP = re.compile(r"(?m)^Prompt:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,79})\s*$")


def prompt_stamp(body):
    """The activity id on a `Prompt: <id>` line. The rest of the body stays unstored."""
    found = PROMPT_STAMP.search(str(body or ""))
    return found.group(1) if found else ""


def card_fields(x) -> dict:
    """Board card fields from a PR / issue object this pass already fetched: branded title, state, labels and
    the packet block (sanitized, <= 200 chars a field). The body itself is discarded here, never stored.
    packet_file stays when the body carries a packet or names PACKET.md. The branch file is a separate check."""
    body = x.get("body")
    fields = {"title": brand(x.get("title") or "")[:120], "pr_state": x.get("state"), "closed_at": x.get("closed_at"),
              "labels": [lb.get("name") for lb in (x.get("labels") or []) if isinstance(lb, dict) and lb.get("name")][:8],
              "packet": live_packet.parse(body) or None,
              "fixes": closing_numbers(body, x.get("number"))}
    if live_packet.carries(body):
        fields["packet_file"] = True
    pid = prompt_stamp(body)
    if pid:
        fields["prompt"] = pid
    return fields


def packet_file_on_ref(client, repo, ref):
    """True when PACKET.md exists at ref. A 404 is a miss. A rate-limit skip is a miss, not a failure."""
    if not ref or not repo or not getattr(client, "token", None):
        return False
    try:
        st, data, _, _ = client.rest(f"/repos/{repo}/contents/PACKET.md", {"ref": ref}, essential=False)
    except urllib.error.HTTPError:
        return False
    except (RateLow, urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError):
        return False
    return st == 200 and isinstance(data, dict)


def open_numbers(c, repos, max_pages=20):
    """{repo_lower: {numbers}} of every open issue and PR, one paged query per repo.
    A repo whose query fails is left out, so callers fall back to stored events for it."""
    out = {}
    for repo in sorted({str(r).lower() for r in repos if r and "/" in str(r)}):
        nums, url, params = set(), f"/repos/{repo}/issues", {"state": "open", "per_page": 100}
        try:
            for _ in range(max_pages):
                st, data, _, nxt = c.rest(url, params, essential=False)
                if st != 200 or not isinstance(data, list):
                    raise ValueError(f"HTTP {st}")
                nums.update(int(i["number"]) for i in data if isinstance(i, dict) and i.get("number") is not None)
                if not nxt:
                    break
                url, params = nxt, None
            else:
                continue
        except (RateLow, urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError, KeyError):
            continue
        out[repo] = nums
    return out


def fleet_only(events: list) -> list:
    """Drop GitHub-sourced events that would show a login outside the fleet map.
    Local events (lab bugs, prompts) stay even when from or to is Others.
    A GitHub-sourced event has a github* src_file, an actor or an author. LIVE_SHOW_UNMAPPED=1 keeps everything."""
    if SHOW_UNMAPPED:
        return events
    out = []
    for e in events:
        github = str(e.get("src_file") or "").startswith("github") or bool(e.get("actor")) or bool(e.get("author"))
        if github and ("Others" in (e.get("from"), e.get("to")) or "Others" in (e.get("hops") or [])):
            continue
        if github and e.get("external") == "upstream" and e.get("actor") and e.get("from") == "Upstream":   # not in XRAY_OURS
            continue
        out.append(e)
    return out


def iso_ct(t: str, CT) -> str:
    return datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(CT).isoformat()


def gh_time(t):
    """UTC instant for a GitHub timestamp. Z and a numeric offset of the same second match.
    Unparseable or naive values are None so a cursor compare does not skip them."""
    if not isinstance(t, str) or not t:
        return None
    raw = t[:-1] + "+00:00" if t.endswith("Z") else t
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc)


def gh_before(t, cur) -> bool:
    """True when t is strictly earlier than cur. A sibling in the cursor second is not before."""
    if cur is None:
        return False
    a, b = gh_time(t), gh_time(cur)
    if a is None or b is None:
        return False
    return a < b


def gh_after(t, newest) -> bool:
    """True when t is strictly later than newest. A missing newest accepts any parsed t."""
    a = gh_time(t)
    if a is None:
        return False
    if newest is None:
        return True
    b = gh_time(newest)
    if b is None:
        return True
    return a > b


class RateLow(Exception):
    pass


class AuthExpired(Exception):
    """401 from GitHub: the read-only installation token expired (e.g. the box was paused past its 1 h life).
    Not an URLError/HTTPError subclass on purpose, so per-step "keep stored events" handlers don't swallow it:
    the feed exits and the supervisor re-mints."""


class Client:
    def __init__(self, token: str):
        self.token = token
        self.calls = self.not_modified = self.gql_calls = 0
        self.gql_points = 0
        self.remaining = self.gql_remaining = None

    def _req(self, url, method="GET", data=None, etag=None):
        h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
             "User-Agent": "live-board-feed", "Authorization": f"Bearer {self.token}"}
        if etag:
            h["If-None-Match"] = etag
        if data is not None:
            h["Content-Type"] = "application/json"
        return urllib.request.Request(url, method=method, data=data, headers=h)

    def rest(self, path, params=None, etag=None, essential=False):
        """-> (status, data, etag, next_url). 304 -> (304, None, etag, None)."""
        if not essential and self.remaining is not None and self.remaining < REST_FLOOR:
            raise RateLow(f"core remaining {self.remaining} < floor {REST_FLOOR}")
        url = path if path.startswith("http") else API + path
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        self.calls += 1
        try:
            with urllib.request.urlopen(self._req(url, etag=etag), timeout=40) as r:
                rem = r.headers.get("X-RateLimit-Remaining")
                if rem is not None:
                    self.remaining = int(rem)
                body = r.read()
                m = re.search(r'<([^>]+)>;\s*rel="next"', r.headers.get("Link") or "")
                return r.status, json.loads(body or b"null"), r.headers.get("ETag"), (m.group(1) if m else None)
        except urllib.error.HTTPError as e:
            rem = e.headers.get("X-RateLimit-Remaining") if e.headers else None
            if rem is not None:
                self.remaining = int(rem)
            e.read(); e.close()
            if e.code == 304:
                self.not_modified += 1
                return 304, None, etag, None
            if e.code == 401:
                raise AuthExpired("HTTP 401 on REST") from None
            raise

    def gql(self, query, variables):
        if self.gql_remaining is not None and self.gql_remaining < GQL_FLOOR:
            raise RateLow(f"graphql remaining {self.gql_remaining} < floor {GQL_FLOOR}")
        data = json.dumps({"query": query, "variables": variables}).encode()
        self.gql_calls += 1
        try:
            with urllib.request.urlopen(self._req(API + "/graphql", "POST", data), timeout=90) as r:
                out = json.loads(r.read())
        except urllib.error.HTTPError as e:
            e.close()
            if e.code == 401:
                raise AuthExpired("HTTP 401 on GraphQL") from None
            raise
        if out.get("errors") and not out.get("data"):
            raise RuntimeError("graphql: " + "; ".join(str(e.get("message"))[:120] for e in out["errors"]))
        rl = (out.get("data") or {}).get("rateLimit") or {}
        self.gql_points += rl.get("cost") or 0
        if rl.get("remaining") is not None:
            self.gql_remaining = rl["remaining"]
        return out["data"]


COMMIT_FIELDS = """oid committedDate messageHeadline author { name user { login } }""" + ("" if NO_CHECKS else """
  checkSuites(first: 10) { totalCount nodes { databaseId status conclusion createdAt updatedAt app { slug }
    checkRuns(first: 25) { totalCount nodes { databaseId name status conclusion startedAt completedAt } } } }""") + """
  status { contexts { context state createdAt creator { login __typename } } }"""
Q_HISTORY = """query($owner:String!,$name:String!,$ref:String!,$after:String){ rateLimit{cost remaining}
 repository(owner:$owner,name:$name){ ref(qualifiedName:$ref){ target{ ... on Commit {
  history(first:50, after:$after){ totalCount pageInfo{hasNextPage endCursor} nodes{ %s } } } } } } }""" % COMMIT_FIELDS
Q_PRS = """query($owner:String!,$name:String!,$after:String){ rateLimit{cost remaining}
 repository(owner:$owner,name:$name){ pullRequests(first:10, after:$after, orderBy:{field:CREATED_AT, direction:ASC}){
  totalCount pageInfo{hasNextPage endCursor} nodes{ number
   commits(first:40){ totalCount nodes{ commit{ %s } } }
   reviews(first:60){ totalCount nodes{ databaseId state submittedAt url author{login __typename} } } } } } }""" % COMMIT_FIELDS


class RepoCollector:
    def __init__(self, repo: str, store_dir: Path, ff, log):
        self.repo, self.short = repo, repo.split("/", 1)[1]
        self.owner, self.name = repo.split("/", 1)
        self.ff, self.log, self.CT = ff, log, ff.CT
        self.path = store_dir / f"{self.short}.json"
        s = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.ev: dict = s.get("events", {})
        for e in self.ev.values():   # apply the current branding + email redaction to stored labels/messages
            for k in ("from", "to"):    # and the current node mapping (lead-alt -> Lead)
                if isinstance(e.get(k), str) and e[k].lower() in ALIAS:
                    e[k] = ALIAS[e[k].lower()]
            login = e.get("actor") if isinstance(e.get("actor"), str) and e.get("actor") else None
            if not login and isinstance(e.get("author"), str) and e.get("author"):
                login = e.get("author")
            # A later LIVE_NODE_MAP must relabel events already stored. Incremental polls only rewrite changed items.
            # "CI" is a fixed node, same as GitHub. An unmapped bot must not turn that into Others.
            # A CI kind already stored as Others is that rewrite. Put it back on CI while the actor
            # is unmapped, so this load does not delete it. Once the actor is in the map, reclaim it.
            if login and e.get("from") not in ("GitHub", "Example", "CI", live_site.SITE["node"]):
                if e.get("kind") in CI_KINDS:
                    if e.get("from") == "Others":
                        mapped = node(login)
                        e["from"] = "CI" if mapped == "Others" else mapped
                else:
                    e["from"] = node(login)
            if e.get("from") == "Others" and CLOUD_AGENT_RE.match(str(e.get("actor") or e.get("author") or "")):
                e["from"] = "CloudAgents"   # cloud-agent writes stored before the Cloud agents node existed
            # A merge is a fact about the pull. An unmapped merger (cursor[bot] -> Others) must not drop it.
            if e.get("kind") == "merged" and e.get("from") == "Others":
                e["from"] = "GitHub"
            for k in ("label", "message"):
                if isinstance(e.get(k), str) and (BRAND_RE.search(e[k]) or EMAIL_RE.search(e[k])):
                    e[k] = brand(e[k])
        if not SHOW_UNMAPPED:   # stored events from before the filter
            kept = {}
            for k, e in self.ev.items():
                if "Others" not in (e.get("from"), e.get("to")):
                    kept[k] = e
                    continue
                self.log(f"{self.short}: drop stored event {k} kind={e.get('kind')} "
                         f"from={e.get('from')} to={e.get('to')} actor={e.get('actor') or e.get('author') or ''}")
            self.ev = kept
        self.st: dict = s.get("state", {})
        for k, v in (("etags", {}), ("cur", {}), ("prs", {}), ("ci", {}), ("reviewer", {}), ("bf", {}),
                     ("branch_shas", {}), ("tag_time", {}), ("gaps", {})):
            self.st.setdefault(k, v)
        self._sha_who = {}
        self.unreadable = None
        self._denied = None
        for e in self.ev.values():
            self._index_sha(e)
        for e in self.ev.values():   # every stored event gets a credit (never blank), also ones from before the map
            e["credit"] = self.credit_of(e)

    # ---------------------------------------------------------------- helpers
    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(f".tmp.{os.getpid()}")
        tmp.write_text(json.dumps({"events": self.ev, "state": self.st}, ensure_ascii=False))
        os.replace(tmp, self.path)

    def put(self, eid, t, frm, to, kind, label, source, number=None, **extra):
        if not t:
            return
        if kind == "merged" and frm == "Others":
            frm = "GitHub"   # count the merge; the actor login stays on the event
        actor = str(extra.get("actor") or "")
        if (kind in ("pr_comment", "issue_comment", "review_comment") and actor.lower() == "cursor[bot]"
                and frm == "Others" and extra.get("mentions")):
            frm = "GitHub"   # keep the @mention; cursor[bot] stays the actor, not a seat
        if not SHOW_UNMAPPED and "Others" in (frm, to):
            self.ev.pop(eid, None)
            return
        if frm == to:
            to = "GitHub" if frm != "GitHub" else live_site.SITE["node"]
        e = {"id": eid, "t_ct": iso_ct(t, self.CT) if (t.endswith("Z") or "+" in t[10:]) else t, "from": frm,
             "to": to, "kind": kind, "direction": "internal", "label": brand(label)[:54], "source": source,
             "src_file": "github-api", "repo": self.repo}
        if number is not None:
            e["number"] = int(number)
        for k, v in extra.items():
            if v is not None:
                e[k] = v
        self._index_sha(e)
        e["credit"] = self.credit_of(e)
        self.ev[eid] = e

    def _index_sha(self, e):   # sha -> (commit author login, Seat: trailer) for check / workflow / deploy fallbacks
        sha = e.get("sha")
        if isinstance(sha, str) and len(sha) >= 7 and (e.get("author") or e.get("seat_trailer")):
            self._sha_who[sha[:7]] = (e.get("author"), e.get("seat_trailer"))

    def credit_of(self, e) -> str:
        """Seat credited for an event, never blank: Seat: trailer > actor / sender login > the PR's author >
        the commit's author login > that commit's Seat: trailer > the github node (CI, bots, rails with no seat)."""
        if e.get("seat_trailer"):
            return e["seat_trailer"]
        for k in LOGIN_KEYS:
            v = e.get(k)
            if isinstance(v, str) and v:
                return credit(v)
        n = e.get("number")
        p = self.st.get("prs", {}).get(str(n)) if n is not None and hasattr(self, "st") else None
        if p and p.get("author"):
            return credit(p["author"])
        sha = e.get("sha") or e.get("head_sha") or e.get("merge_sha")
        if isinstance(sha, str) and sha[:7] in getattr(self, "_sha_who", {}):
            login, trailer = self._sha_who[sha[:7]]
            return trailer or credit(login) or "github"
        return "github"

    def pr_node(self, n):
        # An author outside the fleet maps to "Others", and put() drops any event touching "Others": comments on
        # such a PR reached no seat and no card. The PR side is a target, not a person to show, so it is GitHub.
        p = self.st["prs"].get(str(n))
        who = node(p["author"]) if p else "GitHub"
        return "GitHub" if who == "Others" else who

    def issue_node(self, n):
        """The issue author's node, so an issue comment reaches the issue's seat (same Others rule as pr_node)."""
        login = (self.st.get("issues") or {}).get(str(n))
        who = node(login) if login else "GitHub"
        return "GitHub" if who == "Others" else who

    def paged(self, c, path, params, key, stop=None, essential=True, max_pages=400):
        """Page 1 with ETag (key); then follow Link next until stop(item) is True. Yields items.
        Sets self._etag_new to the page-1 ETag to commit once the caller has processed everything.
        A walk that hits max_pages with a next link still set clears that etag: saving it would
        304 the rest of a same-second tie that did not fit in the cap. The next poll starts at page 1
        again. While the tie stays longer than the cap, that restart refetches the same pages and
        the tail stays out until a poll fits inside the cap."""
        st, data, etag, nxt = c.rest(path, dict(params, per_page=100), etag=self.st["etags"].get(key), essential=essential)
        self._etag_new = etag
        if st == 304:
            self._paged_status = "not_modified"
            return
        self._paged_status = "done"
        pages = 1
        while True:
            items = data if isinstance(data, list) else (data or {}).get(params.get("_list_key", "workflow_runs"), [])
            for it in items:
                if stop and stop(it):
                    return
                yield it
            if not nxt or pages >= max_pages:
                if nxt and pages >= max_pages:
                    self._etag_new = None
                    self._paged_status = "capped"
                return
            st, data, _, nxt = c.rest(nxt, essential=essential)
            pages += 1

    def mark_ci(self, sha, date, done=False, pr=None):
        ci = self.st["ci"].get(sha)
        if ci is None:
            ci = self.st["ci"][sha] = {"date": date, "done": done, "last": 0}
        elif done:
            ci["done"] = True
        if pr is not None:
            ci["pr"] = pr

    # ---------------------------------------------------------------- CI (shared GraphQL / REST mapping)
    def ci_from_commit_node(self, cm):
        sha, date = cm["oid"], cm["committedDate"]
        suites = (cm.get("checkSuites") or {}).get("nodes") or []
        incomplete = False
        truncated = (cm.get("checkSuites") or {}).get("totalCount", 0) > len(suites)
        for s in suites:
            app = ((s.get("app") or {}).get("slug")) or "app"
            if s.get("status") != "COMPLETED":
                incomplete = True
            self.put(f"{self.repo}:suite:{s['databaseId']}", s.get("createdAt"), "CI", "GitHub", "check_suite",
                     f"suite {app} {(s.get('conclusion') or s.get('status') or '').lower()} · {sha[:7]}",
                     f"https://github.com/{self.repo}/commit/{sha}/checks", None, sha=sha, app=app,
                     status=(s.get("status") or "").lower(), conclusion=(s.get("conclusion") or "").lower() or None,
                     updated=s.get("updatedAt"))
            runs = s.get("checkRuns") or {}
            if runs.get("totalCount", 0) > len(runs.get("nodes") or []):
                truncated = True
            for r in runs.get("nodes") or []:
                t = r.get("completedAt") or r.get("startedAt") or s.get("createdAt")
                self.put(f"{self.repo}:checkrun:{r['databaseId']}", t, "CI", "GitHub", "check_run",
                         f"{r['name']} {(r.get('conclusion') or r.get('status') or '').lower()} · {sha[:7]}",
                         f"https://github.com/{self.repo}/commit/{sha}/checks", None, sha=sha, name=brand(r["name"]),
                         app=app, status=(r.get("status") or "").lower(),
                         conclusion=(r.get("conclusion") or "").lower() or None, suite_id=s["databaseId"])
        for ctx in ((cm.get("status") or {}).get("contexts") or []):
            self.status_event(sha, ctx["context"], ctx["state"].lower(), ctx["createdAt"], gql_login(ctx.get("creator")))
        old = time.time() - datetime.fromisoformat(date.replace("Z", "+00:00")).timestamp() > 6 * 3600
        self.mark_ci(sha, date, done=(old or not incomplete) and not truncated)
        if truncated:
            self.st["ci"][sha]["done"] = False   # REST refresh pages through everything

    def status_event(self, sha, context, state, t, creator):
        railway = creator == "railway-app[bot]"
        kind = ("deploy" if state == "success" else "deploy_pending" if state == "pending" else "deploy_fail") \
            if railway else "commit_status"
        lab = (f"deploy{'' if state == 'success' else ' ' + state.upper()} · {self.short} {sha[:7]}" if railway
               else f"status {context} {state} · {sha[:7]}")
        self.put(f"{self.repo}:status:{sha}:{context}", t, "GitHub" if railway else node(creator),
                 live_site.SITE["node"] if railway else "GitHub", kind, lab, f"https://github.com/{self.repo}/commit/{sha}",
                 None, sha=sha, context=brand(context), state=state, creator=creator)

    def ci_rest(self, c, sha):
        """Refresh one commit's suites, runs and statuses (ETag'd; 304s are free)."""
        ci = self.st["ci"][sha]
        incomplete = False
        for kind, path, lk in (() if NO_CHECKS else (
                ("suites", f"/repos/{self.repo}/commits/{sha}/check-suites", "check_suites"),
                ("runs", f"/repos/{self.repo}/commits/{sha}/check-runs", "check_runs"))):
            key = f"{kind}:{sha}"
            st, data, etag, nxt = c.rest(path, {"per_page": 100}, etag=self.st["etags"].get(key))
            if st == 304:
                if kind == "suites" and ci.get("suites_incomplete"):
                    incomplete = True
                continue
            items = list(data.get(lk, []))
            while nxt:
                _, d2, _, nxt = c.rest(nxt)
                items += d2.get(lk, [])
            if etag:
                self.st["etags"][key] = etag
            for x in items:
                if kind == "suites":
                    app = (x.get("app") or {}).get("slug") or "app"
                    if x.get("status") != "completed":
                        incomplete = True
                    self.put(f"{self.repo}:suite:{x['id']}", x.get("created_at"), "CI", "GitHub", "check_suite",
                             f"suite {app} {x.get('conclusion') or x.get('status')} · {sha[:7]}",
                             f"https://github.com/{self.repo}/commit/{sha}/checks", None, sha=sha, app=app,
                             status=x.get("status"), conclusion=x.get("conclusion"), updated=x.get("updated_at"))
                else:
                    t = x.get("completed_at") or x.get("started_at")
                    self.put(f"{self.repo}:checkrun:{x['id']}", t, "CI", "GitHub", "check_run",
                             f"{x['name']} {x.get('conclusion') or x.get('status')} · {sha[:7]}",
                             f"https://github.com/{self.repo}/commit/{sha}/checks", None, sha=sha,
                             name=brand(x["name"]), app=(x.get("app") or {}).get("slug"), status=x.get("status"),
                             conclusion=x.get("conclusion"), suite_id=(x.get("check_suite") or {}).get("id"))
            if kind == "suites":
                ci["suites_incomplete"] = incomplete
        key = f"statuses:{sha}"
        st, data, etag, _ = c.rest(f"/repos/{self.repo}/commits/{sha}/statuses", {"per_page": 100},
                                   etag=self.st["etags"].get(key))
        if st != 304:
            if etag:
                self.st["etags"][key] = etag
            seen = set()
            for s in data:   # newest first: keep the latest per context
                if s["context"] in seen:
                    continue
                seen.add(s["context"])
                self.status_event(sha, s["context"], s["state"], s["created_at"], (s.get("creator") or {}).get("login"))
        ci["last"] = time.time()
        old = time.time() - datetime.fromisoformat(ci["date"].replace("Z", "+00:00")).timestamp() > 6 * 3600
        if old or not incomplete:
            ci["done"] = True

    # ---------------------------------------------------------------- backfill (GraphQL)
    def backfill(self, c, deadline):
        bf = self.st["bf"]
        for b in MERGE_BASES:
            k = f"hist:{b}"
            while not bf.get(k + ":done") and time.time() < deadline:
                d = c.gql(Q_HISTORY, {"owner": self.owner, "name": self.name, "ref": f"refs/heads/{b}",
                                      "after": bf.get(k + ":cursor")})
                if d.get("repository") is None:
                    raise RuntimeError(f"{self.repo} not visible to token (404)")
                ref = d["repository"].get("ref")
                if not ref:   # branch absent in this repo (e.g. no develop): nothing to backfill
                    bf[k + ":done"] = True
                    bf[f"absent:{b}"] = True
                    break
                h = ref["target"]["history"]
                bf[k + ":total"] = h["totalCount"]
                for cm in h["nodes"]:
                    self.commit_event(cm["oid"], cm["committedDate"], cm["messageHeadline"], commit_login(cm), b)
                    self.ci_from_commit_node(cm)
                bf[k + ":cursor"] = h["pageInfo"]["endCursor"]
                if not h["pageInfo"]["hasNextPage"]:
                    bf[k + ":done"] = True
        k = "prs"
        while not bf.get(k + ":done") and time.time() < deadline:
            d = c.gql(Q_PRS, {"owner": self.owner, "name": self.name, "after": bf.get(k + ":cursor")})
            prs = d["repository"]["pullRequests"]
            for p in prs["nodes"]:
                n = p["number"]
                for cn in p["commits"]["nodes"]:
                    cm = cn["commit"]
                    self.pr_commit_event(n, cm["oid"], cm["committedDate"], cm["messageHeadline"], commit_login(cm))
                    self.ci_from_commit_node(cm)
                    self.st["ci"][cm["oid"]]["pr"] = n
                for r in p["reviews"]["nodes"]:
                    self.review_event(n, r["databaseId"], r["state"], r.get("submittedAt"), gql_login(r.get("author")),
                                      r.get("url"))
                need = p["commits"]["totalCount"] > len(p["commits"]["nodes"]) or \
                    p["reviews"]["totalCount"] > len(p["reviews"]["nodes"])
                if need:   # page the rest through REST
                    self.st.setdefault("enrich", {})[str(n)] = True
            bf[k + ":cursor"] = prs["pageInfo"]["endCursor"]
            if not prs["pageInfo"]["hasNextPage"]:
                bf[k + ":done"] = True
        return all(bf.get(f"hist:{b}:done") for b in MERGE_BASES) and bf.get("prs:done")

    # ---------------------------------------------------------------- event builders
    def commit_event(self, sha, date, msg, login, branch):
        eid = f"{self.repo}:commit:{sha}"
        cur = self.ev.get(eid)
        branches = sorted(set((cur or {}).get("branches", [])) | {branch})
        self.st["branch_shas"].setdefault(branch, {})[sha] = 1
        m = brand((msg or "").splitlines()[0] if msg else "")[:72]
        self.put(eid, date, node(login), "GitHub", "commit", f"{'/'.join(branches)} {sha[:7]} · {m}",
                 f"https://github.com/{self.repo}/commit/{sha}", None, sha=sha, branches=branches, message=m,
                 author=login, seat_trailer=seat_trailer(msg))

    def pr_commit_event(self, n, sha, date, msg, login):
        m = brand((msg or "").splitlines()[0] if msg else "")[:72]
        self.put(f"{self.repo}#{n}:commit:{sha}", date, node(login), "GitHub", "pr_commit",
                 f"{self.short} #{n} push {sha[:7]} · {m}", f"https://github.com/{self.repo}/pull/{n}/commits/{sha}",
                 n, sha=sha, message=m, author=login, seat_trailer=seat_trailer(msg))

    def review_event(self, n, rid, state, t, login, url):
        if not t or state == "PENDING":
            return
        self.put(f"{self.repo}#{n}:review:{rid}", t, node(login), self.pr_node(n), "review",
                 f"{login or '?'} {state.lower()} · {self.short} #{n}", url or f"https://github.com/{self.repo}/pull/{n}",
                 n, state=state, actor=login, sha=(self.st.get("prs") or {}).get(str(n), {}).get("head"))

    # ---------------------------------------------------------------- incremental (REST)
    def pr_merged(self, n):
        p = self.st["prs"].get(str(n))
        return True if p and p.get("merged_at") else None

    def _stamp_merger(self, n, login):
        """Remember who merged #n and write it onto the stored merged event. The author is not a merger."""
        if not isinstance(login, str) or not login.strip():
            return
        login = login.strip()
        self.st.setdefault("mergers", {})[str(n)] = login
        self.st.setdefault("need_merger", {}).pop(str(n), None)
        e = self.ev.get(f"{self.repo}#{int(n)}:merged")
        if not e:
            return
        e["merged_by"] = login
        e["actor"] = login
        who = node(login)
        if who != "Others":
            e["from"] = who
        e["credit"] = self.credit_of(e)

    def _needs_pull_merger(self, e):
        """A merge still needs GET /pulls/:n when merged_by is missing or is only the PR author."""
        if e.get("kind") != "merged" or e.get("number") is None:
            return False
        mb = e.get("merged_by")
        if not isinstance(mb, str) or not mb.strip():
            return True
        author = e.get("author")
        return isinstance(author, str) and mb.strip() == author.strip()

    def queue_merger_backfill(self):
        """Once: every stored merge with no merger, or with the author in that field, is fetched.

        The first backfill flag stays set after a pass that left the author in merged_by.
        merged_by_pull runs the correction."""
        if self.st.setdefault("bf", {}).get("merged_by_pull"):
            return
        need = self.st.setdefault("need_merger", {})
        tried = self.st.setdefault("merger_tried", {})
        for e in self.ev.values():
            if not self._needs_pull_merger(e):
                continue
            key = str(e["number"])
            need[key] = 1
            tried.pop(key, None)
        self.st["bf"]["merged_by_pull"] = True

    def ensure_pull_card(self, p):
        """A fetched pull is a card even when the list walk never stored pr_open."""
        if not isinstance(p, dict) or p.get("number") is None:
            return
        try:
            n = int(p["number"])
        except (TypeError, ValueError):
            return
        eid = f"{self.repo}#{n}:open"
        if eid in self.ev:
            return
        user = p.get("user") if isinstance(p.get("user"), dict) else {}
        login = user.get("login") or ""
        head_obj = p.get("head") if isinstance(p.get("head"), dict) else {}
        head = head_obj.get("sha") if isinstance(head_obj.get("sha"), str) else None
        head_ref = head_obj.get("ref").strip() if isinstance(head_obj.get("ref"), str) and head_obj.get("ref").strip() else None
        url = p.get("html_url") or f"https://github.com/{self.repo}/pull/{n}"
        created = p.get("created_at") or p.get("updated_at")
        base = (p.get("base") or {}).get("ref") if isinstance(p.get("base"), dict) else None
        self.put(eid, created, node(login) if login else "GitHub", "GitHub", "pr_open",
                 f"{self.short} #{n} opened · {p.get('title') or ''}", url, n,
                 base=base, actor=login or None, sha=head, head_ref=head_ref, author=login or None,
                 draft=p.get("draft"), mentions=mentions(p.get("body")), **card_fields(p))

    def _try_pull_card(self, p):
        """Write the open card. A bad created_at must not skip the merger stamp or the rest of the batch."""
        try:
            self.ensure_pull_card(p)
        except (ValueError, TypeError, KeyError, AttributeError):
            return

    def backfill_mergers(self, c, limit=20):
        """GET /pulls/{n} and stamp merged_by.login. The author is never the stamp. A list payload often omits it."""
        if not getattr(c, "token", None):
            return
        self.queue_merger_backfill()
        tried = self.st.setdefault("merger_tried", {})
        need = self.st.setdefault("need_merger", {})
        todo = [n for n in list(need) if str(n) not in tried][:limit]
        for n in todo:
            tried[str(n)] = True
            try:
                _st, data, _, _ = c.rest(f"/repos/{self.repo}/pulls/{n}", {}, essential=False)
            except RateLow:
                tried.pop(str(n), None)
                raise
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError, KeyError, TypeError):
                continue
            if isinstance(data, dict):
                self._try_pull_card(data)
            login = ((data or {}).get("merged_by") or {}).get("login") if isinstance(data, dict) else None
            if login:
                self._stamp_merger(int(n), login)

    def poll_pulls(self, c):
        if not getattr(c, "token", None):
            return
        cur = self.st["cur"].get("pulls")
        author_seat = False
        # One-time: a collector that already walked pulls stored one # from each Closes line and never
        # saw a git author named mill. Rewind three days, drop the etag, and enrich those pulls again.
        if cur and not self.st["bf"].get("author:seat"):
            back = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
            cur = min(cur, back)
            self.st["etags"].pop("pulls", None)
            self.st["bf"]["author:seat"] = True
            author_seat = True
        elif not self.st["bf"].get("author:seat"):
            self.st["bf"]["author:seat"] = True
        # One-time: pulls merged while the cursor sat past them never stored a merged event.
        # Rewind 36h so the open 24h window is walked again. put() is idempotent.
        if cur and not self.st["bf"].get("merged:day"):
            back = (datetime.now(timezone.utc) - timedelta(hours=36)).strftime("%Y-%m-%dT%H:%M:%SZ")
            cur = min(cur, back)
            self.st["etags"].pop("pulls", None)
            self.st["bf"]["merged:day"] = True
        elif not self.st["bf"].get("merged:day"):
            self.st["bf"]["merged:day"] = True
        # One-time: merges whose actor maps to Others were dropped by put(). Rewalk the open window.
        # merged:actor is that rewalk's cursor. A short pass (page cap or error) must not set it,
        # or the next pass will not rewind and a merge behind the new pulls cursor is skipped for good.
        actor_rewalk = not self.st["bf"].get("merged:actor")
        if cur and actor_rewalk:
            back = (datetime.now(timezone.utc) - timedelta(hours=36)).strftime("%Y-%m-%dT%H:%M:%SZ")
            cur = min(cur, back)
            self.st["etags"].pop("pulls", None)
        newest = cur
        # Replay a pull that shares the cursor second. put() is idempotent.
        # Instant compare, not text: <= skips that sibling, and +00:00 / -05:00 sort before Z.
        for p in self.paged(c, f"/repos/{self.repo}/pulls", {"state": "all", "sort": "updated", "direction": "desc"},
                            "pulls", stop=lambda p: gh_before(p.get("updated_at"), cur)):
            n = p["number"]
            # A pull with user null is still a card. Subscripting it raised TypeError, which run()
            # does not catch, so every later pull on the page was dropped and the cursor never moved.
            user = p.get("user") if isinstance(p.get("user"), dict) else {}
            login = user.get("login") or ""
            prev = self.st["prs"].get(str(n), {})
            prev_head = prev.get("head")
            head_obj = p.get("head") if isinstance(p.get("head"), dict) else {}
            head = head_obj.get("sha") if isinstance(head_obj.get("sha"), str) else None
            head_ref = head_obj.get("ref").strip() if isinstance(head_obj.get("ref"), str) and head_obj.get("ref").strip() else None
            self.st["prs"][str(n)] = {"author": login or None, "updated_at": p["updated_at"], "head": head,
                                      "merged_at": p.get("merged_at"), "state": p["state"], "base": p["base"]["ref"]}
            url = p["html_url"]
            fields = card_fields(p)
            if not fields.get("packet_file") and head and packet_file_on_ref(c, self.repo, head):
                fields["packet_file"] = True
            self.put(f"{self.repo}#{n}:open", p["created_at"], node(login) if login else "GitHub", "GitHub", "pr_open",
                     f"{self.short} #{n} opened · {p['title']}", url, n, base=p["base"]["ref"], actor=login or None,
                     sha=head, head_ref=head_ref, author=login or None,
                     draft=p.get("draft"), mentions=mentions(p.get("body")), **fields)
            if p.get("merged_at"):
                listed = p.get("merged_by") if isinstance(p.get("merged_by"), dict) else None
                listed_login = (listed or {}).get("login")
                listed_login = listed_login.strip() if isinstance(listed_login, str) and listed_login.strip() else None
                stored = (self.st.get("mergers") or {}).get(str(n))
                stored = stored.strip() if isinstance(stored, str) and stored.strip() else None
                # List pulls omit merged_by. A stored login that is only the author is not the merger.
                merger = listed_login or (None if stored == login else stored)
                extra = {"base": p["base"]["ref"], "merge_sha": p.get("merge_commit_sha"),
                         "actor": merger or login, "author": login}
                if merger:
                    extra["merged_by"] = merger
                else:
                    self.st.setdefault("need_merger", {})[str(n)] = 1
                self.put(f"{self.repo}#{n}:merged", p["merged_at"], node(merger or login), "GitHub", "merged",
                         f"merged {self.short} #{n} → {p['base']['ref']}", url, n, **extra)
            if prev_head and head and prev_head != head:
                self.pr_commit_event(n, head, p["updated_at"], p.get("title") or "", login)
                self.st.setdefault("enrich", {})[str(n)] = True
            if author_seat or (self.st["bf"].get("prs:done") and prev.get("updated_at") != p["updated_at"]):
                self.st.setdefault("enrich", {})[str(n)] = True
            if gh_after(p.get("updated_at"), newest):
                newest = p["updated_at"]
        self.st["cur"]["pulls"] = newest
        if self._etag_new:
            self.st["etags"]["pulls"] = self._etag_new
        if actor_rewalk and getattr(self, "_paged_status", None) == "done":
            self.st["bf"]["merged:actor"] = True

    def enrich_prs(self, c, limit=20):
        todo = list(self.st.get("enrich", {}).keys())[:limit]
        for n in todo:
            for r in self._all(c, f"/repos/{self.repo}/pulls/{n}/reviews"):
                self.review_event(int(n), r["id"], r["state"], r.get("submitted_at"), (r.get("user") or {}).get("login"),
                                  r.get("html_url"))
            for cm in self._all(c, f"/repos/{self.repo}/pulls/{n}/commits"):
                d = cm["commit"]["committer"]["date"]
                self.pr_commit_event(int(n), cm["sha"], d, cm["commit"]["message"], rest_author_login(cm))
                self.mark_ci(cm["sha"], d, pr=int(n))
            self.st["enrich"].pop(n, None)

    def _all(self, c, path, params=None):
        st, data, _, nxt = c.rest(path, dict(params or {}, per_page=100))
        out = list(data)
        while nxt:
            _, d, _, nxt = c.rest(nxt)
            out += d
        return out

    ISSUE_EVENT_KIND = {"labeled": "labeled", "unlabeled": "unlabeled", "assigned": "assigned",
                        "unassigned": "unassigned", "milestoned": "milestoned", "demilestoned": "demilestoned",
                        "reopened": "reopen", "renamed": "edit"}

    def _open_from_merged(self, n, e, actor, url):
        """A pull seen only as a merged issue event still gets its :open card.
        _stamp_merger drops need_merger, so the backfill path never fetches it."""
        iss = e.get("issue") if isinstance(e.get("issue"), dict) else {}
        user = iss.get("user") if isinstance(iss.get("user"), dict) else None
        if user is None and isinstance(actor, str) and actor:
            user = {"login": actor}
        pr = (self.st.get("prs") or {}).get(str(n)) or {}
        head = pr.get("head")
        base = pr.get("base")
        self._try_pull_card({
            "number": n,
            "user": user,
            "created_at": iss.get("created_at") or e.get("created_at"),
            "updated_at": iss.get("updated_at"),
            "html_url": url or iss.get("html_url"),
            "title": iss.get("title") or "",
            "head": {"sha": head} if isinstance(head, str) and head else None,
            "base": {"ref": base} if isinstance(base, str) and base else None,
            "draft": iss.get("draft"),
            "state": iss.get("state"),
            "body": iss.get("body"),
            "labels": iss.get("labels"),
        })

    def _record_merged_event(self, n, e, actor, url):
        """Store the merged beat from an issue event when pulls have not stored merged_at yet."""
        self._open_from_merged(n, e, actor, url)
        created = e.get("created_at")
        pr = self.st.setdefault("prs", {}).setdefault(str(n), {})
        if created and not pr.get("merged_at"):
            pr["merged_at"] = created
        eid = f"{self.repo}#{int(n)}:merged"
        if created and eid not in self.ev:
            login = pr.get("author")
            base = pr.get("base")
            extra = {"actor": actor or login, "author": login}
            commit_id = e.get("commit_id")
            if isinstance(commit_id, str) and commit_id:
                extra["merge_sha"] = commit_id
            if base:
                extra["base"] = base
            arrow = f" → {base}" if base else ""
            self.put(eid, created, node(actor or login), "GitHub", "merged",
                     f"merged {self.short} #{n}{arrow}", url, n, **extra)
        if actor:
            self._stamp_merger(n, actor)

    def _reopened_between(self, number, close_at, merge_at) -> bool:
        """True when a reopen sits strictly after this close and at or before the merge."""
        try:
            number = int(number)
        except (TypeError, ValueError):
            return False
        for ev in self.ev.values():
            if ev.get("kind") != "pr_reopen" or ev.get("number") != number:
                continue
            ts = gh_time(ev.get("t_ct"))
            if ts is not None and close_at < ts <= merge_at:
                return True
        return False

    def _is_merge_echo(self, number, close_raw, merge_raw) -> bool:
        """A close within 30s of the merge is the merge's own closed event.
        A close that precedes a reopen is history and stays."""
        close_at, merge_at = gh_time(close_raw), gh_time(merge_raw)
        if close_at is None or merge_at is None:
            return False
        if abs((close_at - merge_at).total_seconds()) >= 30:
            return False
        return not self._reopened_between(number, close_at, merge_at)

    def _forget_merge_close(self, n, when):
        """Drop the pr_close that echoes this merge. A close more than 30s away stays.
        A close that precedes a reopen also stays."""
        if not isinstance(when, str) or not when:
            return
        number = int(n)
        drop = [eid for eid, ev in self.ev.items()
                if ev.get("kind") == "pr_close" and ev.get("number") == number
                and self._is_merge_echo(number, ev.get("t_ct"), when)]
        for eid in drop:
            self.ev.pop(eid, None)

    def poll_issue_events(self, c):
        cur = self.st["cur"].get("ievents", 0)
        newest = cur
        for e in self.paged(c, f"/repos/{self.repo}/issues/events", {}, "ievents", stop=lambda e: e["id"] <= cur):
            newest = max(newest, e["id"])
            iss = e.get("issue") or {}
            n = iss.get("number")
            if n is None:
                continue
            is_pr = "pull_request" in iss
            pre = "pr" if is_pr else "issue"
            ev, actor = e["event"], (e.get("actor") or {}).get("login")
            url = iss.get("html_url") or f"https://github.com/{self.repo}/issues/{n}"
            eid = f"{self.repo}{'#' if is_pr else '!'}{n}:ev:{e['id']}"
            frm, tag = node(actor), f"{self.short} {'#' if is_pr else 'issue #'}{n}"
            if ev == "closed":
                if is_pr:
                    pr = self.st["prs"].get(str(n), {})
                    if pr.get("merged_at") and self._is_merge_echo(n, e.get("created_at"), pr.get("merged_at")):
                        continue   # the close that echoes the merge, not an earlier close before a reopen
                    author = (self.st["prs"].get(str(n)) or {}).get("author")
                    self.put(eid, e["created_at"], frm, "GitHub", "pr_close", f"closed {tag} unmerged", url, n,
                             actor=actor, author=author)
                else:
                    sr = e.get("state_reason") or iss.get("state_reason")
                    self.put(eid, e["created_at"], frm, "GitHub", "issue_close", f"closed {tag} ({sr or 'closed'})",
                             url, n, actor=actor, state_reason=sr)
            elif ev == "merged":
                self._record_merged_event(n, e, actor, url)
                self._forget_merge_close(n, e.get("created_at"))
                continue
            elif ev in ("ready_for_review", "convert_to_draft") and is_pr:
                k = "pr_ready" if ev == "ready_for_review" else "pr_draft"
                self.put(eid, e["created_at"], frm, "GitHub", k,
                         f"{tag} {'ready for review' if k == 'pr_ready' else 'converted to draft'}", url, n, actor=actor,
                         sha=(self.st.get("prs") or {}).get(str(n), {}).get("head"))
            elif ev in ("review_requested", "review_request_removed") and is_pr:
                who = (e.get("requested_reviewer") or {}).get("login") or (e.get("requested_team") or {}).get("name")
                k = "pr_review_requested" if ev == "review_requested" else "pr_review_request_removed"
                self.put(eid, e["created_at"], frm, node(who) if who else "GitHub", k,
                         f"{tag} review {'requested' if k.endswith('requested') else 'request removed'}: {who}",
                         url, n, actor=actor, reviewer=who)
                if ev == "review_requested":
                    self.st.setdefault("enrich", {})[str(n)] = True   # re-read reviews on the next enrich pass
            elif ev == "base_ref_changed" and is_pr:
                self.put(eid, e["created_at"], frm, "GitHub", "pr_edit", f"{tag} base changed", url, n, actor=actor,
                         change="base")
            elif ev == "head_ref_force_pushed" and is_pr:
                head = (self.st["prs"].get(str(n)) or {}).get("head")
                self.put(eid, e["created_at"], frm, "GitHub", "pr_force_push", f"{tag} force-pushed", url, n,
                         actor=actor, sha=head)
            elif ev in self.ISSUE_EVENT_KIND:
                k = self.ISSUE_EVENT_KIND[ev]
                detail = {"labeled": (e.get("label") or {}).get("name"), "unlabeled": (e.get("label") or {}).get("name"),
                          "assigned": (e.get("assignee") or {}).get("login"),
                          "unassigned": (e.get("assignee") or {}).get("login"),
                          "milestoned": (e.get("milestone") or {}).get("title"),
                          "demilestoned": (e.get("milestone") or {}).get("title")}.get(ev)
                word = {"reopen": "reopened", "edit": "title edited"}.get(k, k)
                self.put(eid, e["created_at"], frm, "GitHub", f"{pre}_{k}",
                         f"{tag} {word}" + (f": {detail}" if detail else ""), url, n, actor=actor,
                         detail=brand(detail) if detail else None, change="title" if k == "edit" else None)
            else:
                self.put(eid, e["created_at"], frm, "GitHub", f"{pre}_activity", f"{tag} {ev.replace('_', ' ')}",
                         url, n, actor=actor, event=ev)
        self.st["cur"]["ievents"] = newest
        if self._etag_new:
            self.st["etags"]["ievents"] = self._etag_new

    def poll_issues(self, c):
        cur = self.st["cur"].get("issues")
        newest = cur
        for i in self.paged(c, f"/repos/{self.repo}/issues", {"state": "all", "sort": "updated", "direction": "desc"},
                            "issues", stop=lambda i: gh_before(i.get("updated_at"), cur)):
            if gh_after(i.get("updated_at"), newest):
                newest = i["updated_at"]
            if "pull_request" in i:
                continue
            n, login = i["number"], (i.get("user") or {}).get("login")
            if login:
                self.st.setdefault("issues", {})[str(n)] = login
            self.put(f"{self.repo}!{n}:open", i["created_at"], node(login), "GitHub", "issue_open",
                     f"{self.short} issue #{n} opened · {i['title']}", i["html_url"], n, actor=login,
                     mentions=mentions(i.get("body")), **card_fields(i))
        self.st["cur"]["issues"] = newest
        if self._etag_new:
            self.st["etags"]["issues"] = self._etag_new

    def poll_comments(self, c):
        cur = self.st["cur"].get("comments")
        if not self.st["bf"].get("comments:critic3"):   # one-time: re-read 14 days of comments (Parked: flags, Reviewer verdicts)
            back = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%dT%H:%M:%SZ")
            cur = min(cur, back) if cur else cur
            self.st["etags"].pop("comments", None)       # else page 1 answers 304 and nothing is re-read
            self.st["bf"]["comments:critic3"] = True
        if not self.st["bf"].get("comments:cursorbot"):   # one-time: re-read comments from the start of today
            start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            back = start.strftime("%Y-%m-%dT%H:%M:%SZ")
            cur = min(cur, back) if cur else cur
            self.st["etags"].pop("comments", None)
            self.st["bf"]["comments:cursorbot"] = True
        newest = self.st["cur"].get("comments")
        for cm in self.paged(c, f"/repos/{self.repo}/issues/comments", {"sort": "updated", "direction": "desc"},
                             "comments", stop=lambda x: gh_before(x.get("updated_at"), cur)):
            if gh_after(cm.get("updated_at"), newest):
                newest = cm["updated_at"]
            n = int(cm["issue_url"].rsplit("/", 1)[1])
            is_pr = "/pull/" in cm["html_url"]
            login = (cm.get("user") or {}).get("login")
            body = cm.get("body") or ""
            hold = live_packet.parse_hold(body)
            k = "pr_comment" if is_pr else "issue_comment"
            to = self.pr_node(n) if is_pr else self.issue_node(n)
            self.put(f"{self.repo}{'#' if is_pr else '!'}{n}:comment:{cm['id']}", cm["created_at"], node(login), to, k,
                     f"{login or '?'} comment · {self.short} {'#' if is_pr else 'issue #'}{n}", cm["html_url"], n,
                     actor=login, resolved=True if RESOLVED_RE.search(body) else None,   # flags only
                     parked=True if PARKED_COMMENT_RE.match(body) else None,
                     start_after=comment_start_after(body),
                     hold=hold, mentions=mentions(body), pr_merged=self.pr_merged(n) if is_pr else None)
            if is_pr:
                self.st.setdefault("enrich", {})[str(n)] = True   # a comment is a reason to re-read reviews
            if is_pr and login in CRITIC_LOGINS:   # verdict word + SHA only; the body is discarded here
                body = (cm.get("body") or "").lstrip()
                m = CRITIC_RE.match(body)
                if m:
                    sm = SHA_RE.search(body.splitlines()[0])
                    verdict, result = (m.group(1), None) if m.group(1) else ("RE-CHECK", m.group(2))
                    prev = self.st["reviewer"].get(str(n))
                    if prev is None or [cm["created_at"], cm["id"]] > [prev["t"], prev["id"]]:
                        self.st["reviewer"][str(n)] = {"t": cm["created_at"], "id": cm["id"], "verdict": verdict,
                                                     "result": result, "sha": sm.group(1) if sm else None,
                                                     "url": cm["html_url"]}
        self.st["cur"]["comments"] = newest
        if self._etag_new:
            self.st["etags"]["comments"] = self._etag_new
        for n, v in self.st["reviewer"].items():   # latest verdict per PR, stable id
            word = v["result"] or v["verdict"]
            kind = {"PASS": "critic_pass", "FAIL": "critic_fail", "HOLD": "critic_hold"}.get(word, "critic_recheck")
            shown = (f"re-check {v['result']}" if v["result"] else "re-check") if v["verdict"] == "RE-CHECK" else v["verdict"]
            self.put(f"{self.repo}#{n}:reviewer", v["t"], "Reviewer", self.pr_node(n), kind,
                     f"reviewer {shown} · {self.short} #{n}" + (f" @ {v['sha'][:7]}" if v["sha"] else ""), v["url"], n,
                     verdict=v["verdict"], recheck_result=v["result"], sha=v["sha"])

    def poll_review_comments(self, c):
        cur = self.st["cur"].get("rcomments")
        newest = cur
        for cm in self.paged(c, f"/repos/{self.repo}/pulls/comments", {"sort": "updated", "direction": "desc"},
                             "rcomments", stop=lambda x: gh_before(x.get("updated_at"), cur)):
            if gh_after(cm.get("updated_at"), newest):
                newest = cm["updated_at"]
            n = int(cm["pull_request_url"].rsplit("/", 1)[1])
            login = (cm.get("user") or {}).get("login")
            self.put(f"{self.repo}#{n}:rcomment:{cm['id']}", cm["created_at"], node(login), self.pr_node(n),
                     "review_comment", f"{login or '?'} review comment · {self.short} #{n}", cm["html_url"], n,
                     actor=login, mentions=mentions(cm.get("body")), pr_merged=self.pr_merged(n))
        if newest is None and self._etag_new:   # empty list: pin so a later 200 cannot re-walk history
            newest = "1970-01-01T00:00:00Z"
        self.st["cur"]["rcomments"] = newest
        if self._etag_new:
            self.st["etags"]["rcomments"] = self._etag_new

    def poll_pushes(self, c):
        """Repo /events PushEvent poll: a push on a branch with no PR (fetch_feed.push_events).

        Heads already stored as a commit, a PR head, or an earlier push are skipped, so a merge
        or a PR update is not counted twice. live-wire stays on the tripwire ledger."""
        cur = self.st["cur"].get("pushes")
        newest = cur
        known = set()
        for e in self.ev.values():
            sha = e.get("sha") or e.get("head_sha")
            if isinstance(sha, str) and e.get("kind") in ("commit", "pr_commit", "push", "merged"):
                known.add(sha)
        for pr in (self.st.get("prs") or {}).values():
            head = pr.get("head") if isinstance(pr, dict) else None
            if isinstance(head, str) and head:
                known.add(head)
        for e in self.paged(c, f"/repos/{self.repo}/events", {}, "pushes",
                            stop=lambda ev: gh_before(ev.get("created_at"), cur)):
            t = e.get("created_at")
            if gh_after(t, newest):
                newest = t
            if e.get("type") != "PushEvent":
                continue
            p = e.get("payload") or {}
            ref = p.get("ref") or ""
            branch = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ""
            head = p.get("head") or ""
            if not branch or branch in PUSH_SKIP_BRANCHES or not head or not t or head in known:
                continue
            login = (e.get("actor") or {}).get("login")
            commits = p.get("commits") or []
            msg = next((cmt.get("message") for cmt in commits if cmt.get("sha") == head), None)
            if msg is None and commits:
                msg = commits[-1].get("message")
            msg = ((msg or "").splitlines() or [""])[0][:72]
            self.put(f"{self.repo}:push:{e['id']}", t, node(login), "GitHub", "push",
                     f"pushed {self.short} {branch} · {brand(msg)}",
                     f"https://github.com/{self.repo}/commit/{head}", None,
                     sha=head, branch=branch, author=login, message=brand(msg) if msg else None)
            known.add(head)
        self.st["cur"]["pushes"] = newest
        if self._etag_new:
            self.st["etags"]["pushes"] = self._etag_new

    def poll_commits(self, c):
        for b in MERGE_BASES:
            if self.st["bf"].get(f"absent:{b}"):   # branch missing in this repo (e.g. no develop): no 404 every pass
                continue
            known = self.st["branch_shas"].setdefault(b, {})
            try:
                for cm in self.paged(c, f"/repos/{self.repo}/commits", {"sha": b}, f"commits:{b}",
                                     stop=lambda x: x["sha"] in known):
                    d = cm["commit"]["committer"]["date"]
                    self.commit_event(cm["sha"], d, cm["commit"]["message"], (cm.get("author") or {}).get("login")
                                      or (cm["commit"]["author"]["name"] if cm["commit"]["author"]["name"].endswith("[bot]") else None), b)
                    self.mark_ci(cm["sha"], d)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                self.st["bf"][f"absent:{b}"] = True
                continue
            if self._etag_new:
                self.st["etags"][f"commits:{b}"] = self._etag_new

    def poll_runs(self, c):
        cur = self.st["cur"].get("runs_max_id", 0)
        newest = cur
        backfilled = self.st["bf"].get("runs:done")
        st, data, etag, nxt = c.rest(f"/repos/{self.repo}/actions/runs", {"per_page": 100},
                                     etag=self.st["etags"].get("runs"))
        if st == 304:
            return
        pages = 1
        while True:
            for r in data.get("workflow_runs", []):
                newest = max(newest, r["id"])
                self.put(f"{self.repo}:run:{r['id']}", r.get("run_started_at") or r["created_at"], "CI", "GitHub",
                         "workflow_run", f"run {r['name']} · {r.get('head_branch') or '?'} · {r.get('conclusion') or r['status']}",
                         r["html_url"], None, name=brand(r["name"]), event=r["event"], branch=r.get("head_branch"),
                         status=r["status"], conclusion=r.get("conclusion"), run_number=r.get("run_number"),
                         head_sha=r.get("head_sha"), updated=r.get("updated_at"), actor=(r.get("actor") or {}).get("login"))
                prs = r.get("pull_requests") or []
                first = prs[0] if prs and isinstance(prs[0], dict) else None
                num = first.get("number") if first else None
                ck = ci_result_kind(r.get("conclusion"), r.get("status"))
                if ck and num is not None:
                    self.put(f"{self.repo}#{int(num)}:ci:{r['id']}",
                             r.get("updated_at") or r.get("run_started_at") or r["created_at"], "CI", "GitHub", ck,
                             f"{'CI pass' if ck == 'ci_pass' else 'CI fail'} {brand(r['name'])} · {self.short} #{num}",
                             r["html_url"], int(num), conclusion=r.get("conclusion"), head_sha=r.get("head_sha"),
                             name=brand(r["name"]))
                if NO_CHECKS and r.get("check_suite_id"):
                    self.suite_from_run(r)
                recent = r.get("head_sha") and time.time() - datetime.fromisoformat(
                    r["created_at"].replace("Z", "+00:00")).timestamp() < JOBS_WINDOW_S
                if recent:
                    self.mark_ci(r["head_sha"], r["created_at"])   # history comes from the GraphQL backfill
                    if NO_CHECKS:
                        self.st.setdefault("jobs", {}).setdefault(str(r["id"]), {})
                        self.st["jobs"][str(r["id"])].update(sha=r["head_sha"], created=r["created_at"],
                                                             suite=r.get("check_suite_id"), status=r["status"])
            # backfill: every page once; afterwards page 1 only (ETag refreshes in-progress runs)
            if not nxt or (backfilled and pages >= 1):
                break
            st, data, _, nxt = c.rest(nxt)
            pages += 1
        self.st["bf"]["runs:done"] = True
        self.st["cur"]["runs_max_id"] = newest
        if etag:
            self.st["etags"]["runs"] = etag

    def suite_from_run(self, r):
        """Actions workflow run == its check suite (check_suite_id): same id/kind as the Checks API mapping."""
        sha = r.get("head_sha") or ""
        self.put(f"{self.repo}:suite:{r['check_suite_id']}", r["created_at"], "CI", "GitHub", "check_suite",
                 f"suite github-actions {r.get('conclusion') or r['status']} · {sha[:7]}",
                 f"https://github.com/{self.repo}/commit/{sha}/checks", None, sha=sha, app="github-actions",
                 status=r["status"], conclusion=r.get("conclusion"), updated=r.get("updated_at"), derived="actions-run")

    def poll_jobs(self, c):
        """Actions jobs of recent runs -> check_run events (job id == check run id). ETag'd; stop once completed."""
        jobs, now = self.st.setdefault("jobs", {}), time.time()
        for rid, j in list(jobs.items()):
            try:
                age = now - datetime.fromisoformat(j["created"].replace("Z", "+00:00")).timestamp()
            except (KeyError, ValueError, AttributeError):
                age = 1e9
            if age > JOBS_WINDOW_S:
                jobs.pop(rid, None); self.st["etags"].pop(f"jobs:{rid}", None)
                continue
            if j.get("done"):
                continue
            st, data, etag, nxt = c.rest(f"/repos/{self.repo}/actions/runs/{rid}/jobs", {"per_page": 100},
                                         etag=self.st["etags"].get(f"jobs:{rid}"))
            if st == 304:
                continue
            items = list(data.get("jobs", []))
            while nxt:
                _, d2, _, nxt = c.rest(nxt)
                items += d2.get("jobs", [])
            if etag:
                self.st["etags"][f"jobs:{rid}"] = etag
            sha = j.get("sha") or ""
            for x in items:
                t = x.get("completed_at") or x.get("started_at") or x.get("created_at")
                self.put(f"{self.repo}:checkrun:{x['id']}", t, "CI", "GitHub", "check_run",
                         f"{x['name']} {x.get('conclusion') or x.get('status')} · {sha[:7]}",
                         f"https://github.com/{self.repo}/commit/{sha}/checks", None, sha=sha,
                         name=brand(x["name"]), app="github-actions", status=x.get("status"),
                         conclusion=x.get("conclusion"), suite_id=j.get("suite"), derived="actions-job")
            if j.get("status") == "completed" and items and all(x.get("status") == "completed" for x in items):
                j["done"] = True

    def poll_tags_releases(self, c):
        if time.time() - self.st["cur"].get("tags_last", 0) < 600:
            return
        st, data, etag, _ = c.rest(f"/repos/{self.repo}/tags", {"per_page": 100}, etag=self.st["etags"].get("tags"))
        if st != 304:
            for tg in data:
                sha = tg["commit"]["sha"]
                if sha not in self.st["tag_time"]:
                    _, cm, _, _ = c.rest(f"/repos/{self.repo}/commits/{sha}")
                    self.st["tag_time"][sha] = cm["commit"]["committer"]["date"]
                self.put(f"{self.repo}:tag:{tg['name']}", self.st["tag_time"][sha], "GitHub", live_site.SITE["node"], "tag",
                         f"tag {tg['name']} · {sha[:7]}", f"https://github.com/{self.repo}/releases/tag/{tg['name']}",
                         None, tag=brand(tg["name"]), sha=sha, time_basis="tagged commit date")
            if etag:
                self.st["etags"]["tags"] = etag
        st, data, etag, _ = c.rest(f"/repos/{self.repo}/releases", {"per_page": 100}, etag=self.st["etags"].get("releases"))
        if st != 304:
            for r in data:
                self.put(f"{self.repo}:release:{r['id']}", r.get("published_at") or r["created_at"], node((r.get("author") or {}).get("login")),
                         "GitHub", "release", f"release {r.get('tag_name')} · {r.get('name') or ''}", r["html_url"], None,
                         tag=r.get("tag_name"), name=brand(r.get("name")), draft=r.get("draft"), prerelease=r.get("prerelease"))
            if etag:
                self.st["etags"]["releases"] = etag
        self.st["cur"]["tags_last"] = time.time()

    def poll_deployments(self, c):
        if time.time() - self.st["gaps"].get("deployments_checked", 0) < 3600:
            return
        try:
            c.rest(f"/repos/{self.repo}/deployments", {"per_page": 1})
            self.st["gaps"]["deployments"] = None
        except urllib.error.HTTPError as e:
            self.st["gaps"]["deployments"] = f"HTTP {e.code} (token has no deployments permission; not widened)"
        self.st["gaps"]["deployments_checked"] = time.time()

    def refresh_ci(self, c, deadline, limit=6):
        """Incremental: only a few recent incomplete SHAs per pass. Older open CI is marked done
        (one last check if never polled, else just closed) so a pass stays well under 60s."""
        now = time.time()
        recent, stale = [], []
        for sha, v in self.st["ci"].items():
            if v.get("done"):
                continue
            try:
                age = now - datetime.fromisoformat(v["date"].replace("Z", "+00:00")).timestamp()
            except (KeyError, ValueError, TypeError):
                age = 1e9
            if age > 2 * 3600:          # cold history: do not keep re-polling
                stale.append(sha)
            elif now - v.get("last", 0) > 90:
                recent.append(sha)
        for sha in stale:               # drop from the open set (ci_rest would also mark done by age)
            self.st["ci"][sha]["done"] = True
        recent.sort(key=lambda s: self.st["ci"][s].get("date") or "", reverse=True)
        for sha in recent[:limit]:
            if time.time() > deadline:
                break
            self.ci_rest(c, sha)

    def note_denied(self, err, name=""):
        """403/404 on a per-repo read. A missing branch (commits 404) and the deployments-permission
        probe are not this: those are optional resources, and the probe already records a gap."""
        if name in ("deployments",):
            return
        code = getattr(err, "code", None)
        if code in (403, 404):
            self._denied = int(code)

    # ---------------------------------------------------------------- one pass
    def run(self, c, deadline):
        self._denied = None
        steps = [("pulls", self.poll_pulls), ("issues", self.poll_issues), ("issue events", self.poll_issue_events),
                 ("merger backfill", self.backfill_mergers),
                 ("comments", self.poll_comments), ("review comments", self.poll_review_comments),
                 ("pushes", self.poll_pushes),
                 ("runs", self.poll_runs)] + ([("jobs", self.poll_jobs)] if NO_CHECKS else []) + [
                 ("tags/releases", self.poll_tags_releases),
                 ("deployments", self.poll_deployments)]
        for name, fn in steps:
            try:
                fn(c)
            except RateLow as e:
                self.log(f"{self.short}: {name} deferred ({e})")
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError, KeyError) as e:
                self.note_denied(e, name)
                self.log(f"{self.short}: {name} failed ({type(e).__name__}: {str(e)[:80]}); keeping stored events")
        try:
            done = self.backfill(c, deadline)
        except (RateLow, RuntimeError, urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, KeyError,
                TypeError) as e:
            done = False
            self.note_denied(e, "backfill")
            self.log(f"{self.short}: backfill paused ({type(e).__name__}: {str(e)[:100]})")
        if done:
            for name, fn in (("commits", self.poll_commits), ("pr enrich", self.enrich_prs),
                             ("ci refresh", lambda c: self.refresh_ci(c, deadline))):
                try:
                    fn(c)
                except RateLow as e:
                    self.log(f"{self.short}: {name} deferred ({e})")
                except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError, KeyError) as e:
                    self.note_denied(e, name)
                    self.log(f"{self.short}: {name} failed ({type(e).__name__}: {str(e)[:80]})")
        self.unreadable = self.repo if self._denied else None
        self.save()
        return done
