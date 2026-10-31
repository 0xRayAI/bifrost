"""Next open child on a parent issue after one of its pulls merges. The body is not stored."""
import re

REF_RE = re.compile(r"(?:refs|closes|fixes)\s+#(\d+)", re.I)
HASH_RE = re.compile(r"#(\d+)")
R_RE = re.compile(r"\bR=([A-Za-z][A-Za-z0-9_-]{0,40})")


def ref_numbers(body):
    return [int(n) for n in REF_RE.findall(body or "")]


def child_numbers(body):
    return [int(n) for n in HASH_RE.findall(body or "")]


def next_open_child(body, done, open_nums=None):
    closed = {int(n) for n in done}
    allowed = None if open_nums is None else {int(n) for n in open_nums}
    for raw in HASH_RE.findall(body or ""):
        num = int(raw)
        if num in closed:
            continue
        if allowed is not None and num not in allowed:
            continue
        return num
    return None


def r_seat(body):
    match = R_RE.search(body or "")
    if not match:
        return None
    seat = re.sub(r"[^a-z0-9_-]", "", match.group(1).lower())
    return seat or None


def parent_door(bodies, done, open_nums=None):
    """bodies maps an issue number to its body, in the pull's ref order.
    A child that is itself one of those issues is a cross-link. Follow it.
    The doorbell names the last issue in that chain and that issue's next open child.
    When open_nums is set, a child counts only if that issue is still open."""
    closed = {int(n) for n in done}
    found = []
    for num, body in bodies.items():
        parent = int(num)
        if parent in closed:
            continue
        nxt = next_open_child(body, closed | {parent}, open_nums)
        seat = r_seat(body)
        if nxt and nxt != parent and seat:
            found.append({"parent": parent, "next": nxt, "seat": seat})
    if not found:
        return None
    by_parent = {row["parent"]: row for row in found}
    row = found[0]
    seen = set()
    while row["next"] in by_parent and row["parent"] not in seen:
        seen.add(row["parent"])
        row = by_parent[row["next"]]
    return row
