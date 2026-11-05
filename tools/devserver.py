"""Development harness for the Radar dashboard backend.

Mounts the plugin router at the same prefix the gateway uses, without touching
the running gateway or dashboard::

    /opt/hermes/.venv/bin/python -m uvicorn tools.devserver:app --port 8791

Then::

    curl -s 'http://127.0.0.1:8791/api/plugins/radar/live?profiles=all'
    curl -s 'http://127.0.0.1:8791/api/plugins/radar/view'

``RADAR_HOME`` selects the Hermes root (defaults to Hermes' own
resolver). This file is not part of the installable plugin.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse

ROOT = Path(__file__).resolve().parents[1]
API_FILE = ROOT / "dashboard" / "plugin_api.py"


def _load_plugin_api():
    spec = importlib.util.spec_from_file_location("radar_plugin_api_dev", API_FILE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {API_FILE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin_api = _load_plugin_api()

app = FastAPI(title="Radar (dev harness)")
app.include_router(plugin_api.router, prefix="/api/plugins/radar")


@app.get("/")
def index() -> RedirectResponse:
    return RedirectResponse("/api/plugins/radar/view")
