# Vendored from example-org/xray PR #5 (cursor/seat-inbox-2826 @ 547c0c3a2) house/live/board.py; keep in sync, do not edit here.
"""Rebuild BOARD.md from the feed loop, at most once a minute.

The builder is optional. It runs as a subprocess with a timeout. A failure
stays in this process: the feed loop keeps writing. GitHub credentials passed
to the child are the read-only token, when one is set.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_SCRIPT = "/srv/fleet-house/house/watchers/build_board.py"
DEBOUNCE_S = 60
TIMEOUT_S = 90
_DROP = (
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GH_TOKEN",
    "GITHUB_TOKEN",
)


def script_path(env: dict | None = None) -> str:
    """Explicit path, or the template builder when that file is present. Off otherwise."""
    env = os.environ if env is None else env
    raw = env.get("LIVE_BOARD")
    if raw is None:
        return DEFAULT_SCRIPT if Path(DEFAULT_SCRIPT).is_file() else ""
    raw = raw.strip()
    if raw.lower() in ("", "0", "off", "false", "no"):
        return ""
    return raw


def read_only_env(base: dict | None = None) -> dict:
    """Drop App private-key material. Keep GITHUB_READ_TOKEN and pass only that as the git token."""
    base = os.environ if base is None else base
    env = {key: value for key, value in base.items() if key not in _DROP}
    read = base.get("GITHUB_READ_TOKEN", "").strip()
    if read:
        env["GITHUB_READ_TOKEN"] = read
        env["GH_TOKEN"] = read
        env["GITHUB_TOKEN"] = read
    env["LIVE_GITHUB_READONLY"] = "1"
    return env


class Board:
    """One builder. `last` is the clock value of the last attempt, including a failed one."""

    def __init__(self, script: str, debounce_s: float = DEBOUNCE_S, timeout_s: float = TIMEOUT_S,
                 clock=None, runner=None):
        self.script = script
        self.debounce_s = debounce_s
        self.timeout_s = timeout_s
        self.clock = time.monotonic if clock is None else clock
        self.runner = subprocess.run if runner is None else runner
        self.last: float | None = None

    def due(self, now: float | None = None) -> bool:
        if not self.script:
            return False
        now = self.clock() if now is None else now
        return self.last is None or now - self.last >= self.debounce_s

    def run(self, now: float | None = None, env: dict | None = None) -> str:
        """Return ran, skipped, or failed. Does not raise."""
        if not self.script:
            return "off"
        now = self.clock() if now is None else now
        if not self.due(now):
            return "skipped"
        self.last = now
        try:
            self.runner(
                [sys.executable, self.script],
                env=read_only_env(env),
                timeout=self.timeout_s,
                check=False,
                capture_output=True,
            )
        except Exception:
            return "failed"
        return "ran"


_STATE = Board("")


def maybe_board(new_count: int, env: dict | None = None, log=None) -> str:
    """Run the builder when this pass has new events and the debounce window is open."""
    global _STATE
    if new_count <= 0:
        return "idle"
    script = script_path(env)
    if not script:
        return "off"
    if _STATE.script != script:
        _STATE = Board(script)
    try:
        status = _STATE.run(env=env)
    except Exception as exc:
        status = "failed"
        if log:
            log(f"board failed ({type(exc).__name__})")
        return status
    if status == "failed" and log:
        log("board failed")
    return status
