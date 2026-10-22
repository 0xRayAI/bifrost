#!/usr/bin/env python3
"""Read-only Railway deploy poller for the Operator node.

Two ways in, same sanitized file:
  - Collector: HTTPS GraphQL when RAILWAY_TOKEN is set. No token in this file. Projects come from
    RAILWAY_PROJECTS or LIVE_RAILWAY_TARGETS. Unset token leaves this path off.
  - Box watchdog: `railway deployment list --json` only (fixed argv: never approve, redeploy, up or
    variables), using the box CLI login, and only when RAILWAY_TOKEN is unset.

The file keeps a short deployment id, project/service/environment names, status, created time,
a short commit sha (commitHash, no message), and whether it came from a CLI upload.
No commit messages, authors, URLs, logs, or tokens.
"""
import json, os, subprocess, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = os.environ.get("RAILWAY_API_URL", "https://backboard.railway.com/graphql/v2")
PROJECT_QUERY = """
query($id: String!) {
  project(id: $id) {
    name
    services {
      edges {
        node {
          name
          deployments(first: 20) {
            edges {
              node { id status createdAt meta environment { name } }
            }
          }
        }
      }
    }
  }
}
"""
# project name, project id, service, environments. Set LIVE_RAILWAY_TARGETS to a JSON list of
# [project_name, project_id, service, [environments...]]; nothing is polled when it is unset.
TARGETS = [(p, i, s, tuple(e)) for p, i, s, e in json.loads(os.environ.get("LIVE_RAILWAY_TARGETS", "[]"))]
# example: [["app-project", "<project id>", "app", ["development", "production"]], ["mcp-project", "<project id>", "mcp", ["production"]]]
ALLOWED = ("deployment", "list")   # the only subcommand this script may run


def out_path():
    run = Path(os.environ.get("MESH_RUN", "/srv/live/run"))
    return Path(os.environ.get("LIVE_RAILWAY_FILE", run / "feed" / "railway-deploys.json"))


def _poll_s():
    # A deploy crosses BUILDING and DEPLOYING in well under three minutes. The old 180s gap
    # wrote only the terminal status. Each collector pass (about 45s) must refresh the file.
    try:
        n = int(os.environ.get("RAILWAY_POLL_S") or "15")
    except ValueError:
        n = 15
    return n if n > 0 else 15


def load_targets():
    """RAILWAY_PROJECTS is a JSON list of {project, projectId, service, environments}. Else LIVE_RAILWAY_TARGETS."""
    raw = os.environ.get("RAILWAY_PROJECTS", "").strip()
    if raw:
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("RAILWAY_PROJECTS")
        out = []
        for row in data:
            if not isinstance(row, dict):
                continue
            project = str(row.get("project") or "")[:40]
            pid = str(row.get("projectId") or row.get("project_id") or "")
            service = str(row.get("service") or "")[:40]
            envs = row.get("environments") or []
            if not project or not pid or not service or not isinstance(envs, list):
                continue
            names = tuple(str(e)[:24] for e in envs if isinstance(e, str) and e)
            if names:
                out.append((project, pid, service, names))
        return out
    return list(TARGETS)


def _post(body, auth):
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "Content-Type": "application/json", "User-Agent": "bifrost-live-feed", **auth})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def _gql(token, query, variables, fetch=None):
    body = json.dumps({"query": query, "variables": variables}).encode()
    if fetch is not None:
        return fetch(API, body, token)
    # Account/team tokens use Bearer; project tokens need Project-Access-Token (Bearer gets "Not Authorized").
    out = _post(body, {"Authorization": "Bearer " + token})
    if (out or {}).get("errors"):
        out = _post(body, {"Project-Access-Token": token})
    return out


