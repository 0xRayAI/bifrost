"""A verdict moves next owner. FAIL returns the card to the author. A new head names critic."""
import sys
import time
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
import live_board  # noqa: E402

CT = ZoneInfo("America/Chicago")
R = "0xRayAI/xray"


def ct(ago):
    return datetime.fromtimestamp(time.time() - ago, CT).isoformat(timespec="seconds")


def ev(n, kind, ago, **extra):
    row = {"id": f"{kind}-{n}-{ago}", "t_ct": ct(ago), "kind": kind, "repo": R, "number": n, "from": "arch1", "source": f"https://github.com/{R}/pull/{n}"}
    row.update(extra)
    return row


def card(events, n):
    cards = live_board.model(events, now=time.time())["cards"]
    return next(c for c in cards if c.get("number") == n)


class VerdictNextOwner(unittest.TestCase):
    def test_fail_at_head_returns_the_card_to_the_author(self):
        sha = "aaa1111"
        events = [
            ev(40, "pr_open", 9000, title="d", packet={"next owner": "critic"}),
            ev(40, "pr_commit", 8000, sha=sha),
            ev(40, "ci_pass", 7000, conclusion="success", sha=sha),
            ev(40, "critic_fail", 6000, sha=sha),
        ]
        c = card(events, 40)
        self.assertEqual(c["packet"]["next owner"], "arch1")
        self.assertEqual(c["nudge_via"], "fix (Reviewer FIX at head)")

    def test_a_new_head_names_critic(self):
        sha = "aaa1111"
        events = [
            ev(41, "pr_open", 9000, title="d", packet={"next owner": "critic"}),
            ev(41, "pr_commit", 8000, sha=sha),
            ev(41, "ci_pass", 7000, conclusion="success", sha=sha),
            ev(41, "critic_pass", 6000, sha=sha),
            ev(41, "pr_commit", 1000, sha="bbb2222"),
        ]
        c = card(events, 41)
        self.assertTrue(c["reviewer"]["stale"])
        self.assertEqual(c["packet"]["next owner"], "critic")
        self.assertEqual(c["nudge_via"], "new head")

    def test_pass_at_head_still_names_builder(self):
        sha = "ccc3333"
        events = [
            ev(42, "pr_open", 9000, title="d", packet={"next owner": "critic"}),
            ev(42, "pr_commit", 8000, sha=sha),
            ev(42, "ci_pass", 7000, conclusion="success", sha=sha),
            ev(42, "critic_pass", 6000, sha=sha),
        ]
        c = card(events, 42)
        self.assertEqual(c["packet"]["next owner"], "Builder")
        self.assertEqual(c["stage"], "merge")


if __name__ == "__main__":
    unittest.main()
