"""The watchdog clock moves before a collector pass, not only after it."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "collector"))
os.environ.setdefault("LIVE_MESH_SRC", str(ROOT / "collector" / "upstream"))

import live_mesh  # noqa: E402


class PassBeatTest(unittest.TestCase):
    def test_start_beat_is_a_clock_and_a_later_touch_moves_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "github-events.json"
            out.write_text("{}\n", encoding="utf-8")
            live_mesh.touch_pass_beat(out)
            path = Path(tmp) / "github-events.beat.json"
            first = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("generated_at", first)
            self.assertNotIn("events", first)
            live_mesh.touch_pass_beat(out)
            second = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotEqual(second["generated_at"], first["generated_at"])

    def test_start_beat_keeps_the_previous_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "github-events.json"
            out.write_text("{}\n", encoding="utf-8")
            prior = Path(tmp) / "github-events.beat.json"
            prior.write_text(json.dumps({"generated_at": "old", "repos_unreadable": ["a/b"], "events": [1], "board": {}}) + "\n", encoding="utf-8")
            live_mesh.touch_pass_beat(out)
            got = json.loads(prior.read_text(encoding="utf-8"))
            self.assertEqual(got["repos_unreadable"], ["a/b"])
            self.assertNotIn("events", got)
            self.assertNotIn("board", got)
            self.assertNotEqual(got["generated_at"], "old")


if __name__ == "__main__":
    unittest.main()
