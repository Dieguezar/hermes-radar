"""Hermes Radar plugin package.

The functional surface is the dashboard backend (``dashboard/plugin_api.py``)
plus the /view page it serves. Hermes' generic plugin loader imports this
package at startup, so this module exposes the required no-op ``register()``
hook: Radar registers no tools, hooks, middleware or commands.
"""


def register(ctx):
    """Register root-level Hermes extensions (none: UI/API-only plugin)."""
    return None