def _rows_from(payload, pname, service, envs):
    project = ((payload or {}).get("data") or {}).get("project") or {}
    wanted = {e.casefold() for e in envs}
    rows = []
    for edge in ((project.get("services") or {}).get("edges") or []):
        node = (edge or {}).get("node") or {}
        if str(node.get("name") or "") != service:
            continue
        for dep in ((node.get("deployments") or {}).get("edges") or []):
            d = (dep or {}).get("node") or {}
            env = str(((d.get("environment") or {}).get("name")) or "")
            if env.casefold() not in wanted:
                continue
            meta = d.get("meta") if isinstance(d.get("meta"), dict) else {}
            rows.append({"id": str(d.get("id") or "")[:8], "project": pname, "service": service, "env": env[:12],
                         "status": str(d.get("status") or "")[:20], "created": d.get("createdAt"),
                         "sha": str(meta.get("commitHash") or "")[:40],
                         "cli": not bool(meta.get("commitHash"))})
    return rows


def poll(fetch=None, now=None):
    """Write the sanitized deploy file when RAILWAY_TOKEN is set. Returns the deployment count, or 0 when off."""
    token = os.environ.get("RAILWAY_TOKEN", "").strip()
    if not token:
        return 0
    outp = out_path()
    now = time.time() if now is None else now
    try:
        if outp.is_file() and now - outp.stat().st_mtime < _poll_s():
            return 0
    except OSError:
        pass
    rows, errors = [], []
    try:
        targets = load_targets()
    except (ValueError, TypeError):
        targets = []
        errors.append("RAILWAY_PROJECTS")
    for pname, pid, service, envs in targets:
        try:
            payload = _gql(token, PROJECT_QUERY, {"id": pid}, fetch=fetch)
            if (payload or {}).get("errors"):
                errors.append(f"{service}: graphql")
                continue
            rows.extend(_rows_from(payload, pname, service, envs))
        except Exception as ex:  # noqa: BLE001 (one target failing must not stop the others)
            errors.append(f"{service}: {type(ex).__name__}")
    if not rows and outp.is_file():
        try:
            prev = json.loads(outp.read_text())
            if isinstance(prev, dict) and isinstance(prev.get("deploys"), list):
                rows = prev["deploys"]
        except (OSError, ValueError):
            pass
    outp.parent.mkdir(parents=True, exist_ok=True)
    tmp = outp.with_suffix(f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps({"polled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "deploys": rows, "errors": errors}))
    os.replace(tmp, outp)
    return len(rows)


def list_deploys(pid, service, env):
    argv = ["railway", *ALLOWED, "--project", pid, "--service", service, "--environment", env, "--limit", "20", "--json"]
    assert argv[1:3] == list(ALLOWED)
    r = subprocess.run(argv, capture_output=True, text=True, timeout=45, cwd="/tmp")
    if r.returncode:
        raise RuntimeError(f"railway exit {r.returncode}")
    return json.loads(r.stdout or "[]")


def main():
    if os.environ.get("RAILWAY_TOKEN", "").strip():
        n = poll()
        print(f"host_poll: {n} deployments (token)", file=sys.stderr)
        return
    out, errors = [], []
    outp = out_path()
    for pname, pid, service, envs in TARGETS:
        for env in envs:
            try:
                for d in list_deploys(pid, service, env):
                    meta = d.get("meta") or {}
                    out.append({"id": str(d.get("id", ""))[:8], "project": pname, "service": service, "env": env,
                                "status": str(d.get("status", ""))[:20], "created": d.get("createdAt"),
                                "sha": str(meta.get("commitHash") or "")[:40],
                                "cli": not meta.get("commitHash")})
            except Exception as ex:   # noqa: BLE001 (one target failing must not stop the others)
                errors.append(f"{service}/{env}: {type(ex).__name__}")
    outp.parent.mkdir(parents=True, exist_ok=True)
    tmp = outp.with_suffix(f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps({"polled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "deploys": out, "errors": errors}))
    os.replace(tmp, outp)
    print(f"host_poll: {len(out)} deployments, {len(errors)} errors", file=sys.stderr)


if __name__ == "__main__":
    main()
