"""A collector pass must move the watchdog clock file, not only the big feed document."""
import importlib.util, json, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent / "collector" / "upstream"
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("fetch_feed", HERE / "fetch_feed.py")
ff = importlib.util.module_from_spec(spec); spec.loader.exec_module(ff)


def test_write_also_writes_beat():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "github-events.json"
        ff.write({"generated_at": "2026-11-10T08:00:00-06:00", "events": [], "event_count": 0}, out)
        beat = out.with_suffix(".beat.json")
        assert beat.exists() and beat.stat().st_size > 0
        hdr = json.loads(beat.read_text())
        assert "events" not in hdr and hdr["generated_at"].startswith("2026-11-10")


if __name__ == "__main__":
    test_write_also_writes_beat(); print("ok")
