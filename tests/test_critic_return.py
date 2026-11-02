"""A green head that is still critic's posts one ringing line. A pass on that sha does not."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
import ci_inbox  # noqa: E402

R = "example-org/app"
SHA = "b" * 40
SHA2 = "c" * 40


def ev(eid, kind, **extra):
    row = {"id": eid, "t_ct": extra.pop("t_ct", "2026-10-28T10:00:00-05:00"), "kind": kind, "repo": R}
    row.update(extra)
    return row


class CriticReturn(unittest.TestCase):
    def test_green_after_a_red_head_rings_critic(self):
        red = ev("bad", "ci_fail", number=9, sha=SHA, t_ct="2026-10-28T10:02:00-05:00")
        green = ev("ok", "ci_pass", number=9, sha=SHA2, t_ct="2026-10-28T10:05:00-05:00")
        lines = ci_inbox.critic_return_lines([red, green], [green])
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["seat"], "critic")
        self.assertEqual(lines[0]["kind"], "ci_pass")
        self.assertEqual(lines[0]["sha"], SHA2)

    def test_a_plain_green_head_does_not_ring_critic(self):
        green = ev("ok", "ci_pass", number=9, sha=SHA2)
        self.assertEqual(ci_inbox.critic_return_lines([green], [green]), [])

    def test_a_pass_on_the_green_sha_does_not_ring_critic(self):
        red = ev("bad", "ci_fail", number=9, sha=SHA, t_ct="2026-10-28T10:02:00-05:00")
        passed = ev("rev", "critic_pass", number=9, sha=SHA2, t_ct="2026-10-28T10:04:00-05:00")
        green = ev("ok", "ci_pass", number=9, sha=SHA2, t_ct="2026-10-28T10:05:00-05:00")
        self.assertEqual(ci_inbox.critic_return_lines([red, passed, green], [green]), [])

    def test_packet_next_owner_critic_rings_on_green(self):
        opened = ev("open", "pr_open", number=9, sha=SHA, packet={"next owner": "critic"})
        green = ev("ok", "ci_pass", number=9, sha=SHA, t_ct="2026-10-28T10:05:00-05:00")
        lines = ci_inbox.critic_return_lines([opened, green], [green])
        self.assertEqual([line["sha"] for line in lines], [SHA])

    def test_a_pass_on_the_old_sha_rings_the_new_green_head(self):
        passed = ev("rev", "critic_pass", number=9, sha=SHA, t_ct="2026-10-28T10:03:00-05:00")
        green = ev("ok", "ci_pass", number=9, sha=SHA2, t_ct="2026-10-28T10:05:00-05:00")
        lines = ci_inbox.critic_return_lines([passed, green], [green])
        self.assertEqual([line["sha"] for line in lines], [SHA2])


if __name__ == "__main__":
    unittest.main()
