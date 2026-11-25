"""Close and reopen share one write. A thread that reopens ends live."""
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


def ev(kind, ago):
    return {
        "id": f"{kind}-{ago}", "t_ct": ct(ago), "kind": kind, "repo": R, "number": 7,
        "from": "arch1", "title": "thread", "source": f"https://github.com/{R}/issues/7",
    }


class ThreadState(unittest.TestCase):
    def test_close_reopen_comment_ends_live(self):
        events = [
            ev("issue_open", 500),
            ev("issue_close", 400),
            ev("issue_reopen", 300),
            ev("issue_comment", 200),
            ev("issue_close", 150),
            ev("issue_reopen", 100),
            ev("issue_comment", 50),
        ]
        cards = live_board.model(events, now=time.time())["cards"]
        card = next(c for c in cards if c.get("number") == 7)
        self.assertEqual(card["state"], "live")
        self.assertNotEqual(card["stage"], "done")

    def test_helper_clears_a_close_on_reopen(self):
        card = {"_closed": True, "_closed_t": 10, "_stop": True}
        self.assertEqual(live_board.apply_thread_state(card, "issue_reopen", 20, "r1"), "reopen")
        self.assertFalse(card["_closed"])
        self.assertEqual(card["_closed_t"], 0)
        self.assertFalse(card["_stop"])
        self.assertEqual(live_board.apply_thread_state(card, "pr_close", 30, "c1"), "close")
        self.assertTrue(card["_closed"])
        self.assertEqual(card["_close_id"], "c1")
