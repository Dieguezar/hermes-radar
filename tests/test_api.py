"""Radar backend tests.

Runs under pytest (``python -m pytest tests -q``) and, because this container's
Hermes venv ships without pytest, also as a plain script::

    /opt/hermes/.venv/bin/python tests/test_api.py

Every test builds throwaway SQLite databases with the minimal Hermes schema and
never touches the real ``/opt/data`` state.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import inspect
import json
import os
import re
import sqlite3
import struct
import sys
import tempfile
import time
import traceback
import zlib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def load_api():
    """Load ``dashboard/plugin_api.py`` by path (the dashboard dir is not a package)."""
    spec = importlib.util.spec_from_file_location(
        "session_pulse_plugin_api", ROOT / "dashboard" / "plugin_api.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = load_api()


# ---------------------------------------------------------------------------
# Fixtures (stdlib only)
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    profile_name TEXT,
    model TEXT,
    title TEXT,
    display_name TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    last_activity_at REAL,
    last_activity_description TEXT,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    cwd TEXT,
    git_branch TEXT,
    parent_session_id TEXT,
    source TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE session_turn_leases (
    conversation_id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE session_admissions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    intent TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT
);
CREATE TABLE async_delegations (
    delegation_id TEXT PRIMARY KEY,
    origin_session TEXT NOT NULL,
    parent_session_id TEXT,
    state TEXT NOT NULL,
    dispatched_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL
);
CREATE INDEX idx_messages_assistant_calls_by_session
    ON messages(session_id) WHERE role = 'assistant' AND tool_calls IS NOT NULL;
"""


def new_db(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    return path


def add_session(db: Path, session_id: str, **fields: Any) -> None:
    values = {
        "id": session_id,
        "profile_name": "default",
        "model": "test-model",
        "title": f"Session {session_id}",
        "display_name": None,
        "started_at": time.time() - 600,
        "ended_at": None,
        "last_activity_at": time.time() - 10,
        "last_activity_description": "",
        "end_reason": None,
        "message_count": 3,
        "tool_call_count": 1,
        "input_tokens": 100,
        "output_tokens": 50,
        "estimated_cost_usd": 0.0123,
        "cwd": "/work/project",
        "git_branch": "main",
        "parent_session_id": None,
        "source": "desktop",
        "archived": 0,
        "hidden": 0,
    }
    values.update(fields)
    columns = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    conn = sqlite3.connect(db)
    conn.execute(f"INSERT INTO sessions ({columns}) VALUES ({marks})", tuple(values.values()))
    conn.commit()
    conn.close()


def add_lease(db: Path, session_id: str, expires_at: float, acquired_at: float | None = None) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO session_turn_leases (conversation_id, holder, acquired_at, expires_at) "
        "VALUES (?, ?, ?, ?)",
        (session_id, "pid=1:turn=" + session_id, acquired_at or time.time() - 30, expires_at),
    )
    conn.commit()
    conn.close()


def add_queued_admission(db: Path, session_id: str, admission_id: str) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO session_admissions "
        "(admission_id, request_id, principal_id, target_session_id, intent, status) "
        "VALUES (?, ?, ?, ?, 'queue', 'queued')",
        (admission_id, "req-" + admission_id, "principal", session_id),
    )
    conn.commit()
    conn.close()


def add_message(db: Path, session_id: str, role: str, *, tool_calls: str | None = None,
                tool_call_id: str | None = None, timestamp: float | None = None) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, timestamp) "
        "VALUES (?, ?, '', ?, ?, ?)",
        (session_id, role, tool_calls, tool_call_id, timestamp or time.time()),
    )
    conn.commit()
    conn.close()


def make_home() -> tuple[tempfile.TemporaryDirectory, Path]:
    tmp = tempfile.TemporaryDirectory(prefix="radar-test-")
    home = Path(tmp.name)
    new_db(home / "state.db")
    new_db(home / "profiles" / "maca" / "state.db")
    return tmp, home


