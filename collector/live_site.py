"""Site config (feed/site.json, shipped beside the collector by app/deploy.sh). No file = the template defaults,
so other installs keep them. LIVE_SITE_JSON=<path> reads another file; LIVE_SITE_JSON= (empty) forces the defaults.
Keys: public, name (brand), title (feed header), node (the product node every instance collapses into),
hosts {dev, labtest, prod} (instance node names), services [{name, health}] (health URLs the collector polls)."""
import json, os
from pathlib import Path

DEFAULTS = {"public": False, "name": "Example", "title": "Example live mesh", "node": "Example",
            "hosts": {"dev": "dev.example.com", "labtest": "labtest", "prod": "app.example.com"},
            "services": [{"name": "dev.example.com", "health": "https://dev.example.com/health"},
                         {"name": "app.example.com", "health": "https://app.example.com/health"}]}


def load() -> dict:
    raw = os.environ.get("LIVE_SITE_JSON")
    path = Path(raw) if raw else Path(__file__).resolve().parent / "site.json"
    f = {}
    if raw != "":
        try:
            j = json.loads(path.read_text())
            f = j if isinstance(j, dict) else {}
        except (OSError, ValueError):
            f = {}
    out = {**DEFAULTS, **{k: v for k, v in f.items() if k in DEFAULTS and v not in (None, "")}}
    name = out["name"] if isinstance(out["name"], str) else "Example"
    if "title" not in f and name != "Example":
        out["title"] = f"{name} live mesh"
    if "node" not in f:
        out["node"] = name
    out["hosts"] = {**DEFAULTS["hosts"], **(f.get("hosts") if isinstance(f.get("hosts"), dict) else {})}
    svc = out["services"] if isinstance(out["services"], list) else []
    out["services"] = [s for s in svc if isinstance(s, dict) and isinstance(s.get("name"), str)]
    return out


SITE = load()
