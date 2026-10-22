"""Which pending deploy statuses are still work holds.

A pending status raises a hold only when its sha is the tip of a branch and the status is
younger than DEPLOY_PENDING_STALE_S (default 30 minutes). A pending status older than that
window is dropped when a newer deploy success, a lab retest PASS, or a later error, failure,
or inactive status exists for the same sha, or for a later sha on that branch. A pending
status that old with no such proof is a stale-status gap, not a hold. A pending on a commit
that is not a branch tip is not a hold, and a later deploy drops it instead of leaving a
stale gap.
"""
import os
import re
from datetime import datetime

_HEX = re.compile(r"^[0-9a-f]{7,40}$")
_PROVE_KINDS = {"check_run", "workflow_run", "check_suite", "commit_status", "ci_pass"}
_PROVE_STATES = {"success", "passed", "pass", "error", "failure", "inactive"}


def stale_seconds():
    raw = os.environ.get("DEPLOY_PENDING_STALE_S", "1800")
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return 1800.0
    return n if n >= 0 else 1800.0


def _ts(value):
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        return value.timestamp()
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _now(now):
    if now is None:
        return datetime.now().timestamp()
    return _ts(now)


def _sha(event):
    raw = str((event or {}).get("sha") or (event or {}).get("head_sha") or "").strip().lower()
    return raw if _HEX.match(raw) else ""


def _same(left, right):
    if not left or not right:
        return False
    return left.startswith(right) or right.startswith(left)


def _repo(event):
    return str((event or {}).get("repo") or "").lower()


def _branches(event):
    raw = event.get("branches")
    if isinstance(raw, list) and raw:
        return [str(b) for b in raw if b]
    if event.get("branch"):
        return [str(event["branch"])]
    return []


def _proves(event):
    kind = str(event.get("kind") or "")
    if kind in ("deploy", "deploy_fail", "lab_retest_pass", "ci_pass"):
        return True
    state = str(event.get("state") or event.get("conclusion") or "").lower()
    return kind in _PROVE_KINDS and state in _PROVE_STATES


def _later_deploy(events, pending, repo):
    """A deploy recorded after this pending, on any branch of the repo."""
    started = _ts(pending.get("t_ct"))
    for event in events or []:
        if not isinstance(event, dict) or event is pending:
            continue
        if _repo(event) != repo or _ts(event.get("t_ct")) <= started:
            continue
        if str(event.get("kind") or "") in ("deploy", "deploy_fail"):
            return True
    return False


def _history(events):
    """(repo, branch) -> commits in time order; sha -> (repo, branch, time, seq)."""
    lines = {}
    seq = 0
    for event in events or []:
        if not isinstance(event, dict) or event.get("kind") != "commit":
            continue
        repo, sha = _repo(event), _sha(event)
        if not repo or not sha:
            continue
        branches = _branches(event)
        if not branches:
            continue
        when = _ts(event.get("t_ct"))
        for branch in branches:
            lines.setdefault((repo, branch), []).append((when, seq, sha))
            seq += 1
    for key in lines:
        lines[key].sort()
    return lines


def _locate(lines, repo, sha):
    found = []
    for (r, branch), commits in lines.items():
        if r != repo:
            continue
        for when, seq, cur in commits:
            if _same(cur, sha):
                found.append((branch, when, seq, commits))
    return found


def _tip(lines, repo, sha):
    for _branch, _when, seq, commits in _locate(lines, repo, sha):
        tip = commits[-1][2]
        if _same(tip, sha) and commits[-1][1] == seq:
            return True
    return False


def _later(lines, repo, sha, other):
    if not other or _same(other, sha):
        return False
    for branch, when, seq, commits in _locate(lines, repo, sha):
        for ow, oseq, ocur in commits:
            if _same(ocur, other) and (ow, oseq) > (when, seq):
                return True
    return False


def _proven(events, lines, pending, repo, sha):
    started = _ts(pending.get("t_ct"))
    for event in events or []:
        if not isinstance(event, dict) or event is pending:
            continue
        if _repo(event) != repo or _ts(event.get("t_ct")) <= started or not _proves(event):
            continue
        other = _sha(event)
        if _same(other, sha) or _later(lines, repo, sha, other):
            return True
    return False


def classify(events, now=None, stale_s=None):
    """-> {holds, stale, dropped} as lists of deploy_pending event ids."""
    now = _now(now)
    window = stale_seconds() if stale_s is None else float(stale_s)
    rows = [e for e in (events or []) if isinstance(e, dict)]
    lines = _history(rows)
    holds, stale, dropped = [], [], []
    for event in rows:
        if str(event.get("kind") or "") != "deploy_pending":
            continue
        eid = event.get("id")
        if not eid:
            continue
        repo, sha = _repo(event), _sha(event)
        old = now - _ts(event.get("t_ct")) >= window
        proven = bool(sha) and _proven(rows, lines, event, repo, sha)
        tip = bool(sha) and _tip(lines, repo, sha)
        # Not the tip, and a later deploy exists (including on another branch): closed, not stale.
        superseded = bool(sha) and bool(_locate(lines, repo, sha)) and not tip and _later_deploy(rows, event, repo)
        if (old and proven) or superseded:
            dropped.append(eid)
        elif not tip or old:
            if old:
                stale.append(eid)
        else:
            holds.append(eid)
    return {"holds": holds, "stale": stale, "dropped": dropped}