def write_png(path: Path, rgb: tuple[int, int, int] = (255, 77, 0), size: int = 4) -> bytes:
    """A real, tiny RGB PNG (signature + IHDR + IDAT + IEND)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    return png


def write_profile_yaml(profile_dir: Path, text: str) -> None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "profile.yaml").write_text(text, encoding="utf-8")


def dir_fingerprint(path: Path) -> dict[str, tuple[str, int, int]]:
    result: dict[str, tuple[str, int, int]] = {}
    for child in sorted(path.iterdir()):
        if child.is_file():
            stat = child.stat()
            result[child.name] = (
                hashlib.sha256(child.read_bytes()).hexdigest(),
                stat.st_size,
                stat.st_mtime_ns,
            )
    return result


def states_of(snapshot: dict[str, Any]) -> dict[str, str]:
    return {item["id"]: item["state"] for item in snapshot["sessions"]}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_states_are_classified() -> None:
    tmp, home = make_home()
    try:
        db = home / "state.db"
        now = 1_800_000_000.0
        add_session(db, "run", last_activity_at=now - 10)
        add_lease(db, "run", expires_at=now + 60, acquired_at=now - 40)
        add_session(db, "queue", last_activity_at=now - 10)
        add_queued_admission(db, "queue", "adm-1")
        add_session(db, "idle", last_activity_at=now - 10)
        add_session(db, "stalled", last_activity_at=now - 30)
        add_lease(db, "stalled", expires_at=now - 5, acquired_at=now - 120)
        add_session(db, "dormant", last_activity_at=now - 5000)
        add_session(db, "done", last_activity_at=now - 10, ended_at=now - 5, end_reason="agent_close")
        add_session(db, "failed", last_activity_at=now - 10, ended_at=now - 5, end_reason="error: boom")

        snapshot = api.build_snapshot(home=home, profiles="all", window=180, now=now)
        states = states_of(snapshot)
        assert states == {
            "run": "running",
            "queue": "queued",
            "idle": "idle",
            "stalled": "stalled",
            "done": "done",
            "failed": "failed",
        }, states
        assert snapshot["totals"] == {
            "running": 1, "queued": 1, "stalled": 1, "idle": 1,
            "done": 1, "failed": 1, "live": 3, "dormant": 1, "sessions": 6,
        }, snapshot["totals"]

        running = next(s for s in snapshot["sessions"] if s["id"] == "run")
        assert running["elapsed_s"] == 40, running
        assert running["stalled"] is False
        assert snapshot["sessions"][0]["state"] == "running"
        assert snapshot["profiles"] == ["default", "maca"]
    finally:
        tmp.cleanup()


def test_open_session_outside_the_window_is_dormant() -> None:
    """An abandoned row is history, not a live red warning (D2)."""
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        db = home / "state.db"
        add_session(db, "old-open", last_activity_at=now - 10 * 86400, end_reason=None)
        add_session(db, "fresh", last_activity_at=now - 5)

        snapshot = api.build_snapshot(home=home, window=180, now=now)
        assert states_of(snapshot) == {"fresh": "idle"}
        assert snapshot["totals"]["stalled"] == 0, snapshot["totals"]
        assert snapshot["totals"]["live"] == 0, snapshot["totals"]
        assert snapshot["totals"]["dormant"] == 1, snapshot["totals"]
        assert snapshot["totals"]["sessions"] == 1, snapshot["totals"]
    finally:
        tmp.cleanup()


def test_expired_lease_is_stalled() -> None:
    tmp, home = make_home()
    try:
        db = home / "state.db"
        now = 1_800_000_000.0
        add_session(db, "hung", last_activity_at=now - 30)
        add_lease(db, "hung", expires_at=now - 5, acquired_at=now - 90)
        snapshot = api.build_snapshot(home=home, window=180, now=now)
        assert states_of(snapshot)["hung"] == "stalled"
        item = next(s for s in snapshot["sessions"] if s["id"] == "hung")
        assert item["stalled"] is True

        # The same expired lease, ten days later, is dormant: the 30-minute
        # recency gate is what keeps "stalled" honest.
        add_session(db, "abandoned", last_activity_at=now - 10 * 86400)
        add_lease(db, "abandoned", expires_at=now - 10 * 86400 + 60, acquired_at=now - 10 * 86400 - 60)
        snapshot = api.build_snapshot(home=home, window=180, now=now)
        assert "abandoned" not in states_of(snapshot)
        assert snapshot["totals"]["dormant"] == 1, snapshot["totals"]
        assert snapshot["totals"]["stalled"] == 1, snapshot["totals"]
    finally:
        tmp.cleanup()


def test_failure_without_end_timestamp_is_stalled() -> None:
    """A failing reason on an open row never closed cleanly: it needs attention."""
    tmp, home = make_home()
    try:
        db = home / "state.db"
        now = 1_800_000_000.0
        add_session(db, "crashed", last_activity_at=now - 20, end_reason="timeout: provider", ended_at=None)
        add_session(
            db, "closed",
            last_activity_at=now - 20, ended_at=now - 10, end_reason="timeout: provider",
        )
        snapshot = api.build_snapshot(home=home, window=180, now=now)
        states = states_of(snapshot)
        assert states["crashed"] == "stalled", states
        assert states["closed"] == "failed", states
        assert snapshot["totals"]["live"] == 1, snapshot["totals"]
        assert snapshot["totals"]["failed"] == 1, snapshot["totals"]
    finally:
        tmp.cleanup()


def test_profile_filter() -> None:
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        add_session(home / "state.db", "root-1", last_activity_at=now - 5)
        add_session(home / "profiles" / "maca" / "state.db", "maca-1", last_activity_at=now - 5)

        everything = api.build_snapshot(home=home, profiles="all", window=180, now=now)
        assert everything["profiles"] == ["default", "maca"]
        assert {s["profile"] for s in everything["sessions"]} == {"default", "maca"}

        only_maca = api.build_snapshot(home=home, profiles="maca", window=180, now=now)
        assert only_maca["profiles"] == ["maca"]
        assert [s["id"] for s in only_maca["sessions"]] == ["maca-1"]

        missing = api.build_snapshot(home=home, profiles="nope", window=180, now=now)
        assert missing["profiles"] == []
        assert missing["sessions"] == []

        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(home / "profiles" / "maca")
        try:
            current = api.build_snapshot(home=home, profiles="current", window=180, now=now)
            assert current["profiles"] == ["maca"], current["profiles"]
        finally:
            if previous is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = previous
    finally:
        tmp.cleanup()


def test_pending_tool_detection() -> None:
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        db = home / "state.db"
        add_session(db, "with-tool", last_activity_at=now - 5)
        add_message(
            db, "with-tool", "assistant",
            tool_calls='[{"call_id": "call-1", "function": {"name": "terminal"}}]',
            timestamp=now - 4,
        )
        add_session(db, "answered-tool", last_activity_at=now - 5)
        add_message(
            db, "answered-tool", "assistant",
            tool_calls='[{"call_id": "call-2", "function": {"name": "read_file"}}]',
            timestamp=now - 4,
        )
        add_message(db, "answered-tool", "tool", tool_call_id="call-2", timestamp=now - 3)

        api._TOOL_CACHE.clear()
        snapshot = api.build_snapshot(home=home, window=180, now=now)
        by_id = {s["id"]: s for s in snapshot["sessions"]}
        assert by_id["with-tool"]["tool"] == "terminal", by_id["with-tool"]
        assert by_id["with-tool"]["activity"] == "terminal"
        assert by_id["answered-tool"]["tool"] is None, by_id["answered-tool"]
        assert by_id["answered-tool"]["activity"] == ""
    finally:
        api._TOOL_CACHE.clear()
        tmp.cleanup()


def test_read_only_no_writes() -> None:
    tmp, home = make_home()
    try:
        db = home / "state.db"
        now = 1_800_000_000.0
        add_session(db, "idle", last_activity_at=now - 10)
        before = dir_fingerprint(home)
        api.build_snapshot(home=home, window=180, now=now)
        after = dir_fingerprint(home)
        assert before == after, "state.db directory changed during a read-only snapshot"

        conn = api._connect(db)
        try:
            assert conn.execute("PRAGMA query_only").fetchone()[0] == 1
            try:
                conn.execute("CREATE TABLE should_fail (x INTEGER)")
            except sqlite3.DatabaseError:
                pass
            else:
                raise AssertionError("read-only connection accepted a write")
        finally:
            conn.close()
        assert dir_fingerprint(home) == before
    finally:
        tmp.cleanup()


def test_in_flight_delegation_keeps_session_running() -> None:
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        db = home / "state.db"
        add_session(db, "parent", last_activity_at=now - 20)
        conn = sqlite3.connect(db)
        conn.execute(
            "INSERT INTO async_delegations "
            "(delegation_id, origin_session, state, dispatched_at, updated_at) "
            "VALUES ('d1', 'parent', 'running', ?, ?)",
            (now - 20, now - 5),
        )
        conn.commit()
        conn.close()
        snapshot = api.build_snapshot(home=home, window=180, now=now)
        item = next(s for s in snapshot["sessions"] if s["id"] == "parent")
        assert item["state"] == "running"
        assert item["delegating"] == 1
    finally:
        tmp.cleanup()


def test_live_endpoint_and_view_html() -> None:
    tmp, home = make_home()
    previous_home = os.environ.get("RADAR_HOME")
    previous_watcher = os.environ.get("RADAR_DISABLE_WATCHER")
    try:
        add_session(home / "state.db", "endpoint", last_activity_at=time.time() - 5)
        os.environ["RADAR_HOME"] = str(home)
        os.environ["RADAR_DISABLE_WATCHER"] = "1"

        payload = api.live(window=180, profiles="all")
        assert payload["profiles"] == ["default", "maca"]
        assert [s["id"] for s in payload["sessions"]] == ["endpoint"]
        assert payload["totals"]["sessions"] == 1

        response = api.view(window=180, profiles="all")
        html = response.body.decode("utf-8") if isinstance(response.body, bytes) else str(response.body)
        assert html.lower().startswith("<!doctype html")
        assert "setInterval(tick" in html
        assert "live?profiles=" in html
        # D1: the const must not shadow the global URL constructor.
        assert "const LIVE_URL = new URL(" in html
        assert "const URL =" not in html
        # D3: the product surface, not the old minimal grid.
        assert "Ninguna sesión activa" in html
        assert "inactivas" in html
        assert "conectando" in html
        assert api._WATCHER is None  # watcher stayed disabled
    finally:
        if previous_home is None:
            os.environ.pop("RADAR_HOME", None)
        else:
            os.environ["RADAR_HOME"] = previous_home
        if previous_watcher is None:
            os.environ.pop("RADAR_DISABLE_WATCHER", None)
        else:
            os.environ["RADAR_DISABLE_WATCHER"] = previous_watcher
        tmp.cleanup()


def test_window_is_clamped() -> None:
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        add_session(home / "state.db", "recent", last_activity_at=now - 10)
        add_session(home / "state.db", "old", last_activity_at=now - 4000)
        tight = api.build_snapshot(home=home, window=1, now=now)
        assert tight["window_s"] == api.MIN_WINDOW_S
        assert "old" not in states_of(tight)
        assert tight["totals"]["dormant"] == 1
        assert tight["totals"]["sessions"] == 1

        wide = api.build_snapshot(home=home, window=10**9, now=now)
        assert wide["window_s"] == api.MAX_WINDOW_S
        assert states_of(wide)["old"] == "idle"
        assert wide["totals"]["dormant"] == 0
        assert wide["totals"]["sessions"] == 2
    finally:
        tmp.cleanup()


# ---------------------------------------------------------------------------
# F2 payload contract (interrupt, labels, order, portability)
# ---------------------------------------------------------------------------


def test_payload_exposes_interrupt_contract_and_profile_label() -> None:
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        add_session(home / "state.db", "run", last_activity_at=now - 10)
        add_lease(home / "state.db", "run", expires_at=now + 60, acquired_at=now - 40)
        add_session(home / "state.db", "hung", last_activity_at=now - 30)
        add_lease(home / "state.db", "hung", expires_at=now - 5, acquired_at=now - 120)
        add_session(home / "state.db", "waiting", last_activity_at=now - 10)
        add_queued_admission(home / "state.db", "waiting", "adm-2")
        add_session(home / "state.db", "still", last_activity_at=now - 10)
        add_session(home / "profiles" / "maca" / "state.db", "maca-idle", last_activity_at=now - 10)

        snapshot = api.build_snapshot(home=home, profiles="all", window=180, now=now)
        by_id = {item["id"]: item for item in snapshot["sessions"]}

        assert by_id["run"]["can_interrupt"] is True
        assert by_id["hung"]["can_interrupt"] is True
        assert by_id["waiting"]["can_interrupt"] is False
        assert by_id["still"]["can_interrupt"] is False
        assert by_id["maca-idle"]["can_interrupt"] is False

        assert by_id["still"]["profile_label"] == "default"
        assert by_id["maca-idle"]["profile_label"] == "maca"
        for item in snapshot["sessions"]:
            assert isinstance(item["profile_label"], str) and item["profile_label"]
    finally:
        tmp.cleanup()


def test_order_is_state_then_elapsed_descending() -> None:
    tmp, home = make_home()
    try:
        db = home / "state.db"
        now = 1_800_000_000.0
        # running: elapsed from the lease, longest first
        add_session(db, "run-short", last_activity_at=now - 10)
        add_lease(db, "run-short", expires_at=now + 60, acquired_at=now - 10)
        add_session(db, "run-long", last_activity_at=now - 10)
        add_lease(db, "run-long", expires_at=now + 60, acquired_at=now - 90)
        # stalled: elapsed from the last activity
        add_session(db, "stall", last_activity_at=now - 40)
        add_lease(db, "stall", expires_at=now - 5, acquired_at=now - 200)
        # queued and idle
        add_session(db, "queue", last_activity_at=now - 20)
        add_queued_admission(db, "queue", "adm-3")
        add_session(db, "idle", last_activity_at=now - 5)

        snapshot = api.build_snapshot(home=home, window=180, now=now)
        assert [item["id"] for item in snapshot["sessions"]] == [
            "run-long",
            "run-short",
            "stall",
            "queue",
            "idle",
        ], [(item["id"], item["state"], item["elapsed_s"]) for item in snapshot["sessions"]]
        assert [item["elapsed_s"] for item in snapshot["sessions"][:2]] == [90, 10]
    finally:
        tmp.cleanup()


def test_read_only_uri_is_portable_and_survives_spaces() -> None:
    """``Path.as_uri()`` handles spaces/unicode and the Windows drive form."""
    tmp = tempfile.TemporaryDirectory(prefix="radar ")
    try:
        home = Path(tmp.name) / "Hermes Data"
        db = new_db(home / "state.db")
        now = 1_800_000_000.0
        add_session(db, "spaced", last_activity_at=now - 5)

        uri = api._read_only_uri(db)
        assert uri.startswith("file:///"), uri
        assert uri.endswith("?mode=ro"), uri
        assert " " not in uri, uri
        assert "%20" in uri, uri
        # Windows turns the same builder into file:///C:/...; sqlite3 accepts
        # that drive form with uri=True exactly like the POSIX form below.
        assert "\\" not in uri and "//C:" not in uri

        conn = sqlite3.connect(uri, uri=True)
        try:
            assert conn.execute("SELECT id FROM sessions").fetchone()[0] == "spaced"
        finally:
            conn.close()

        snapshot = api.build_snapshot(home=home, window=180, now=now)
        assert [item["id"] for item in snapshot["sessions"]] == ["spaced"]
    finally:
        tmp.cleanup()


def test_no_posix_only_primitives_in_the_backend() -> None:
    """The plugin must run on Windows: no fork/signals/POSIX permissions."""
    source = (ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    for banned in ("import fcntl", "import signal", "os.fork", "os.sep", "st_mode", "os.chmod"):
        assert banned not in source, banned


def test_manifest_declares_desktop_plugin_platforms() -> None:
    """macOS is untested, so the manifest must not promise it."""
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    block = re.search(r"^platforms:\s*$(.*?)(?=^\S|\Z)", text, re.MULTILINE | re.DOTALL)
    inline = re.search(r"^platforms:\s*\[(.+)\]\s*$", text, re.MULTILINE)
    if block:
        declared = block.group(1)
    elif inline:
        declared = inline.group(1)
    else:
        declared = ""
    assert "linux" in declared, declared
    assert "windows" in declared, declared
    assert "macos" not in declared, declared


# ---------------------------------------------------------------------------
# F2 backend hardening (SQLite fallbacks, generation, isolation, cadence)
# ---------------------------------------------------------------------------


def test_candidate_uris_include_documented_fallbacks() -> None:
    """Read-only candidates follow the documented order and never weaken ``mode=ro``."""
    tmp, home = make_home()
    wal = Path(str(home / "state.db") + "-wal")
    shm = Path(str(home / "state.db") + "-shm")
    original_os_name = api.os.name
    try:
        db = home / "state.db"
        base = Path(db).resolve().as_uri()

        # No sidecars: the immutable fallback is allowed.
        assert api._candidate_uris(db) == [
            base + "?mode=ro",
            base + "?mode=ro&immutable=1",
        ], api._candidate_uris(db)

        # A -wal sidecar means another process may be writing: immutable is unsafe.
        wal.write_bytes(b"")
        try:
            if original_os_name != "nt":
                assert api._candidate_uris(db) == [base + "?mode=ro"], api._candidate_uris(db)
        finally:
            wal.unlink()

        # Windows with sidecars present gets the shared-memory fallback.
        wal.write_bytes(b"")
        shm.write_bytes(b"")
        api.os.name = "nt"
        try:
            candidates = api._candidate_uris(db)
        finally:
            api.os.name = original_os_name
            wal.unlink()
            shm.unlink()
        assert candidates[0] == base + "?mode=ro", candidates
        assert candidates[-1] == base + "?mode=ro&readonly_shm=1", candidates
        for uri in candidates:
            assert "mode=ro" in uri, uri
    finally:
        api.os.name = original_os_name
        for sidecar in (wal, shm):
            try:
                sidecar.unlink()
            except OSError:
                pass
        tmp.cleanup()


def test_connect_retries_the_next_candidate() -> None:
    """The first URI may fail (locked/permissions); the next one must be tried."""
    tmp, home = make_home()
    real_connect = sqlite3.connect
    attempts: list[str] = []
    try:
        now = 1_800_000_000.0
        add_session(home / "state.db", "retried", last_activity_at=now - 5)

        def flaky_connect(database: Any, *args: Any, **kwargs: Any) -> Any:
            attempts.append(str(database))
            if len(attempts) == 1:
                raise sqlite3.OperationalError("unable to open database file")
            return real_connect(database, *args, **kwargs)

        api._TOOL_CACHE.clear()
        api.sqlite3.connect = flaky_connect
        try:
            snapshot = api.build_snapshot(home=home, profiles="default", window=180, now=now)
        finally:
            api.sqlite3.connect = real_connect

        assert [item["id"] for item in snapshot["sessions"]] == ["retried"], snapshot
        assert "profile_errors" not in snapshot, snapshot.get("profile_errors")
        assert len(attempts) == 2, attempts
        assert "immutable=1" in attempts[1], attempts
    finally:
        api.sqlite3.connect = real_connect
        api._TOOL_CACHE.clear()
        tmp.cleanup()


def test_can_interrupt_only_for_running_and_stalled() -> None:
    """Stopping is meaningful only for a live or hung turn, never for queued rows."""
    tmp, home = make_home()
    try:
        db = home / "state.db"
        now = 1_800_000_000.0
        add_session(db, "run", last_activity_at=now - 10)
        add_lease(db, "run", expires_at=now + 60, acquired_at=now - 40)
        add_session(db, "stall", last_activity_at=now - 30)
        add_lease(db, "stall", expires_at=now - 5, acquired_at=now - 120)
        add_session(db, "queue", last_activity_at=now - 10)
        add_queued_admission(db, "queue", "adm-int")
        add_session(db, "idle", last_activity_at=now - 10)
        add_session(db, "done", last_activity_at=now - 10, ended_at=now - 5, end_reason="agent_close")
        add_session(db, "failed", last_activity_at=now - 10, ended_at=now - 5, end_reason="error: boom")
        add_session(db, "dormant", last_activity_at=now - 5000)

        snapshot = api.build_snapshot(home=home, profiles="default", window=180, now=now)
        by_id = {item["id"]: item for item in snapshot["sessions"]}

        interruptible = {sid for sid, item in by_id.items() if item["can_interrupt"]}
        assert interruptible == {"run", "stall"}, interruptible
        assert by_id["run"]["stalled"] is False
        assert by_id["stall"]["stalled"] is True
        for sid in ("queue", "idle", "done", "failed"):
            assert by_id[sid]["stalled"] is False, by_id[sid]

        assert "dormant" not in by_id
        assert snapshot["totals"]["dormant"] == 1, snapshot["totals"]
    finally:
        tmp.cleanup()


def test_corrupt_profile_is_isolated() -> None:
    """One unreadable state.db must never abort the snapshot."""
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        add_session(home / "state.db", "healthy", last_activity_at=now - 5)
        broken = home / "profiles" / "broken" / "state.db"
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_bytes(b"this is not a sqlite database")

        snapshot = api.build_snapshot(home=home, profiles="all", window=180, now=now)

        assert [item["id"] for item in snapshot["sessions"]] == ["healthy"], snapshot["sessions"]
        errors = snapshot.get("profile_errors") or {}
        assert isinstance(errors.get("broken"), str), errors
        assert errors["broken"].strip(), errors
        assert "default" not in errors, errors
    finally:
        tmp.cleanup()


def test_execution_generation_from_runtime_generation() -> None:
    """``execution_generation`` mirrors ``sessions.runtime_generation``, or None."""
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        db = home / "state.db"
        add_session(db, "gen-7", last_activity_at=now - 5)
        add_session(db, "gen-null", last_activity_at=now - 5)
        conn = sqlite3.connect(db)
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN runtime_generation INTEGER")
            conn.execute("UPDATE sessions SET runtime_generation = 7 WHERE id = 'gen-7'")
            conn.commit()
        finally:
            conn.close()

        snapshot = api.build_snapshot(home=home, profiles="default", window=180, now=now)
        by_id = {item["id"]: item for item in snapshot["sessions"]}
        assert by_id["gen-7"]["execution_generation"] == 7, by_id["gen-7"]
        assert by_id["gen-null"]["execution_generation"] is None, by_id["gen-null"]
        for item in snapshot["sessions"]:
            assert "execution_generation" in item, item

        # A schema without the column keeps the payload shape stable.
        add_session(home / "profiles" / "maca" / "state.db", "no-gen", last_activity_at=now - 5)
        bare = api.build_snapshot(home=home, profiles="maca", window=180, now=now)
        assert [item["id"] for item in bare["sessions"]] == ["no-gen"], bare["sessions"]
        assert bare["sessions"][0]["execution_generation"] is None, bare["sessions"][0]
    finally:
        tmp.cleanup()


def test_watch_interval_respects_broadcast_floor() -> None:
    """The watcher must not broadcast faster than the 2 s floor."""
    assert api.WATCH_INTERVAL_S >= 2.0, api.WATCH_INTERVAL_S
    floor = getattr(api, "BROADCAST_FLOOR_S", None)
    assert floor is not None and floor >= 2.0, floor

    source = (ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    assert "BROADCAST_FLOOR_S" in source, "rate guard constant missing from the module"

    loop_source = inspect.getsource(api._watch_loop)
    assert "BROADCAST_FLOOR_S" in loop_source, loop_source
    assert "monotonic" in loop_source, loop_source


# ---------------------------------------------------------------------------
# Desktop half contract (verified SDK findings)
# ---------------------------------------------------------------------------


def test_desktop_plugin_contract() -> None:
    """The floating pane follows the verified SDK contract, not the undocumented gates."""
    path = ROOT / "desktop" / "plugin.js"
    assert path.is_file(), path
    source = path.read_text(encoding="utf-8")
    code = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    code = re.sub(r"//[^\n]*", "", code)

    specifiers = set(re.findall(r"""from\s+['"]([^'"]+)['"]""", code))
    assert specifiers <= {"@hermes/plugin-sdk", "react", "react/jsx-runtime"}, specifiers
    assert "react/jsx-runtime" in specifiers, specifiers

    # Placement the renderer implements but the public SDK doc does not list.
    assert "placement: 'floating'" in code
    assert "anchor: 'bottom-right'" in code
    assert "width: '320px'" in code
    assert "height: '214px'" in code

    # Findings 2 and 3: no visibility gate, and the body must unmount on collapse.
    assert "lifecycleKeepAlive" not in code, "the floating body must unmount on collapse"
    assert "paneVisibility" not in code, "paneVisibility is always false for a floating pane"
    assert "host.openSession(" in code, "opening is host.openSession, not session.activate"
    assert "'session.interrupt'" in code

    # Finding 4: the handler ignores execution_generation and never answers
    # stale_generation, so the panel must fence with a fresh /live read.
    assert "stale_generation" not in code, "the retry described an API that does not exist"
    assert "cambió de turno" in code
    assert "await ctx.rest(LIVE_PATH)" in code

    # Finding 2/nit 19: a real open button plus a mounted, focusable stop button.
    assert ".sp-row:focus-within .sp-stop" in code
    assert "role: 'button'" not in code
    assert "tabIndex: 0" not in code
    assert ".sp-stop{opacity:0" in code

    # Finding 3: no light-only literal survives in avatar/dot/accent ink.
    for literal in ("#9ecbff", "#7ee2a8", "#d2a8ff", "#c9d1d9", "#ff8f70", "#a5d6ff", "#bc8cff"):
        assert literal not in code, literal
    assert "color-mix(in srgb, ' + FG" in code
    assert "var(--dt-foreground)" in code

    assert "/live?profiles=all&window=180" in code
    assert "plugin.radar.changed" in code


def test_desktop_behaviour_harness() -> None:
    """Run the Node harness that exercises the real component logic."""
    import subprocess

    harness = ROOT / "tests" / "desktop_behaviour.test.mjs"
    assert harness.is_file(), harness
    result = subprocess.run(
        ["node", str(harness)], capture_output=True, text=True, timeout=180
    )
    assert result.returncode == 0, (result.stdout or "") + (result.stderr or "")
    assert "passed" in result.stdout, result.stdout


# ---------------------------------------------------------------------------
# F3 review fixes (XSS, watcher lifetime, cache, /view surface)
# ---------------------------------------------------------------------------


def _view_html(**kwargs: Any) -> str:
    response = api.view(**kwargs)
    return response.body.decode("utf-8") if isinstance(response.body, bytes) else str(response.body)


def test_view_never_reflects_the_profile_query() -> None:
    """The blocking XSS: no attacker-controlled selector reaches the markup."""
    tmp, home = make_home()
    previous = os.environ.get("RADAR_HOME")
    try:
        os.environ["RADAR_HOME"] = str(home)
        payload = "</script><img src=x onerror=window.__pwned=42>"
        html = _view_html(window=180, profiles=payload)

        assert payload not in html
        assert "</script><img" not in html
        assert html.count("</script>") == 1, "the page must keep exactly one script block"
        # Nothing resolved from the payload: the page embeds ``none``.
        assert 'const PROFILES = "none";' in html, html[:400]

        # The brief's exact probe, on its own.
        probe = _view_html(profiles="</script><b>")
        assert "</script><b>" not in probe
        assert probe.count("</script>") == 1

        # A profile directory name is data, but it is still escaped on the way in.
        evil = home / "profiles" / "<b>&x" / "state.db"
        new_db(evil)
        html = _view_html(window=180, profiles="all")
        assert "<b>&x" not in html
        assert html.count("</script>") == 1, "the escaped JSON must not close the block"
        assert "\\u003cb\\u003e\\u0026x" in html, "profile names must be JSON-escaped"
    finally:
        if previous is None:
            os.environ.pop("RADAR_HOME", None)
        else:
            os.environ["RADAR_HOME"] = previous
        tmp.cleanup()


def test_view_embeds_the_resolved_profiles_and_handles_none() -> None:
    tmp, home = make_home()
    previous = os.environ.get("RADAR_HOME")
    try:
        os.environ["RADAR_HOME"] = str(home)
        all_profiles = _view_html(profiles="all")
        assert 'const PROFILES = "default,maca";' in all_profiles, all_profiles[:400]

        none = _view_html(profiles="none")
        # ``profiles=`` would mean "all": an empty selection must travel as none.
        assert 'const PROFILES = "none";' in none
        assert "sin perfiles" in none
        assert "s · perfiles: " not in none
    finally:
        if previous is None:
            os.environ.pop("RADAR_HOME", None)
        else:
            os.environ["RADAR_HOME"] = previous
        tmp.cleanup()


def test_view_theme_is_a_validated_closed_set() -> None:
    tmp, home = make_home()
    previous = os.environ.get("RADAR_HOME")
    try:
        os.environ["RADAR_HOME"] = str(home)
        assert 'data-theme="light"' in _view_html(theme="light")
        assert 'data-theme="dark"' in _view_html(theme="dark")

        injected = '"><script>window.__pwned=1</script>'
        html = _view_html(theme=injected)
        assert 'data-theme="dark"' in html
        assert injected not in html
        assert html.count("</script>") == 1
    finally:
        if previous is None:
            os.environ.pop("RADAR_HOME", None)
        else:
            os.environ["RADAR_HOME"] = previous
        tmp.cleanup()


def test_view_surface_fixes_are_present() -> None:
    """Findings 5-10: one mark, meta badge, auto-fit, chips, no zero segments, tabs."""
    html = _view_html(window=180, profiles="all")

    # 5: a single status mark, not three dots that read as a truncation.
    assert "['·', '·', '·']" not in html
    assert "node.appendChild(el('span', null, '●'))" in html

    # 6: the profile badge moved to the metadata line.
    assert "name.appendChild(el('span', 'prof'" not in html
    assert "metaLine.appendChild(el('span', 'prof'" in html

    # 7: auto-fit collapses empty tracks so one card fills the row.
    assert "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" in html
    assert "auto-fill" not in html

    # 8: the profile footer is a chip with hover detail, not nine 9.5 px names.
    assert "el('span', 'chip'" in html
    assert "chip.title = names.join(', ')" in html
    assert "perfiles: '" not in html

    # 9: zero-value segments are not painted.
    assert "if (!value && !always) return;" in html

    # 10: tabs carry their counts.
    assert "labels[name] + ' (' + (counts[name] || 0) + ')'" in html


def test_watcher_stops_after_idle_timeout() -> None:
    """Finding 1: a closed panel must not leave a poller running forever."""
    assert api.WATCHER_IDLE_TIMEOUT_S >= 60.0, api.WATCHER_IDLE_TIMEOUT_S

    original_watcher = api._WATCHER
    original_hit = api._LAST_LIVE_HIT
    original_interval = api.WATCH_INTERVAL_S
    original_build = api.build_snapshot
    previous_disable = os.environ.pop("RADAR_DISABLE_WATCHER", None)
    added_stub = "hermes_cli.plugin_events" not in sys.modules
    if added_stub:
        import types

        package = types.ModuleType("hermes_cli")
        events = types.ModuleType("hermes_cli.plugin_events")
        events.broadcast_plugin_event = lambda *_args, **_kwargs: None
        sys.modules["hermes_cli"] = package
        sys.modules["hermes_cli.plugin_events"] = events
    try:
        api.build_snapshot = lambda **_kwargs: {
            "sessions": [], "totals": {}, "profiles": [], "generated_at": 0,
        }
        api.WATCH_INTERVAL_S = 0.02
        api._WATCHER = None

        # A live hit keeps it running; making that hit stale stops it.
        api._LAST_LIVE_HIT = time.monotonic()
        api.ensure_watcher()
        first = api._WATCHER
        assert first is not None and first.is_alive()

        api._LAST_LIVE_HIT = time.monotonic() - api.WATCHER_IDLE_TIMEOUT_S - 1
        first.join(timeout=2.0)
        assert not first.is_alive(), "the watcher outlived its idle window"
        assert api._watcher_idle_expired(time.monotonic())

        # The next /live hit relaunches it; a second stale window stops it again.
        api._LAST_LIVE_HIT = time.monotonic()
        api.ensure_watcher()
        second = api._WATCHER
        assert second is not first and second.is_alive(), "ensure_watcher must relaunch"

        api._LAST_LIVE_HIT = time.monotonic() - api.WATCHER_IDLE_TIMEOUT_S - 1
        second.join(timeout=2.0)
        assert not second.is_alive()

        # A loop started with an already-stale hit exits before its first scan.
        api._LAST_LIVE_HIT = time.monotonic() - api.WATCHER_IDLE_TIMEOUT_S - 1
        api.ensure_watcher()
        third = api._WATCHER
        third.join(timeout=2.0)
        assert not third.is_alive()
    finally:
        api._WATCHER = original_watcher
        api._LAST_LIVE_HIT = original_hit
        api.WATCH_INTERVAL_S = original_interval
        api.build_snapshot = original_build
        if previous_disable is not None:
            os.environ["RADAR_DISABLE_WATCHER"] = previous_disable
        if added_stub:
            sys.modules.pop("hermes_cli.plugin_events", None)
            sys.modules.pop("hermes_cli", None)


def test_tool_cache_is_bounded_and_expires() -> None:
    """Findings 11/15: a 5-8 s TTL and eviction instead of unbounded growth."""
    assert 5.0 <= api.TOOL_CACHE_TTL_S <= 8.0, api.TOOL_CACHE_TTL_S

    now = time.monotonic()
    with api._TOOL_CACHE_LOCK:
        api._TOOL_CACHE.clear()
        api._TOOL_CACHE["stale"] = (now - 3600.0, None)
        api._TOOL_CACHE["fresh"] = (now, "terminal")

    api._remember_tool("written", now, "read_file")
    assert "stale" not in api._TOOL_CACHE
    assert "fresh" in api._TOOL_CACHE and "written" in api._TOOL_CACHE

    with api._TOOL_CACHE_LOCK:
        api._TOOL_CACHE.clear()
        for index in range(api.TOOL_CACHE_MAX_ENTRIES + 25):
            api._TOOL_CACHE[f"k{index}"] = (now - index * 0.001, None)
    api._prune_tool_cache(now)
    assert len(api._TOOL_CACHE) <= api.TOOL_CACHE_MAX_ENTRIES, len(api._TOOL_CACHE)
    with api._TOOL_CACHE_LOCK:
        api._TOOL_CACHE.clear()


def test_readme_describes_the_real_fence_and_platform_status() -> None:
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "stale_generation" not in text, "README describes a mechanism the gateway never emits"
    assert "re-reads `/live`" in text, "README must describe the client-side fence"
    assert "supported by design" in text, "Windows is not exercised here"
    assert "verified on Linux" in text
    assert "Windows** — supported." not in text



# ---------------------------------------------------------------------------
# F4: real profile avatars
# ---------------------------------------------------------------------------


def _json_body(response: Any) -> dict[str, Any]:
    body = response.body.decode("utf-8") if isinstance(response.body, bytes) else str(response.body)
    return json.loads(body)


def test_avatar_endpoint_serves_a_png_data_url() -> None:
    tmp, home = make_home()
    previous = os.environ.get("RADAR_HOME")
    try:
        png = write_png(home / "profiles" / "maca" / "assets" / "avatar.png")
        os.environ["RADAR_HOME"] = str(home)

        response = api.avatar("maca")
        assert response.status_code == 200, response.status_code
        url = _json_body(response)["data_url"]
        assert url.startswith("data:image/png;base64,"), url[:40]
        decoded = base64.b64decode(url.split(",", 1)[1])
        assert decoded[:8] == png[:8] == b"\x89PNG\r\n\x1a\n"
        assert decoded == png

        # A discovered profile without an image answers null, not an error.
        missing = api.avatar("default")
        assert missing.status_code == 200
        assert _json_body(missing)["data_url"] is None

        # A corrupt file is not served as an image.
        (home / "profiles" / "maca" / "assets" / "avatar.png").write_bytes(b"not a png")
        assert _json_body(api.avatar("maca"))["data_url"] is None
    finally:
        if previous is None:
            os.environ.pop("RADAR_HOME", None)
        else:
            os.environ["RADAR_HOME"] = previous
        tmp.cleanup()


def test_avatar_endpoint_rejects_unknown_and_traversal_selectors() -> None:
    tmp, home = make_home()
    previous = os.environ.get("RADAR_HOME")
    try:
        write_png(home / "profiles" / "maca" / "assets" / "avatar.png")
        (home / "outside.png").write_bytes(b"\x89PNG\r\n\x1a\nnot-served")
        os.environ["RADAR_HOME"] = str(home)

        for selector in (
            "",
            ".",
            "..",
            "../etc/passwd",
            "..%2fetc%2fpasswd",
            "..\\..\\etc\\passwd",
            "/etc/passwd",
            "unknown",
            "maca/../default",
            "maca\x00",
        ):
            response = api.avatar(selector)
            assert response.status_code in (400, 404), (selector, response.status_code)
            payload = _json_body(response)
            assert payload.get("data_url") is None, selector
            assert "base64" not in json.dumps(payload), selector

        # The resolved path is always under the profile's own assets dir.
        target = api._avatar_target("maca")
        assert target is not None
        assert target.parent == home / "profiles" / "maca" / "assets"
    finally:
        if previous is None:
            os.environ.pop("RADAR_HOME", None)
        else:
            os.environ["RADAR_HOME"] = previous
        tmp.cleanup()


def test_live_exposes_profile_title_and_avatar_metadata() -> None:
    tmp, home = make_home()
    try:
        now = 1_800_000_000.0
        write_profile_yaml(
            home / "profiles" / "maca",
            "ui_meta:\n"
            "  hermes-bots:\n"
            "    shape: blobatar:rkr2yf0m:cloud\n"
            "    color: '#ff4d00'\n"
            "    title: 'Maca'\n"
            "    imageKind: photo\n",
        )
        write_png(home / "profiles" / "maca" / "assets" / "avatar.png")

        # No PNG and no ui_meta title: the display name wins, then the slug.
        write_profile_yaml(home / "profiles" / "writer", "display_name: 'Writera'\n")
        new_db(home / "profiles" / "writer" / "state.db")
        new_db(home / "profiles" / "nophoto" / "state.db")

        add_session(home / "state.db", "root", last_activity_at=now - 10)
        add_session(home / "profiles" / "maca" / "state.db", "maca-s", last_activity_at=now - 10)
        add_session(home / "profiles" / "writer" / "state.db", "writer-s", last_activity_at=now - 10)
        add_session(home / "profiles" / "nophoto" / "state.db", "nophoto-s", last_activity_at=now - 10)

        snapshot = api.build_snapshot(home=home, profiles="all", window=180, now=now)
        by_id = {item["id"]: item for item in snapshot["sessions"]}

        maca = by_id["maca-s"]
        assert maca["profile_title"] == "Maca"
        assert maca["avatar"]["has_image"] is True
        assert maca["avatar"]["shape"] == "blobatar:rkr2yf0m:cloud"
        assert maca["avatar"]["color"].lower() == "#ff4d00"
        assert maca["avatar"]["image_kind"] == "photo"
        assert "data_url" not in json.dumps(maca["avatar"]), "/live must not inline the image"

        assert by_id["writer-s"]["profile_title"] == "Writera"
        assert by_id["writer-s"]["avatar"]["has_image"] is False
        assert by_id["writer-s"]["avatar"]["image_kind"] is None
        # A missing ui_meta color is derived deterministically from the name.
        derived = by_id["writer-s"]["avatar"]["color"]
        assert isinstance(derived, str) and re.fullmatch(r"#[0-9a-f]{6}", derived), derived
        assert by_id["nophoto-s"]["profile_title"] == "nophoto"
        assert by_id["nophoto-s"]["avatar"]["has_image"] is False
        assert by_id["root"]["profile_title"] == "default"

        again = api.build_snapshot(home=home, profiles="all", window=180, now=now)
        colors = {item["profile"]: item["avatar"]["color"] for item in again["sessions"]}
        assert colors["writer"] == derived, "derived color must be stable"
    finally:
        tmp.cleanup()


def test_profile_appearance_cache_follows_yaml_and_avatar_mtime() -> None:
    tmp, home = make_home()
    try:
        profile_dir = home / "profiles" / "maca"
        write_profile_yaml(profile_dir, "ui_meta:\n  hermes-bots:\n    title: 'Antes'\n")
        first = api.profile_appearance("maca", profile_dir)
        assert first["profile_title"] == "Antes"
        assert first["has_image"] is False

        time.sleep(0.01)
        write_profile_yaml(profile_dir, "ui_meta:\n  hermes-bots:\n    title: 'Después'\n")
        write_png(profile_dir / "assets" / "avatar.png")
        second = api.profile_appearance("maca", profile_dir)
        assert second["profile_title"] == "Después"
        assert second["has_image"] is True
    finally:
        tmp.cleanup()


def test_read_bot_meta_parses_the_ui_meta_bot_block() -> None:
    tmp, home = make_home()
    try:
        profile_dir = home / "profiles" / "maca"
        write_profile_yaml(
            profile_dir,
            "ui_meta:\n"
            "  hermes-bots:\n"
            "    shape: blobatar:rkr2yf0m:cloud\n"
            "    color: '#ff4d00'\n"
            "    imageKind: photo\n"
            "    title: 'Maca'\n",
        )
        assert api._read_bot_meta(profile_dir) == {
            "shape": "blobatar:rkr2yf0m:cloud",
            "color": "#ff4d00",
            "imageKind": "photo",
            "title": "Maca",
        }
    finally:
        tmp.cleanup()


def test_read_bot_meta_empty_block_does_not_leak_siblings() -> None:
    tmp, home = make_home()
    try:
        profile_dir = home / "profiles" / "writer"
        write_profile_yaml(
            profile_dir,
            "ui_meta:\n"
            "  hermes-bots: {}\n"
            "_ui_meta_revisions:\n"
            "  hermes-bots: 1\n",
        )
        assert api._read_bot_meta(profile_dir) == {}
    finally:
        tmp.cleanup()


def test_read_bot_meta_without_profile_yaml_is_empty() -> None:
    tmp, home = make_home()
    try:
        assert api._read_bot_meta(home / "profiles" / "maca") == {}
    finally:
        tmp.cleanup()


def test_read_bot_meta_ignores_comments_and_keeps_quoted_hashes() -> None:
    tmp, home = make_home()
    try:
        profile_dir = home / "profiles" / "maca"
        write_profile_yaml(
            profile_dir,
            "# leading comment\n"
            "ui_meta:\n"
            "  # between the blocks\n"
            "  hermes-bots:\n"
            "    # inside the block\n"
            "    title: 'A # B'\n"
            "    shape: hexagon  # trailing comment\n",
        )
        assert api._read_bot_meta(profile_dir) == {
            "title": "A # B",
            "shape": "hexagon",
        }
    finally:
        tmp.cleanup()


def test_read_bot_meta_keeps_an_explicitly_empty_title() -> None:
    tmp, home = make_home()
    try:
        profile_dir = home / "profiles" / "maca"
        write_profile_yaml(
            profile_dir,
            "ui_meta:\n"
            "  hermes-bots:\n"
            "    title: ''\n",
        )
        assert api._read_bot_meta(profile_dir) == {"title": ""}
    finally:
        tmp.cleanup()


def test_read_bot_meta_rejects_tab_indentation() -> None:
    tmp, home = make_home()
    try:
        profile_dir = home / "profiles" / "maca"
        write_profile_yaml(
            profile_dir,
            "ui_meta:\n"
            "\thermes-bots:\n"
            "        title: 'Maca'\n",
        )
        assert api._read_bot_meta(profile_dir) == {}
    finally:
        tmp.cleanup()


def test_view_embeds_avatar_images_and_profile_titles() -> None:
    tmp, home = make_home()
    previous = os.environ.get("RADAR_HOME")
    try:
        write_profile_yaml(
            home / "profiles" / "maca",
            "ui_meta:\n"
            "  hermes-bots:\n"
            "    title: '</script><img src=x onerror=alert(1)>'\n"
            "    shape: hexagon\n"
            "    color: '#12ab34'\n",
        )
        write_png(home / "profiles" / "maca" / "assets" / "avatar.png")
        os.environ["RADAR_HOME"] = str(home)

        html = _view_html(profiles="all")
        assert "const AVATARS = " in html
        assert "data:image/png;base64," in html
        assert "createElement('img')" in html
        assert "profile_title" in html
        assert '"maca"' in html
        assert "width: 30px" in html
        assert "img.width = 30" in html
        assert "image_kind === 'photo'" in html
        assert "<\\/script>" not in html
        # The hostile title travels escaped inside the JSON payload.
        assert html.count("</script>") == 1, "the title must not close the script block"
        assert "<img src=x" not in html
    finally:
        if previous is None:
            os.environ.pop("RADAR_HOME", None)
        else:
            os.environ["RADAR_HOME"] = previous
        tmp.cleanup()


def test_plugin_identity_is_radar() -> None:
    """The rename is complete on every surface a host or a human reads."""
    assert api.PLUGIN_ID == "radar", api.PLUGIN_ID

    manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["name"] == "radar", manifest
    assert manifest["label"] == "Radar", manifest

    yaml_text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    assert "name: radar" in yaml_text, yaml_text
    assert "hermes-radar" in yaml_text, yaml_text
    assert "version: 0.4.0" in yaml_text, yaml_text

    html = _view_html()
    assert "<title>Radar</title>" in html, "the /view document title must be Radar"
    assert "<h1>Radar</h1>" in html, "the /view heading must be Radar"

    desktop = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert "const PLUGIN_ID = 'radar'" in desktop, desktop
    assert "const PLUGIN_NAME = 'Radar'" in desktop, desktop
    assert "plugin.radar.changed" in desktop, desktop
    assert "id: 'radar'" in desktop, desktop
    assert "title: 'Radar'" in desktop, desktop


# ---------------------------------------------------------------------------
# Stdlib runner (pytest is not installed in this container)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failures = 0
    for name, fn in tests:
        try:
            fn()
        except Exception:
            failures += 1
            print(f"FAIL {name}")
            traceback.print_exc()
        else:
            print(f"PASS {name}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
