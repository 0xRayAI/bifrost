"""Packet fields from an issue / PR body, captured in the existing feed pass (the body itself is never stored).
Holds: a Held: comment, or a GitHub label in GITHUB_HOLD_LABEL (default on-hold).
NO_NUDGE_REPOS (unset means none) stay on the board and are never nudged.

A packet is goal, constraints, path, acceptance, evidence, next owner, escalate, and raci.
raci names who does the work (R) and who answers (A): `R=<name> A=<name>`, or one line each for R, A, C, and I.
Three forms:
  ## Packet                         ### Scope / ### Acceptance / ### Next owner
  - Goal: ...                       (Scope fills goal; ### stays inside the packet)
  single line: Packet: goal: ... | acceptance: ... | next owner: ...
                                    (';' also separates fields)
Every field: emails -> [email], links whose host is not GitHub, Railway or example.com are stripped, <= 200 chars."""
import os
import re
from urllib.parse import urlparse

FIELDS = ("goal", "constraints", "path", "acceptance", "evidence", "next owner", "escalate", "raci")
ALIAS = {"next": "next owner", "next_owner": "next owner", "owner": "next owner", "constraint": "constraints",
         "accept": "acceptance", "done when": "acceptance", "escalation": "escalate", "scope": "goal"}
_LETTER = re.compile(r"^\s*(?:[-*]\s*)?(?:\*\*)?([RACI])(?:\*\*)?\s*:\s*(.+)$", re.I)
_ROLE = re.compile(r"(?:^|[\s,;·])([RACI])\s*[=:]\s*(\S+)", re.I)
MAX = 200
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
URL = re.compile(r"https?://[^\s)>\]]+")
MDLINK = re.compile(r"\[([^\]]*)\]\((https?://[^)\s]+)\)")
OK_HOSTS = ("github.com", "railway.app", "railway.com", "example.com")


def _host_ok(u):
    h = (urlparse(u).hostname or "").lower()
    return any(h == d or h.endswith("." + d) for d in OK_HOSTS)


def clean(s):
    s = MDLINK.sub(lambda m: m.group(0) if _host_ok(m.group(2)) else m.group(1), str(s or ""))
    s = URL.sub(lambda m: m.group(0) if _host_ok(m.group(0)) else "", s)
    s = EMAIL.sub("[email]", s)
    s = " ".join(s.replace("**", "").replace("`", "").split())
    return s[:MAX].rstrip()


_HELD_LINE = re.compile(r"^\s*held:\s*(.+?)\s*$", re.I)
_UNTIL_LINE = re.compile(r"^\s*until:\s*(.+?)\s*$", re.I)
HOLD_MAX = 80


def parse_hold(body):
    """Held: comment -> {reason, until}. The body is not returned. None when the first line is not Held:."""
    lines = [ln.strip() for ln in str(body or "").replace("\r\n", "\n").splitlines() if ln.strip()]
    if not lines:
        return None
    m = _HELD_LINE.match(lines[0])
    if not m:
        return None
    raw, until = m.group(1).strip(), ""
    if "|" in raw:
        left, right = raw.split("|", 1)
        raw = left.strip()
        um = re.match(r"until:\s*(.+)$", right.strip(), re.I)
        until = (um.group(1) if um else right).strip()
    for ln in lines[1:6]:
        um = _UNTIL_LINE.match(ln)
        if um and not until:
            until = um.group(1).strip()
    if not until:
        um = re.match(r"until\s+(.+)$", raw, re.I)
        if um:
            until = um.group(1).strip()
    reason = clean(raw)[:HOLD_MAX]
    until = clean(until)[:HOLD_MAX]
    if not reason:
        return None
    return {"reason": reason, "until": until}


def _csv_env(name, default):
    """Unset uses default. A set value is comma-separated; a blank value is an empty list."""
    raw = os.environ.get(name)
    if raw is None:
        return list(default)
    return [part.strip() for part in str(raw).split(",") if part.strip()]


def github_hold_labels():
    """GitHub label names that hold a card. Unset means on-hold."""
    return _csv_env("GITHUB_HOLD_LABEL", ["on-hold"])


def labels_held(labels):
    """Matching label text, or None. The comparison is exact and case-insensitive."""
    wanted = {name.casefold() for name in github_hold_labels()}
    if not wanted:
        return None
    for label in labels or []:
        text = str(label or "").strip()
        if text.casefold() in wanted:
            return text
    return None


def no_nudge_patterns():
    """Repo globs that stay on the board and are never nudged. Unset means none."""
    return _csv_env("NO_NUDGE_REPOS", [])


