"""Packet R assigns a fleet bot. A person login and an existing assignee stay put."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
import live_collect  # noqa: E402


NODES = {
    "arch10x[bot]": "arch1",
    "critic0x[bot]": "critic",
    "critic0x1[bot]": "critic",
    "htafolla": "Blaze",
    "Blaze0x1": "Blaze",
}


def card(body, **over):
    item = {"state": "open", "number": 1039, "assignees": [], "body": body}
    item.update(over)
    return item


class AssigneeBot(unittest.TestCase):
    def test_arch1_is_the_app_bot(self):
        body = "## Packet\n\nR: arch1\nA: Blaze\n"
        self.assertEqual(live_collect.assignee_bot(card(body), NODES), "arch10x[bot]")

    def test_a_person_and_a_filled_card_are_left_alone(self):
        body = "## Packet\n\nR: Blaze\nA: Blaze\n"
        self.assertIsNone(live_collect.assignee_bot(card(body), NODES))
        taken = card("## Packet\n\nR: arch1\nA: Blaze\n", assignees=[{"login": "forge0x1[bot]"}])
        self.assertIsNone(live_collect.assignee_bot(taken, NODES))
        closed = card("## Packet\n\nR: arch1\nA: Blaze\n", state="closed")
        self.assertIsNone(live_collect.assignee_bot(closed, NODES))

    def test_the_first_bot_login_in_the_map_wins(self):
        body = "## Packet\n\nR: critic\nA: Blaze\n"
        self.assertEqual(live_collect.assignee_bot(card(body), NODES), "critic0x[bot]")

    def test_a_refusal_is_remembered_and_a_network_miss_is_not(self):
        calls = []

        class Writer:
            token = "t"

            def __init__(self, code):
                self.code = code

            def write_json(self, path, payload):
                calls.append((self.code, payload))
                return self.code

        col = live_collect.RepoCollector.__new__(live_collect.RepoCollector)
        col.st = {}
        col.repo = "example/repo"
        col._assign_left = 10
        col._assign_miss = False
        saved = dict(live_collect.NODE)
        live_collect.NODE.clear()
        live_collect.NODE.update(NODES)
        try:
            item = card("## Packet\n\nR: arch1\nA: Blaze\n")
            col.maybe_assign(Writer(403), item)
            self.assertEqual(col._assign_left, 9)
            self.assertEqual(col.st.get("assign_tried"), ["example/repo#1039"])
            self.assertFalse(col._assign_miss)
            self.assertFalse(getattr(col, "_assign_auth_dead", False))
            col.maybe_assign(Writer(201), item)
            self.assertEqual(len(calls), 1)
            other = card("## Packet\n\nR: arch1\nA: Blaze\n", number=1040)
            col.maybe_assign(Writer(201), other)
            self.assertEqual(col.st["assign_tried"], ["example/repo#1039", "example/repo#1040"])
            self.assertEqual(col._assign_left, 8)
            self.assertEqual(len(calls), 2)
            missed = card("## Packet\n\nR: arch1\nA: Blaze\n", number=1044)
            col.maybe_assign(Writer(0), missed)
            self.assertEqual(col._assign_left, 8)
            self.assertNotIn("example/repo#1044", col.st["assign_tried"])
            self.assertTrue(col._assign_miss)
            col._assign_miss = False
            expired = card("## Packet\n\nR: arch1\nA: Blaze\n", number=1045)
            col.maybe_assign(Writer(401), expired)
            self.assertNotIn("example/repo#1045", col.st["assign_tried"])
            self.assertFalse(col._assign_miss)
            self.assertTrue(col._assign_auth_dead)
            self.assertEqual(col._assign_left, 8)
            col.maybe_assign(Writer(201), card("## Packet\n\nR: arch1\nA: Blaze\n", number=1046))
            self.assertEqual(len(calls), 4)
        finally:
            live_collect.NODE.clear()
            live_collect.NODE.update(saved)

    def test_the_shipped_fleet_file_names_arch1_when_the_env_map_does_not(self):
        saved = dict(live_collect.NODE)
        live_collect.NODE.clear()
        live_collect.NODE.update({"critic0x[bot]": "critic"})
        try:
            body = "## Packet\n\nR: arch1\nA: Blaze\n"
            self.assertEqual(live_collect.assignee_bot(card(body), live_collect.assignee_nodes()), "arch10x[bot]")
        finally:
            live_collect.NODE.clear()
            live_collect.NODE.update(saved)

    def test_the_rewalk_stays_open_when_the_cap_is_spent(self):
        self.assertFalse(live_collect.assign_rewalk_done("done", 0, False))
        self.assertFalse(live_collect.assign_rewalk_done("done", 10, True))
        self.assertTrue(live_collect.assign_rewalk_done("done", 10, False))
        self.assertFalse(live_collect.assign_rewalk_done("done", 0, False, True))
        self.assertFalse(live_collect.assign_rewalk_done("done", 10, False, True))
        self.assertFalse(live_collect.assign_rewalk_done("partial", 10, False, True))
        self.assertFalse(live_collect.assign_rewalk_done("done", 10, True, True))


if __name__ == "__main__":
    unittest.main()
