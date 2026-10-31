"""One open ci_fail line per pull head. A later green head is an ack, not a second line.

Suite failures win. A check run is used only when that head has no suite. The line id is
ci_fail:<repo>#<number>:<sha>, so a second event on the same head does not open another line.
"""

FAIL = {"failure", "failed", "timed_out", "cancelled", "canceled", "startup_failure", "action_required"}
CLOSE = {"merged", "pr_close", "issue_close", "pr_closed", "issue_closed", "closed"}
HEAD_KINDS = {"pr_open", "pr_commit", "pr_force_push", "pr_update"}
PULL_KINDS = HEAD_KINDS | {"pr_ready", "workflow_run", "ci_fail", "ci_pass", "check_suite", "check_run"}


def _low(value):
    return str(value or "").strip().lower()


def _sha(event):
    raw = _low(event.get("sha") or event.get("head_sha"))
    if len(raw) < 7 or any(ch not in "0123456789abcdef" for ch in raw):
        return ""
    return raw


def _num(event):
    try:
        number = int(event.get("number"))
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _repo(event):
    return str(event.get("repo") or "").strip()


def _stamp(event):
    return str(event.get("t_ct") or "")


def _kind(event):
    return _low(event.get("kind"))


def _conclusion(event):
    return _low(event.get("conclusion"))


def _status(event):
    return _low(event.get("status"))


# A check that has not finished is not a failure. Empty status stays the completed shape.
RUNNING = {"queued", "in_progress", "pending", "waiting", "requested"}


def _red(event):
    status = _status(event)
    if status in RUNNING or (status and status != "completed"):
        return False
    kind = _kind(event)
    if kind == "ci_fail":
        return True
    if kind not in ("check_suite", "check_run", "workflow_run"):
        return False
    return _conclusion(event) in FAIL


def _events(events):
    return [event for event in events or [] if isinstance(event, dict)]


def closed_pulls(events):
    """(repo, number) whose latest close is after its latest open."""
    state = {}
    for event in _events(events):
        repo, number = _repo(event).lower(), _num(event)
        if not repo or not number:
            continue
        kind = _kind(event)
        opened = kind in ("pr_open", "pr_update", "pr_reopen", "issue_open", "issue_reopen", "reopen")
        closed = kind in CLOSE
        if not opened and not closed:
            continue
        stamp = _stamp(event)
        prev = state.get((repo, number))
        if prev and stamp < prev[0]:
            continue
        state[(repo, number)] = (stamp, closed)
    return {key for key, row in state.items() if row[1]}


def pull_of_sha(events):
    """Newest (repo, sha) -> (number, repo display)."""
    found = {}
    for event in _events(events):
        sha, number, repo = _sha(event), _num(event), _repo(event)
        if not sha or not number or not repo or _kind(event) not in PULL_KINDS:
            continue
        key = (repo.lower(), sha)
        prev = found.get(key)
        if prev and _stamp(event) < prev[0]:
            continue
        found[key] = (_stamp(event), number, repo)
    return found


def known_pulls(events):
    found = set()
    for event in _events(events):
        repo, number = _repo(event).lower(), _num(event)
        if repo and number and _kind(event) in PULL_KINDS | {"pr_open", "issue_open"}:
            found.add((repo, number))
    return found


def sha_color(events):
    """Newest completed suite wins. With no suite, the newest run or ci_* event wins."""
    suites = {}
    runs = {}
    for event in _events(events):
        sha, repo = _sha(event), _repo(event).lower()
        if not sha or not repo:
            continue
        kind = _kind(event)
        stamp = _stamp(event)
        if kind == "check_suite" and _conclusion(event):
            prev = suites.get((repo, sha))
            if not prev or stamp >= prev[0]:
                suites[(repo, sha)] = (stamp, "green" if _conclusion(event) == "success" else "red" if _red(event) else "")
        elif kind in ("check_run", "workflow_run", "ci_pass", "ci_fail"):
            color = "green" if _conclusion(event) == "success" or kind == "ci_pass" else "red" if _red(event) else ""
            if not color:
                continue
            prev = runs.get((repo, sha))
            if not prev or stamp >= prev[0]:
                runs[(repo, sha)] = (stamp, color)
    colors = {}
    keys = set(suites) | set(runs)
    for key in keys:
        if key in suites and suites[key][1]:
            colors[key] = suites[key][1]
        elif key in runs:
            colors[key] = runs[key][1]
    return colors


def head_sha(events):
    """repo#number -> newest head sha."""
    found = {}
    for event in _events(events):
        if _kind(event) not in HEAD_KINDS:
            continue
        sha, number, repo = _sha(event), _num(event), _repo(event).lower()
        if not sha or not number or not repo:
            continue
        key = f"{repo}#{number}"
        prev = found.get(key)
        if prev and _stamp(event) < prev[0]:
            continue
        found[key] = (_stamp(event), sha)
    return {key: row[1] for key, row in found.items()}


def green_keys(events):
    colors = sha_color(events)
    return {key for key, color in colors.items() if color == "green"}