def repo_no_nudge(repo, patterns=None):
    """True when repo matches owner/name or owner/* . Comparison is case-insensitive."""
    text = str(repo or "").strip()
    if not text:
        return False
    low = text.casefold()
    for pattern in no_nudge_patterns() if patterns is None else patterns:
        pat = str(pattern or "").strip()
        if not pat:
            continue
        if pat.endswith("/*"):
            owner = pat[:-2].casefold()
            if owner and (low == owner or low.startswith(owner + "/")):
                return True
        elif low == pat.casefold():
            return True
    return False


def raci_roles(value):
    """Names after R=, A=, C=, or I= in a raci line."""
    found = {}
    for match in _ROLE.finditer(str(value or "")):
        found[match.group(1).upper()] = match.group(2)
    return found


def raci_gaps(packet, state="live", pinned=False):
    """R and A still missing. Closed and pinned cards stay quiet."""
    if pinned or state == "closed":
        return []
    roles = raci_roles((packet or {}).get("raci") if isinstance(packet, dict) else "")
    return [key for key in ("R", "A") if not roles.get(key)]


def _join_raci(roles):
    parts = [f"{key}={roles[key]}" for key in ("R", "A", "C", "I") if roles.get(key)]
    return clean(" ".join(parts))


def _key(k):
    k = re.sub(r"[*_`]", "", k).strip().lower()
    k = ALIAS.get(k, k)
    return k if k in FIELDS else None


def _packet_block(text):
    """The packet section through the next heading at the same or higher level. ### stays inside."""
    found = re.search(r"^(#{1,6})\s*packet\s*$", text, re.I | re.M)
    if not found:
        return ""
    level = len(found.group(1))
    rest = text[found.end():]
    end = re.search(rf"(?m)^#{{1,{level}}}\s+\S", rest)
    return rest[:end.start()] if end else rest


def _flush_field(out, name, lines):
    if not name:
        return
    value = clean(" ".join(lines))
    if value:
        out.setdefault(name, value)


def carries(body):
    """True when the text is a packet, names PACKET.md, or has a packet heading or Packet: line.

    A parsed field block counts. So does a branch file named in the body. The collector
    still stores only the sanitized fields, never the body.
    """
    text = str(body or "")
    if not text.strip():
        return False
    if parse(text):
        return True
    if re.search(r"(?i)\bPACKET\.md\b", text):
        return True
    if re.search(r"(?im)^#{1,6}\s*packet\s*$", text):
        return True
    if re.search(r"(?im)^\s*\**packet\**\s*:", text):
        return True
    return False


def parse(body):
    """-> {field: text} for the fields present (cleaned), or {} when the body has no packet."""
    if not body:
        return {}
    text = str(body).replace("\r\n", "\n")
    out = {}
    block = _packet_block(text)
    if block:
        current, buf, letters = None, [], {}
        for line in block.splitlines():
            heading = re.match(r"^\s*(#{1,6})\s+(.+?)\s*$", line)
            if heading:
                _flush_field(out, current, buf)
                current, buf = _key(re.sub(r":\s*$", "", heading.group(2).strip())), []
                continue
            letter = _LETTER.match(line)
            if letter and letter.group(2).strip():
                _flush_field(out, current, buf)
                current, buf = None, []
                letters[letter.group(1).upper()] = letter.group(2).strip()
                continue
            lm = re.match(r"^\s*(?:[-*]\s*)?(?:\*\*)?([A-Za-z _]{3,20}?)(?:\*\*)?\s*:\s*(.+)$", line)
            if lm and _key(lm.group(1)) and lm.group(2).strip():
                _flush_field(out, current, buf)
                current, buf = None, []
                out.setdefault(_key(lm.group(1)), clean(lm.group(2)))
                continue
            if current is not None:
                buf.append(line)
        _flush_field(out, current, buf)
        if letters:
            roles = raci_roles(out.get("raci"))
            for key, raw in letters.items():
                value = clean(raw)
                if value:
                    roles[key] = value
            joined = _join_raci(roles)
            if joined:
                out["raci"] = joined
    if not out:
        sm = re.search(r"^\s*\**packet\**\s*:\s*(.+)$", text, re.I | re.M)
        if sm:
            for part in re.split(r"\s[|;]\s|\s*[|;]\s*(?=[A-Za-z _]{3,20}:)", sm.group(1)):
                pm = re.match(r"\s*([A-Za-z _]{3,20}?)\s*[:=]\s*(.+)$", part)
                if pm and _key(pm.group(1)) and pm.group(2).strip():
                    out.setdefault(_key(pm.group(1)), clean(pm.group(2)))
    return {k: v for k, v in out.items() if v}
