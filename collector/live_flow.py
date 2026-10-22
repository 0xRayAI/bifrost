"""Flow directions: a short hop list per event (feed node names), so pulses travel the real way.

Writes:    actor -> GitHub                       (PR open/edit/push, commit, comment, review, label, issue, tag)
Merge:     actor -> GitHub -> Railway -> host    (develop -> dev.example.com, main -> app.example.com)
CI:        GitHub -> PR author, or GitHub alone   (check runs/suites, workflow runs, non-Railway statuses; the CI
                                                  node is folded into GitHub, color = conclusion)
Reviewer:    Reviewer -> GitHub -> PR author
Deploy:    Railway -> host                       (SHA only on main -> app.example.com, else dev.example.com: heuristic,
                                                  Railway's status context does not name the host)
Lab retest: Tester -> GitHub;  /health: host -> product node;  board: Coord -> product node
Lab runs / calls: tester -> instance -> tester (dev.example.com, labtest, app.example.com);  bugs: tester -> instance
Operator:  Railway deploys it triggers / approvals: Operator -> Railway -> host;  live-mesh commits: Operator -> GitHub
Coord:       house files / house commits: Coord -> product node
Cloud agents: writes by cursoragent -> GitHub; cloud-agents.jsonl launch/reply -> Cloud agents, finished -> <by>
Prompts: <from> -> <to> (label 'message'; this flow never copies note or message text; any seat). Seats post with live-inbox --prompt. An old collector still reads prompts.jsonl. The node board is the path that keeps `note`.
Board view (apply): the three product instances collapse into one product node (site.json "node") and QaOne / QA two
fold into "QA"; the instance (dev / labtest / prod) and the seat (qa-one / qa-two) become short label tags.
A hop list that collapses to the product node alone (a /health change) is shown as Railway -> product node.
The page maps each name to a drawn node and skips any hop it cannot draw.
"""
import live_site  # noqa: E402

H = live_site.SITE["hosts"]
DEV, APP, GH, RW, CI = H["dev"], H["prod"], "GitHub", "Railway", "CI"
CI_KINDS = {"check_run", "check_suite", "workflow_run", "commit_status"}
CRITIC_KINDS = {"critic_pass", "critic_fail", "critic_hold", "critic_recheck"}
DEPLOY_KINDS = {"deploy", "deploy_fail", "deploy_pending"}
USM = live_site.SITE["node"]
COLLAPSE = {DEV: USM, APP: USM, "labtest": USM, "QaOne": "QA", "QaTwo": "QA", CI: GH}
TAG = {DEV: "dev", "labtest": "labtest", APP: "prod", "QaOne": "qa-one", "QaTwo": "qa-two"}


class Flow:
    def __init__(self, collectors, node):
        self.node = node
        self.author = {}    # (repo, pr number) -> author node
        self.sha_pr = {}    # (repo, sha) -> pr number
        self.main = {}      # repo -> set(shas on main)
        self.sha_author = {}
        for repo, col in collectors.items():
            for n, p in col.st.get("prs", {}).items():
                if p.get("author"):
                    self.author[(repo, int(n))] = node(p["author"])
                if p.get("head"):
                    self.sha_pr.setdefault((repo, p["head"]), int(n))
            bs = col.st.get("branch_shas", {})   # main-only SHAs (main shares develop's history)
            self.main[repo] = set(bs.get("main", {})) - set(bs.get("develop", {}))
            for e in col.ev.values():
                if e["kind"] == "pr_commit" and e.get("sha") and e.get("number"):
                    self.sha_pr.setdefault((repo, e["sha"]), e["number"])
                elif e["kind"] == "commit" and e.get("author"):
                    self.sha_author[(repo, e["sha"])] = node(e["author"])

    def host(self, repo, sha=None, base=None):
        if base:
            return APP if base == "main" else DEV
        return APP if sha and sha in self.main.get(repo, ()) else DEV

    def pr_author(self, e):
        repo = e.get("repo")
        n = e.get("number") or self.sha_pr.get((repo, e.get("sha") or e.get("head_sha")))
        if n and (repo, int(n)) in self.author:
            return self.author[(repo, int(n))]
        return self.sha_author.get((repo, e.get("sha") or e.get("head_sha")))

    def hops(self, e):
        k, frm, to = e["kind"], e.get("from"), e.get("to")
        actor = frm if frm not in (None, GH) else (GH if e.get("hops") == [GH] else "Others")   # re-apply safe
        if k in DEPLOY_KINDS:
            return [RW, self.host(e.get("repo"), e.get("sha"))]
        if k in CI_KINDS:
            a = self.pr_author(e)
            return [GH] + ([a] if a and a not in (GH, CI) else [])
        if k in CRITIC_KINDS:
            a = self.pr_author(e)
            return ["Reviewer", GH] + ([a] if a and a not in ("Reviewer", GH) else [])
        if k == "merged":
            base = e.get("base")
            tail = [RW, self.host(e.get("repo"), base=base)] if base in ("develop", "main") else []
            # A stored merge whose actor is GitHub is an unmapped merger (cursor[bot] -> Others, kept as GitHub).
            # The re-apply fallback above would demote that to Others, and fleet_only would drop the merge.
            merger = frm if frm not in (None, "Others") else GH
            return [merger, GH] + tail
        if k == "op_deploy":
            return ["Operator", RW] + ([e["instance"]] if e.get("instance") else [])
        if k == "op_commit":
            return ["Operator", GH]
        if k in ("cos_file", "cos_commit"):
            return ["Coord", USM]
        if k.startswith("lab_retest_"):
            return ["Tester", GH]
        if k.startswith("health_"):
            return [frm, USM]
        if k in ("lab_run", "lab_calls"):
            return [frm, e.get("instance") or to, frm]   # tester -> instance (calls), instance -> tester (results)
        if k.startswith(("lab_", "board_", "cloud_", "prompt_")):   # cloud_*: <by> -> Cloud agents, finished: Cloud agents -> <by>
            return [frm, to]
        return [actor, GH]   # writes: actor -> GitHub

    def apply(self, events):
        for e in events:
            raw = [x for x in self.hops(e) if x]
            tags = list(e.get("tags") or [])
            for x in raw + [e.get("instance")]:
                t = TAG.get(x)
                if t and t not in tags:
                    tags.append(t)
            h = []
            for x in (COLLAPSE.get(x, x) for x in raw):
                if not h or h[-1] != x:
                    h.append(x)
            if h == [USM]:
                h = [RW, USM]            # host-only flow (/health): Railway -> product node
            if h == [GH]:                # a check with no known author: a GitHub-only pulse
                e["hops"], e["from"], e["to"] = h, GH, GH
            if len(h) >= 2:
                prior = e.get("to")
                if isinstance(prior, str) and prior not in ("GitHub", "Railway", "Bifrost", "CI", "Others", "burst-live", "mymuse.house"):
                    e.setdefault("author_seat", prior)   # hop rewrite must not drop the PR author
                e["hops"] = h
                # round trips (tester -> instance -> tester) keep to = the instance; hops carry the return pulse
                e["from"], e["to"] = h[0], (h[1] if len(h) == 3 and h[0] == h[-1] else h[-1])
            if tags:
                tags.sort(key=lambda t: t in ("qa-one", "qa-two"))   # instance first, then seat
                e["tags"] = tags
                base = e.setdefault("label_base", e.get("label") or "")
                e["label"] = f"{base} · {' / '.join(tags)}"
        return events
