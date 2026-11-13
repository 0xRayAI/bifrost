"""Card owner is a seat. A person never owns the card."""
import re

# Kit seats plus the builder default and the operator role name.
SEATS = frozenset({
    "builder", "builder-cloud", "arch1", "forge", "critic", "blinky",
    "herald", "nibbler", "sound", "magnet", "operator",
})
BOARD_OWNER_RE = re.compile(r"(?im)^[ \t]*Board-Owner:[ \t]*([A-Za-z][A-Za-z0-9_-]{0,31})[ \t]*$")


def board_owner_line(body):
    """The seat named by a Board-Owner line. Empty when the body has none."""
    match = BOARD_OWNER_RE.search(str(body or ""))
    return match.group(1).lower() if match else ""


def card_owner(board_owner, assignee, opener, *, cloud=False, operator=False, operator_seat="operator"):
    """Board-Owner line, else a seat assignee, else the operator for a cloud or operator opener, else the opener when that name is a seat, else builder-cloud."""
    named = str(board_owner or "").strip().lower()
    if named in SEATS:
        return named
    who = str(assignee or "").strip().lower()
    if who in SEATS:
        return who
    if cloud or operator:
        op = str(operator_seat or "operator").strip().lower()
        if op in SEATS:
            return op
    raw = str(opener or "").strip()
    if raw.lower() in SEATS:
        return raw
    return "builder-cloud"
