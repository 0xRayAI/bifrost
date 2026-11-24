"""Head changes reach routing. A needle and a review request are asks. A new head is not."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
import inbox_pass  # noqa: E402
import live_collect  # noqa: E402

ROLES = json.loads((Path(__file__).resolve().parents[1] / "collector" / "routing" / "inbox-roles.json").read_text())
OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
WHEN = "2026-11-24T18:00:00Z"
BEFORE = "2026-11-24T12:00:00Z"
QUIET = {
    "author:seat": True,
    "merged:day": True,
    "bc:body": True,
    "merged:actor": True,
    "assign:r": True,
    "cards:pulls": True,
    "prs:done": True,
}


def _zone():
    from zoneinfo import ZoneInfo
    return ZoneInfo("America/Chicago")


class Client:
    def __init__(self, pulls):
        self.token = "t"
        self.pulls = pulls

    def rest(self, path, params=None, etag=None, essential=True):
        if str(path).rstrip("/").endswith("/pulls"):
            return 200, self.pulls, "etag", None
        return 404, {}, None, None

    def write_json(self, path, body):
        return 404


def pull(head, updated, user=None):
    return {
        "number": 122,
        "title": "push",
        "state": "open",
        "draft": False,
        "html_url": "https://github.com/0xRayAI/xray/pull/122",
        "created_at": BEFORE,
        "updated_at": updated,
        "merged_at": None,
        "user": user,
        "head": {"sha": head, "ref": "arch1/wake"},
        "base": {"ref": "main"},
        "body": "",
        "labels": [],
    }


class WakePacket(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ff = type("Feed", (), {"CT": _zone()})()
        self.col = live_collect.RepoCollector("0xRayAI/xray", Path(self.tmp.name), ff, lambda *_a: None)
        self.col.st["bf"].update(QUIET)
        self.col.st["cur"]["pulls"] = BEFORE

    def _commits(self):
        return [e for e in self.col.ev.values() if e.get("kind") == "pr_commit"]

    def test_stored_head_and_author_with_no_user_routes_one_pr_update(self):
        self.col.st["prs"]["122"] = {
            "author": None, "updated_at": BEFORE, "head": OLD, "state": "open", "base": "main",
        }
        self.col.poll_pulls(Client([pull(NEW, WHEN, user=None)]))
        commits = self._commits()
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["from"], "GitHub")
        self.assertNotIn("Others", (commits[0]["from"], commits[0]["to"]))
        # Enrich would put the same sha again. A git name with no GitHub user must not delete it.
        self.col.pr_commit_event(122, NEW, WHEN, "push", "Ada Lovelace")
        commits = self._commits()
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["from"], "GitHub")
        lines = []
        for event in inbox_pass.adapt(commits):
            lines.extend(inbox_pass._direct_all(event, ROLES))
        critic = [line for line in lines if line.get("seat") == "critic" and line.get("type") == "pr_update"]
        self.assertEqual(len(critic), 1)
        self.assertNotEqual(critic[0].get("ask"), True)

    def test_missing_head_on_a_newer_update_is_a_head_change(self):
        self.col.st["prs"]["122"] = {"author": None, "updated_at": BEFORE, "state": "open", "base": "main"}
        self.col.poll_pulls(Client([pull(NEW, WHEN, user=None)]))
        self.assertEqual(len(self._commits()), 1)

    def test_same_stamp_without_a_stored_head_is_not_a_push(self):
        self.col.st["prs"]["122"] = {"author": None, "updated_at": WHEN, "state": "open", "base": "main"}
        self.col.poll_pulls(Client([pull(NEW, WHEN, user=None)]))
        self.assertEqual(self._commits(), [])

    def test_first_sighting_is_the_open_card_only(self):
        self.col.poll_pulls(Client([pull(NEW, WHEN, user=None)]))
        self.assertEqual(self._commits(), [])
        self.assertTrue(any(e.get("kind") == "pr_open" for e in self.col.ev.values()))

    def test_unmapped_login_is_kept(self):
        self.col.st["prs"]["122"] = {
            "author": None, "updated_at": BEFORE, "head": OLD, "state": "open", "base": "main",
        }
        self.col.poll_pulls(Client([pull(NEW, WHEN, user={"login": "ada-lovelace"})]))
        commits = self._commits()
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["from"], "GitHub")

    def test_needle_and_review_request_are_asks_and_a_head_line_is_not(self):
        note = {
            "id": "0xRayAI/xray!1261:comment:1",
            "t_ct": "2026-11-24T18:00:00-06:00",
            "from": "GitHub",
            "kind": "issue_comment",
            "label": "note",
            "repo": "0xRayAI/xray",
            "number": 1261,
            "mentions": ["arch10x"],
        }
        asked = [line for line in inbox_pass._direct_all(note, ROLES) if line.get("seat") == "arch1"]
        self.assertEqual(len(asked), 1)
        self.assertIs(asked[0].get("ask"), True)
        self.assertEqual(asked[0].get("routed_by"), "needle")
        review = inbox_pass.adapt([{
            "id": "0xRayAI/xray#122:ev:9",
            "t_ct": "2026-11-24T18:00:00-06:00",
            "from": "GitHub",
            "kind": "pr_review_requested",
            "label": "xray #122 review requested",
            "repo": "0xRayAI/xray",
            "number": 122,
        }])[0]
        critic = [line for line in inbox_pass._direct_all(review, ROLES) if line.get("ask") is True]
        self.assertEqual([(line.get("seat"), line.get("routed_by")) for line in critic], [("critic", "kind")])
        head = {
            "id": "0xRayAI/xray#122:commit:" + NEW,
            "t_ct": "2026-11-24T18:00:00-06:00",
            "from": "GitHub",
            "kind": "pr_update",
            "label": "xray #122 push",
            "repo": "0xRayAI/xray",
            "number": 122,
            "sha": NEW,
        }
        heads = inbox_pass._direct_all(head, ROLES)
        self.assertTrue(heads)
        self.assertTrue(all(line.get("ask") is not True for line in heads))
        fail = {
            "id": "0xRayAI/xray#122:ci",
            "t_ct": "2026-11-24T18:00:00-06:00",
            "from": "CI",
            "kind": "ci_fail",
            "label": "ci failed",
            "repo": "0xRayAI/xray",
            "number": 122,
        }
        forged = [line for line in inbox_pass._direct_all(fail, ROLES) if line.get("seat") == "forge"]
        self.assertTrue(forged)
        self.assertTrue(all(line.get("ask") is not True for line in forged))

    def test_an_ask_line_survives_deliver(self):
        note = {
            "id": "0xRayAI/xray!1261:comment:1",
            "t_ct": "2026-11-24T18:00:00-06:00",
            "from": "GitHub",
            "kind": "issue_comment",
            "label": "note",
            "repo": "0xRayAI/xray",
            "number": 1261,
            "mentions": ["arch10x"],
        }
        with tempfile.TemporaryDirectory() as directory:
            written = inbox_pass.inbox.deliver([note], directory=Path(directory), roles=ROLES, activity=[])
            self.assertEqual(written.get("arch1"), 1)
            row = json.loads((Path(directory) / "arch1.jsonl").read_text().splitlines()[0])
        self.assertIs(row.get("ask"), True)
        self.assertEqual(row.get("routed_by"), "needle")


if __name__ == "__main__":
    unittest.main()