def _names(events, repo, sha):
    names = []
    for event in _events(events):
        if _repo(event).lower() != repo or _sha(event) != sha or not _red(event):
            continue
        kind = _kind(event)
        if kind == "check_run":
            name = str(event.get("name") or "").strip()
        elif kind == "check_suite":
            name = "suite " + str(event.get("app") or "checks").strip()
        elif kind in ("workflow_run", "ci_fail"):
            name = str(event.get("name") or event.get("label") or "ci").strip()
        else:
            continue
        name = " ".join(name.split())[:40]
        if name and name not in names:
            names.append(name)
    return names[:6]


def _url(events, repo, number, sha):
    for event in _events(events):
        if _repo(event).lower() != repo or _num(event) != number:
            continue
        if _kind(event) not in ("pr_open", "pr_update"):
            continue
        source = str(event.get("source") or "")
        if source.startswith("https://"):
            return source[:300]
    if repo and number:
        return f"https://github.com/{repo}/pull/{number}"[:300]
    return ""


def _display_repo(events, repo):
    for event in _events(events):
        if _repo(event).lower() == repo and _repo(event):
            return _repo(event)
    return repo


def ci_fail_lines(events, new_events, seat_of):
    """Lines for new red heads. seat_of(repo, number) returns a seat id or ''."""
    rows = _events(events)
    fresh = _events(new_events)
    colors = sha_color(rows)
    pulls = pull_of_sha(rows)
    closed = closed_pulls(rows)
    known = known_pulls(rows)
    suite = {( _repo(event).lower(), _sha(event)) for event in rows if _kind(event) == "check_suite" and _sha(event)}
    out = []
    seen = set()
    for event in fresh:
        kind = _kind(event)
        sha, repo = _sha(event), _repo(event).lower()
        if not sha or not repo:
            continue
        has_suite = (repo, sha) in suite
        if kind == "check_suite":
            if not _red(event):
                continue
        elif kind in ("check_run", "workflow_run", "ci_fail") and not has_suite and _red(event):
            pass
        else:
            continue
        number = _num(event) or (pulls.get((repo, sha)) or (None, 0, ""))[1]
        if not number or (repo, number) in closed or (repo, number) not in known and not _num(event):
            continue
        if (repo, number) not in known:
            known.add((repo, number))
        if colors.get((repo, sha)) == "green":
            continue
        ident = (repo, number, sha)
        if ident in seen:
            continue
        seen.add(ident)
        seat = seat_of(repo, number) if seat_of else ""
        if not seat:
            continue
        names = _names(rows, repo, sha)
        shown = ", ".join(names) if names else "checks"
        title = f"ci fail {shown}"[:120]
        out.append({
            "id": f"ci_fail:{repo}#{number}:{sha}",
            "t_ct": str(event.get("t_ct") or ""),
            "seat": seat,
            "type": "ci_fail",
            "repo": _display_repo(rows, repo),
            "number": number,
            "sha": sha,
            "title": title,
            "url": _url(rows, repo, number, sha),
            "reason": f"{title} {sha[:12]}"[:80],
        })
    return out


def ack_ids(lines, events):
    """Open ci_fail ids whose sha is green, or whose pull's current head is green."""
    green = green_keys(events)
    heads = head_sha(events)
    ids = []
    for line in lines or []:
        if not isinstance(line, dict):
            continue
        if _low(line.get("type") or line.get("kind")) != "ci_fail":
            continue
        repo = _low(line.get("repo"))
        sha = _low(line.get("sha"))
        try:
            number = int(line.get("number"))
        except (TypeError, ValueError):
            continue
        if (repo, sha) in green or (repo, heads.get(f"{repo}#{number}", "")) in green:
            ident = str(line.get("id") or "")
            if ident:
                ids.append(ident)
    return ids


def missing_cards(events, existing):
    """One board card for a red open pull that has no card yet. Same key as a pr_open card."""
    rows = _events(events)
    have = {str(key).lower() for key in (existing or set())}
    colors = sha_color(rows)
    pulls = pull_of_sha(rows)
    closed = closed_pulls(rows)
    made = {}
    for event in rows:
        if not _red(event):
            continue
        sha, repo = _sha(event), _repo(event).lower()
        if not sha or not repo or colors.get((repo, sha)) == "green":
            continue
        number = _num(event) or (pulls.get((repo, sha)) or (None, 0, ""))[1]
        if not number or (repo, number) in closed:
            continue
        key = f"{repo}#{number}"
        if key in have or key in made:
            continue
        display = _display_repo(rows, repo)
        names = _names(rows, repo, sha)
        title = ("ci fail " + ", ".join(names))[:120] if names else f"{display} #{number}"
        made[key] = {
            "key": key, "kind": "pr", "repo": display, "number": number,
            "title": title, "url": _url(rows, repo, number, sha), "owner": "-",
            "labels": [], "packet": {}, "packet_file": False,
            "_closed": False, "_closed_t": 0, "_draft": False, "_beats": [], "_stop": False, "_known": False,
        }
    return list(made.values())
