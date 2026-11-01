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
    The next card is that issue's next open child.
    When that child is also one of these issues, the doorbell stops on the child.
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
    # The parent is a ref that names another fetched issue. Stop on that child.
    pointed = {row["next"] for row in found if row["next"] in by_parent}
    roots = [row for row in found if row["next"] in by_parent and row["parent"] not in pointed]
    if roots:
        return roots[0]
    plain = [row for row in found if row["parent"] not in pointed]
    return (plain or found)[0]
