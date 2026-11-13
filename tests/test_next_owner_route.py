"""next owner critic on a pull open routes critic. A body phrase does too. The body is not stored."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
import inbox_pass  # noqa: E402
import live_collect  # noqa: E402

ROLES = json.loads((Path(__file__).resolve().parents[1] / "collector" / "routing" / "inbox-roles.json").read_text())


def seats(event):
    return [line.get("seat") for line in inbox_pass._direct_all(event, ROLES)]


class NextOwnerRoute(unittest.TestCase):
    def test_packet_next_owner_on_open_reaches_critic(self):
        event = {
            "id": "0xRayAI/xray#804:open",
            "t_ct": "2026-11-01T15:33:06-06:00",
            "from": "arch1",
            "actor": "arch10x[bot]",
            "kind": "pr_open",
            "label": "xray #804 opened · docs",
            "repo": "0xRayAI/xray",
            "number": 804,
            "packet": {"next owner": "critic"},
        }
        self.assertIn("critic", seats(event))
        self.assertNotIn("body", event)

    def test_strict_ask_phrase_on_open_reaches_critic(self):
        body = "## Packet\n\n- next owner: critic\n\nstrict ask\n"
        event = {
            "id": "0xRayAI/xray#804:open",
            "t_ct": "2026-11-01T15:33:06-06:00",
            "from": "arch1",
            "kind": "pr_open",
            "label": "xray #804 opened · docs",
            "repo": "0xRayAI/xray",
            "number": 804,
            "asks": live_collect.phrase_asks(body),
        }
        self.assertEqual(event["asks"], ["strict ask"])
        self.assertNotIn(body, json.dumps(event))
        self.assertIn("critic", seats(event))

    def test_a_later_packet_routes_the_new_seat(self):
        event = {
            "id": "0xRayAI/xray#804:comment:9",
            "t_ct": "2026-11-01T16:00:00-06:00",
            "from": "critic",
            "actor": "critic0x[bot]",
            "kind": "pr_comment",
            "label": "critic0x[bot] comment · xray #804",
            "repo": "0xRayAI/xray",
            "number": 804,
            "packet": {"next owner": "arch1"},
        }
        lines = inbox_pass._direct_all(event, ROLES)
        reasons = [(line.get("seat"), line.get("reason")) for line in lines]
        self.assertIn(("arch1", "packet next owner"), reasons)

    def test_packet_r_files_the_opener(self):
        event = {
            "id": "0xRayAI/xray#1039:open",
            "t_ct": "2026-11-13T12:00:00-06:00",
            "from": "arch1",
            "actor": "arch10x[bot]",
            "kind": "issue_open",
            "label": "xray issue #1039 opened",
            "repo": "0xRayAI/xray",
            "number": 1039,
            "packet": {"raci": "R: arch1 A: Blaze"},
        }
        lines = inbox_pass._direct_all(event, ROLES)
        reasons = [(line.get("seat"), line.get("reason")) for line in lines]
        self.assertIn(("arch1", "packet R"), reasons)

    def test_a_new_pull_still_reaches_critic_as_a_review_ask(self):
        event = {
            "id": "0xRayAI/xray#1:open",
            "t_ct": "2026-11-01T15:33:06-06:00",
            "from": "arch1",
            "kind": "pr_open",
            "label": "xray #1 opened · docs",
            "repo": "0xRayAI/xray",
            "number": 1,
        }
        lines = inbox_pass._direct_all(event, ROLES)
        reasons = [line.get("reason") for line in lines if line.get("seat") == "critic"]
        self.assertIn("review ask: new PR or new head", reasons)
        self.assertNotIn("review request or Light / Strict / re-Light ask", reasons)


if __name__ == "__main__":
    unittest.main()
