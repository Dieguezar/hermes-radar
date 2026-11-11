"""Radar: a live, read-only view of every Hermes session.

Mounted by Hermes under ``/api/plugins/radar/``.

Design contract
---------------
* Read-only. Every profile ``state.db`` is opened through a SQLite read-only
  URI (``mode=ro``) with ``PRAGMA query_only``. Nothing is written, no
  credentials are read and no network calls are made.
* Cheap. One bounded ``sessions`` query per profile, plus small ``LIMIT 1``
  lookups for leases/admissions/delegations and a per-session cached lookup of
  the in-flight tool call.
* Push, not poll. A single lazy watcher thread fingerprints the snapshot and
  calls ``broadcast_plugin_event`` at most once every two seconds, and only
  when the visible state changes.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

try:  # The dashboard host always has FastAPI; unit tests may not.
    from fastapi import APIRouter
    from fastapi.responses import HTMLResponse, JSONResponse
except Exception:  # pragma: no cover - exercised only outside the gateway

    class APIRouter:  # type: ignore[no-redef]
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def get(self, *_args: Any, **_kwargs: Any):
            return lambda fn: fn

    class HTMLResponse:  # type: ignore[no-redef]
        def __init__(self, content: str = "", status_code: int = 200, **_kwargs: Any) -> None:
            self.body = content.encode("utf-8")
            self.status_code = status_code
            self.media_type = "text/html; charset=utf-8"

    class JSONResponse:  # type: ignore[no-redef]
        def __init__(self, content: Any = None, status_code: int = 200, **_kwargs: Any) -> None:
            self.body = json.dumps(content).encode("utf-8")
            self.status_code = status_code
            self.media_type = "application/json"


PLUGIN_ID = "radar"
DEFAULT_WINDOW_S = 180
MIN_WINDOW_S = 15
MAX_WINDOW_S = 86400
MAX_SESSIONS_PER_PROFILE = 200

#: The tool lookup is a bounded ``LIMIT 1`` query, but the watcher ticks every 2 s
#: and would always see a cold entry with a 2 s TTL. Six seconds keeps the answer
#: fresh enough for an activity line while removing most of the per-tick queries.
TOOL_CACHE_TTL_S = 6.0

#: Hard bound on the cache itself: one entry per visible session, purged on write.
TOOL_CACHE_MAX_ENTRIES = 512

WATCH_INTERVAL_S = 2.0

#: Minimum wall-clock gap between two ``broadcast_plugin_event`` calls.
BROADCAST_FLOOR_S = 2.0

#: The lazy watcher stops itself after this long without a ``/live`` hit and is
#: relaunched by the next request. A disabled panel must not poll forever.
WATCHER_IDLE_TIMEOUT_S = 60.0

#: How long SQLite may wait for a lock before the open attempt is retried.
CONNECT_TIMEOUT_S = 5.0

#: A profile avatar is a small raster (3-15 KB in practice). Anything larger is
#: refused instead of being base64-inflated into the JSON payload.
AVATAR_MAX_BYTES = 512 * 1024

#: One cache entry per profile; clearing on overflow keeps the bound trivial.
AVATAR_CACHE_MAX_ENTRIES = 64

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# ``blobatar``, ``blobatar:<seed>``, ``blobatar::<kind>`` (empty seed is valid)
# and the fixed silhouettes; anything else falls back to the name hash.
_SHAPE_RE = re.compile(r"^[a-z]{1,16}(?::[a-z0-9]{0,32}){0,2}$")

#: An expired lease only reads as "stalled" while its activity is this recent.
#: Fixed on purpose: "stalled" is an attention state, and an abandoned session
#: from last week is not hung *now*, whatever window the caller asks for.
STALL_WINDOW_S = 30 * 60

#: async_delegations states that mean a subagent is still in flight.
LIVE_DELEGATION_STATES = ("running", "stalling", "finalizing")

LIVE_STATES = ("running", "queued", "stalled")

#: States where a stop request is meaningful. ``queued`` is cancelled through
#: the admission API, not interrupted, so it is deliberately excluded.
INTERRUPTIBLE_STATES = ("running", "stalled")

#: Panel order: what is doing work, then what needs attention, then what is
#: waiting. Terminal rows trail; ``dormant`` is never listed.
_STATE_ORDER = {
    "running": 0,
    "stalled": 1,
    "queued": 2,
    "idle": 3,
    "done": 4,
    "failed": 5,
    "dormant": 6,
}

_TOOL_CACHE: dict[str, tuple[float, Optional[str]]] = {}
_TOOL_CACHE_LOCK = threading.Lock()

#: ``profile.yaml`` appearance, keyed by file path and invalidated by mtime+size.
_PROFILE_APPEARANCE_CACHE: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
_PROFILE_APPEARANCE_LOCK = threading.Lock()

#: Avatar data URLs, keyed by file path and invalidated by mtime+size.
_AVATAR_CACHE: dict[str, tuple[tuple[int, int], str]] = {}
_AVATAR_CACHE_LOCK = threading.Lock()

_WATCHER: Optional[threading.Thread] = None
_WATCHER_LOCK = threading.Lock()

#: ``time.monotonic()`` of the last ``/live`` request. The watcher reads it to
#: decide when it has been abandoned; ``live()`` refreshes it before starting.
_LAST_LIVE_HIT = 0.0


# ---------------------------------------------------------------------------
# Home / profile discovery
# ---------------------------------------------------------------------------


def hermes_home() -> Path:
    """Resolve the Hermes root that holds ``state.db`` and ``profiles/``.

    ``RADAR_HOME`` is an explicit override used by the dev harness and
    the tests. Otherwise Hermes' own resolver is used (it already accounts for
    ``HERMES_HOME`` and for a process started inside a named profile).
    """
    override = os.environ.get("RADAR_HOME", "").strip()
    if override:
        return Path(override).expanduser()

    try:
        from hermes_constants import get_default_hermes_root

        root = Path(get_default_hermes_root())
        if (root / "state.db").is_file() or (root / "profiles").is_dir():
            return root
    except Exception:
        pass

    env = os.environ.get("HERMES_HOME", "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".hermes"


def discover_profiles(home: Path) -> list[tuple[str, Path]]:
    """``(profile_name, state.db path)`` for the root home and every named profile."""
    found: list[tuple[str, Path]] = []
    root_db = Path(home) / "state.db"
    if root_db.is_file():
        found.append(("default", root_db))

    profiles_dir = Path(home) / "profiles"
    try:
        children = sorted(profiles_dir.iterdir(), key=lambda p: p.name)
    except OSError:
        children = []
    for child in children:
        if not child.is_dir() or child.name.startswith("."):
            continue
        db = child / "state.db"
        if db.is_file():
            found.append((child.name, db))
    return found


def current_profile_name(home: Path, profiles: Optional[list[tuple[str, Path]]] = None) -> str:
    """Name of the profile this process serves (``default`` when it serves the root)."""
    profiles = profiles if profiles is not None else discover_profiles(home)
    try:
        from hermes_constants import get_process_hermes_home

        process_home = Path(get_process_hermes_home()).resolve()
    except Exception:
        raw = os.environ.get("HERMES_HOME", "").strip()
        process_home = Path(raw).expanduser().resolve() if raw else None

    if process_home is not None:
        for name, db in profiles:
            try:
                if db.parent.resolve() == process_home:
                    return name
            except OSError:
                continue
        for name, db in profiles:
            try:
                if db.resolve() == process_home:
                    return name
            except OSError:
                continue
    return "default"


def profile_label(profile_name: str) -> str:
    """Presentation label for a profile badge.

    Today Hermes keeps no profile display metadata on disk, so the honest label
    is the profile name (``default`` for the root home). This is the single
    place a future display name would plug in; the Desktop and the web view
    both render this field instead of re-deriving one.
    """
    text = (profile_name or "").strip()
    return text or "default"


def select_profiles(
    home: Path, selector: str
) -> tuple[list[tuple[str, Path]], list[str]]:
    """Apply ``?profiles=all|current|<comma list>`` to the discovered profiles."""
    discovered = discover_profiles(home)
    names = [name for name, _db in discovered]
    raw = (selector or "all").strip()
    lowered = raw.lower()

    if lowered in ("", "all", "*"):
        return discovered, names
    if lowered == "current":
        current = current_profile_name(home, discovered)
        return [entry for entry in discovered if entry[0] == current], [current]
    if lowered == "none":
        return [], []

    wanted = [item.strip() for item in raw.split(",") if item.strip()]
    by_name = dict(discovered)
    selected = [(name, by_name[name]) for name in wanted if name in by_name]
    return selected, [name for name, _db in selected]


# ---------------------------------------------------------------------------
# Profile appearance (the same data the Bots roster paints)
# ---------------------------------------------------------------------------


def _strip_scalar(raw: str) -> str:
    """One YAML scalar: drop surrounding quotes or an unquoted trailing comment."""
    text = raw.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    cut = text.find(" #")
    if cut >= 0:
        text = text[:cut]
    return text.strip()


def _meta_lines(path: Path) -> list[tuple[int, str]] | None:
    """``(indent, stripped line)`` for a spaces-indented file.

    ``None`` means the file is missing, unreadable, tab-indented or has an odd
    number of leading spaces: the caller treats that as "no metadata", never as
    an error. Blank lines and comment-only lines are already gone.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None
    if "\t" in text:
        return None

    lines: list[tuple[int, str]] = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        leading = len(raw) - len(raw.lstrip(" "))
        if leading % 2:
            return None
        lines.append((leading, stripped))
    return lines


def _read_bot_meta(profile_dir: Path) -> dict[str, Any]:
    """The four ``ui_meta.hermes-bots`` keys of ``profile.yaml``, or ``{}``.

    A bounded, stdlib-only reader instead of a full YAML parser: Hermes fixes the
    shape it writes (two spaces per level), and this plugin only needs
    ``shape``, ``color``, ``imageKind`` and ``title``. Anything unexpected —
    a missing or unreadable file, a tab, odd indentation — degrades to ``{}``
    rather than raising.

    ``ui_meta:`` opens the block at level 0; any other top-level key closes it.
    Inside it, ``hermes-bots:`` opens the bot block (an empty ``{}`` is valid)
    and a sibling key closes it. Deeper lines are ``key: value`` pairs.
    """
    lines = _meta_lines(Path(profile_dir) / "profile.yaml")
    if lines is None:
        return {}

    found: dict[str, Any] = {}
    in_ui_meta = False
    bot_indent: Optional[int] = None
    for indent, stripped in lines:
        key, sep, value = stripped.partition(":")
        key = key.strip()

        if indent == 0:
            in_ui_meta = bool(sep) and key == "ui_meta"
            bot_indent = None
            continue
        if not in_ui_meta:
            continue
        if bot_indent is None:
            if sep and key == "hermes-bots":
                bot_indent = indent
            continue
        if indent <= bot_indent:
            # A sibling (or ancestor) closes the bot block.
            bot_indent = None
            if sep and key == "hermes-bots":
                bot_indent = indent
            continue
        if sep and key in ("shape", "color", "imageKind", "title"):
            found[key] = _strip_scalar(value)
    return found


def _read_top_level_value(path: Path, key: str) -> str:
    """One top-level scalar from ``profile.yaml`` (``display_name``, typically)."""
    lines = _meta_lines(Path(path))
    if lines is None:
        return ""
    for indent, stripped in lines:
        if indent != 0:
            continue
        name, sep, value = stripped.partition(":")
        if sep and name.strip() == key:
            return _strip_scalar(value)
    return ""


def _clean_shape(value: Any) -> Optional[str]:
    """A stored shape string, restricted to the documented grammar."""
    text = str(value or "").strip().lower()
    return text if text and _SHAPE_RE.fullmatch(text) else None


def _clean_color(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text.lower() if _HEX_COLOR_RE.fullmatch(text) else None


def _hsl_to_hex(hue: float, saturation: float, lightness: float) -> str:
    """``hsl(h s% l%)`` → ``#rrggbb`` (the inverse profileColor() publishes)."""
    s = saturation / 100.0
    light = lightness / 100.0
    chroma = (1 - abs(2 * light - 1)) * s
    x = chroma * (1 - abs((hue / 60.0) % 2 - 1))
    m = light - chroma / 2
    sector = int(hue // 60) % 6
    rgb = [
        (chroma, x, 0.0),
        (x, chroma, 0.0),
        (0.0, chroma, x),
        (0.0, x, chroma),
        (x, 0.0, chroma),
        (chroma, 0.0, x),
    ][sector]
    return "#" + "".join(f"{int(round((channel + m) * 255)):02x}" for channel in rgb)


def derived_profile_color(profile_name: str) -> Optional[str]:
    """Stable fallback tint, mirroring the Desktop SDK's ``profileColor``.

    The root profile is neutral in the roster (``default`` → ``None``); named
    profiles get the same 31-multiplier hue hash the SDK uses.
    """
    key = (profile_name or "").strip()
    if not key or key == "default":
        return None
    hashed = 0
    for character in key:
        hashed = (hashed * 31 + ord(character)) & 0xFFFFFFFF
    return _hsl_to_hex(hashed % 360, 68, 58)


def _appearance_from_yaml(profile_name: str, yaml_path: Path) -> dict[str, Any]:
    bots = _read_bot_meta(Path(yaml_path).parent)

    title = str(bots.get("title") or "").strip()
    if not title:
        title = _read_top_level_value(yaml_path, "display_name").strip()
    if not title:
        title = profile_label(profile_name)

    image_kind = str(bots.get("imageKind") or "").strip().lower() or None

    return {
        "profile_title": title,
        "shape": _clean_shape(bots.get("shape")),
        "color": _clean_color(bots.get("color")) or derived_profile_color(profile_name),
        "image_kind": image_kind,
    }


def _avatar_path(profile_dir: Path) -> Path:
    """The only avatar path this plugin ever reads."""
    return Path(profile_dir) / "assets" / "avatar.png"


def _read_avatar_data_url(path: Path) -> Optional[str]:
    """Validated PNG as a data URL, cached by ``(path, mtime, size)``."""
    try:
        stat = path.stat()
    except OSError:
        return None
    if stat.st_size <= 0 or stat.st_size > AVATAR_MAX_BYTES:
        return None

    key = str(path)
    stamp = (stat.st_mtime_ns, stat.st_size)
    with _AVATAR_CACHE_LOCK:
        cached = _AVATAR_CACHE.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]

    try:
        raw = path.read_bytes()
    except OSError:
        return None
    # A file can grow between stat and read; enforce the bound on the bytes.
    if not raw.startswith(_PNG_SIGNATURE) or len(raw) > AVATAR_MAX_BYTES:
        return None

    data_url = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
    with _AVATAR_CACHE_LOCK:
        if len(_AVATAR_CACHE) >= AVATAR_CACHE_MAX_ENTRIES and key not in _AVATAR_CACHE:
            _AVATAR_CACHE.clear()
        _AVATAR_CACHE[key] = (stamp, data_url)
    return data_url


def profile_appearance(profile_name: str, profile_dir: Path) -> dict[str, Any]:
    """Title, shape, color and image presence for one profile.

    ``profile.yaml`` is parsed at most once per ``(mtime, size)``; the avatar
    file is only stat'ed on the hot path and its data URL is cached separately.
    """
    profile_dir = Path(profile_dir)
    yaml_path = profile_dir / "profile.yaml"
    try:
        stat = yaml_path.stat()
        stamp: Optional[tuple[int, int]] = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        stamp = None

    key = str(yaml_path)
    appearance: Optional[dict[str, Any]] = None
    if stamp is not None:
        with _PROFILE_APPEARANCE_LOCK:
            cached = _PROFILE_APPEARANCE_CACHE.get(key)
        if cached is not None and cached[0] == stamp:
            appearance = dict(cached[1])

    if appearance is None:
        appearance = _appearance_from_yaml(profile_name, yaml_path)
        if stamp is not None:
            with _PROFILE_APPEARANCE_LOCK:
                if (
                    len(_PROFILE_APPEARANCE_CACHE) >= AVATAR_CACHE_MAX_ENTRIES
                    and key not in _PROFILE_APPEARANCE_CACHE
                ):
                    _PROFILE_APPEARANCE_CACHE.clear()
                _PROFILE_APPEARANCE_CACHE[key] = (stamp, dict(appearance))

    appearance["has_image"] = _read_avatar_data_url(_avatar_path(profile_dir)) is not None
    return appearance


def _avatar_target(profile: str) -> Optional[Path]:
    """Resolve a request path segment to a discovered profile's avatar.

    Only names returned by ``discover_profiles`` are accepted; the segment is
    never joined to a filesystem path, so ``..`` and separators cannot escape.
    """
    name = (profile or "").strip()
    if not name or name in (".", ".."):
        return None
    if "/" in name or "\\" in name or "\x00" in name:
        return None
    for discovered_name, db_path in discover_profiles(hermes_home()):
        if discovered_name == name:
            return _avatar_path(Path(db_path).parent)
    return None


def avatar_data_url(profile: str) -> Optional[str]:
    """Data URL for a discovered profile, or ``None`` (also for unknown names)."""
    target = _avatar_target(profile)
    return _read_avatar_data_url(target) if target is not None else None


# ---------------------------------------------------------------------------
# Read-only SQLite access
# ---------------------------------------------------------------------------


def _read_only_uri(db_path: Path) -> str:
    """Portable read-only SQLite URI for a local database path.

    ``Path.as_uri()`` is the one builder used on every platform: it
    percent-encodes spaces and non-ASCII characters, and on Windows it produces
    ``file:///C:/...``. ``sqlite3`` accepts both the POSIX and the drive form
    when the connection opens with ``uri=True``; the query string is appended
    to that same URI so no path separator is ever spelled by hand.
    """
    # Resolve the object we were handed instead of re-wrapping it: ``Path(...)``
    # re-detects the platform from ``os.name`` on every call, and the tests
    # simulate Windows by patching exactly that name.
    path = db_path if isinstance(db_path, Path) else Path(db_path)
    return path.resolve().as_uri() + "?mode=ro"


def _candidate_uris(db_path: Path) -> list[str]:
    """Read-only URIs to try, in order. Every one of them carries ``mode=ro``.

    ``immutable=1`` lets SQLite skip the shared-memory handshake, but it is only
    honest when no ``-wal`` sidecar exists: with a live WAL the reader would see
    a frozen snapshot. On Windows a writer holds the ``-shm`` file, so the
    fallback there is ``readonly_shm=1`` instead.
    """
    # Resolve the object we were handed instead of re-wrapping it: ``Path(...)``
    # re-detects the platform from ``os.name`` on every call, and the tests
    # simulate Windows by patching exactly that name.
    path = db_path if isinstance(db_path, Path) else Path(db_path)
    base = path.resolve().as_uri()

    wal_path = os.fspath(path) + "-wal"
    shm_path = os.fspath(path) + "-shm"
    has_wal = os.path.exists(wal_path)
    has_shm = os.path.exists(shm_path)

    candidates = [_read_only_uri(path)]
    if not has_wal:
        candidates.append(base + "?mode=ro&immutable=1")
    if os.name == "nt" and (has_wal or has_shm):
        candidates.append(base + "?mode=ro&readonly_shm=1")
    return candidates


def _connect(db_path: Path) -> sqlite3.Connection:
    """Open ``db_path`` strictly read-only (never creates or writes anything)."""
    last_error: Optional[sqlite3.Error] = None
    for uri in _candidate_uris(db_path):
        try:
            conn = sqlite3.connect(uri, uri=True, timeout=CONNECT_TIMEOUT_S)
        except sqlite3.Error as exc:  # locked, unreadable, unsupported query param
            last_error = exc
            continue
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = ON")
        return conn
    if last_error is not None:
        raise last_error
    raise sqlite3.OperationalError(f"no read-only URI could be built for {db_path}")


def _table_names(conn: sqlite3.Connection) -> set[str]:
    try:
        return {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    except sqlite3.DatabaseError:
        return set()


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Column names of ``table`` (empty set when it cannot be read)."""
    try:
        return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.DatabaseError:
        return set()


def _optional_rows(
    conn: sqlite3.Connection, tables: set[str], table: str, sql: str, params: tuple = ()
) -> list[sqlite3.Row]:
    if table not in tables:
        return []
    try:
        return list(conn.execute(sql, params))
    except sqlite3.DatabaseError:
        return []


# ---------------------------------------------------------------------------
# Per-session enrichment
# ---------------------------------------------------------------------------


def _prune_tool_cache(now: Optional[float] = None) -> int:
    """Drop expired entries (and the oldest overflow). Returns how many went.

    ``_TOOL_CACHE`` lives as long as the gateway process, so it must be bounded:
    every write purges entries older than the TTL and then trims past the cap by
    insertion time. Called with the lock held or on its own (it takes the lock).
    """
    monotonic = time.monotonic() if now is None else now
    removed = 0
    with _TOOL_CACHE_LOCK:
        for key in [key for key, (stamp, _value) in _TOOL_CACHE.items()
                    if monotonic - stamp >= TOOL_CACHE_TTL_S]:
            _TOOL_CACHE.pop(key, None)
            removed += 1
        overflow = len(_TOOL_CACHE) - TOOL_CACHE_MAX_ENTRIES
        if overflow > 0:
            oldest = sorted(_TOOL_CACHE.items(), key=lambda item: item[1][0])[:overflow]
            for key, _value in oldest:
                _TOOL_CACHE.pop(key, None)
                removed += 1
    return removed


def _remember_tool(cache_key: str, stamp: float, value: Optional[str]) -> None:
    """Store one answer after pruning, so the cache can never grow unbounded."""
    _prune_tool_cache(stamp)
    with _TOOL_CACHE_LOCK:
        _TOOL_CACHE[cache_key] = (stamp, value)


def _pending_tool(conn: sqlite3.Connection, cache_key: str, session_id: str) -> Optional[str]:
    """Name of the last assistant tool call that has no tool result yet.

    Uses the partial index ``idx_messages_assistant_calls_by_session`` with a
    ``LIMIT 1`` lookup, then one existence check for the matching result. The
    answer is cached for ``TOOL_CACHE_TTL_S`` so the watcher stays cheap.
    """
    monotonic = time.monotonic()
    with _TOOL_CACHE_LOCK:
        cached = _TOOL_CACHE.get(cache_key)
    if cached is not None and monotonic - cached[0] < TOOL_CACHE_TTL_S:
        return cached[1]

    name: Optional[str] = None
    try:
        row = conn.execute(
            "SELECT tool_calls FROM messages "
            "WHERE session_id = ? AND role = 'assistant' "
            "AND tool_calls IS NOT NULL AND tool_calls NOT IN ('', '[]', 'null') "
            "ORDER BY id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        if row is not None and row["tool_calls"]:
            calls = json.loads(row["tool_calls"])
            if isinstance(calls, list):
                call_ids = [
                    call.get("call_id") or call.get("id")
                    for call in calls
                    if isinstance(call, dict)
                ]
                call_ids = [cid for cid in call_ids if isinstance(cid, str) and cid]
                if call_ids:
                    placeholders = ",".join("?" for _ in call_ids)
                    answered = conn.execute(
                        "SELECT 1 FROM messages WHERE session_id = ? "
                        f"AND tool_call_id IN ({placeholders}) LIMIT 1",
                        (session_id, *call_ids),
                    ).fetchone()
                    if answered is None:
                        first = calls[0]
                        function = first.get("function") if isinstance(first, dict) else None
                        if isinstance(function, dict):
                            name = function.get("name")
                        if not isinstance(name, str) or not name:
                            raw_name = first.get("name") if isinstance(first, dict) else None
                            name = raw_name if isinstance(raw_name, str) else None
    except (sqlite3.DatabaseError, ValueError, TypeError, KeyError):
        name = None

    _remember_tool(cache_key, monotonic, name)
    return name


def _is_failed_end_reason(reason: Optional[str]) -> bool:
    text = (reason or "").lower()
    return any(token in text for token in ("error", "fail", "crash", "timeout", "exception", "abort"))


def classify_session(
    *,
    end_reason: Optional[str],
    ended_at: Optional[float],
    lease_live: bool,
    lease_expired: bool,
    lease_acquired_at: Optional[float],
    delegating_since: Optional[float],
    queued: bool,
    last_activity: Optional[float],
    cutoff: float,
    now: float,
) -> tuple[str, Optional[float]]:
    """Classify one session row as ``(state, since)``.

    The contract (F1.1):

    * ``running``  — a live turn lease (``expires_at > now``). An async
      delegation still in flight also counts as work in progress.
    * ``queued``   — an admission waiting for this session.
    * ``stalled``  — a lease that expired while its activity is still inside
      ``STALL_WINDOW_S``; or an open row (no ``ended_at``) that recorded a
      failing ``end_reason`` while its activity is inside the window.
    * ``idle``     — no live lease, activity inside the window: waiting on the
      user.
    * ``dormant``  — ``end_reason IS NULL``, no live lease, activity outside the
      window. Not live, not red, not listed by default.
    * ``done`` / ``failed`` — a terminal ``end_reason`` inside the window.
    """
    recent = last_activity is not None and last_activity >= cutoff

    if end_reason:
        failed = _is_failed_end_reason(str(end_reason))
        # A row carrying a failing reason but no terminal timestamp is an open,
        # broken turn: it needs attention rather than a tombstone.
        if failed and ended_at is None and recent:
            return "stalled", last_activity
        return ("failed" if failed else "done"), (ended_at or last_activity or now)

    if lease_live:
        return "running", (lease_acquired_at or last_activity or now)
    if delegating_since is not None:
        return "running", (delegating_since or last_activity or now)
    if queued:
        return "queued", (last_activity or now)
    if lease_expired and last_activity is not None and (now - last_activity) <= STALL_WINDOW_S:
        return "stalled", last_activity
    if recent:
        return "idle", last_activity
    return "dormant", last_activity


def _as_float(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int:
    try:
        return int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0


def _as_generation(value: Any) -> Optional[int]:
    """``runtime_generation`` as an int; ``None`` when the value is absent.

    ``None`` is meaningful (the pane sends no generation and the handler accepts
    that), so this must never collapse a missing column into ``0``.
    """
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------


def build_snapshot(
    *,
    home: Optional[Path] = None,
    profiles: str = "all",
    window: int = DEFAULT_WINDOW_S,
    now: Optional[float] = None,
) -> dict[str, Any]:
    """Build the ``/live`` payload. Pure read: no thread, no broadcast."""
    root = Path(home) if home is not None else hermes_home()
    try:
        window_s = int(window)
    except (TypeError, ValueError):
        window_s = DEFAULT_WINDOW_S
    window_s = max(MIN_WINDOW_S, min(MAX_WINDOW_S, window_s))

    current = now if now is not None else time.time()
    cutoff = current - window_s
    selected, profile_names = select_profiles(root, profiles)

    # One appearance read per selected profile, never per session: nine rows of
    # the same profile share a single YAML parse and a single avatar stat.
    appearances = {
        name: profile_appearance(name, Path(db_path).parent) for name, db_path in selected
    }

    sessions: list[dict[str, Any]] = []
    failures: dict[str, str] = {}

    for profile_name, db_path in selected:
        try:
            conn = _connect(db_path)
        except sqlite3.Error as exc:
            failures[profile_name] = f"{type(exc).__name__}: {exc}"
            continue
        try:
            tables = _table_names(conn)

            leases: dict[str, sqlite3.Row] = {}
            for row in _optional_rows(
                conn,
                tables,
                "session_turn_leases",
                "SELECT conversation_id, holder, acquired_at, expires_at FROM session_turn_leases",
            ):
                leases[str(row["conversation_id"])] = row

            queued: dict[str, int] = {}
            for row in _optional_rows(
                conn,
                tables,
                "session_admissions",
                "SELECT target_session_id, MIN(seq) AS first_seq FROM session_admissions "
                "WHERE status = 'queued' GROUP BY target_session_id",
            ):
                queued[str(row["target_session_id"])] = int(row["first_seq"] or 0)

            delegations: dict[str, sqlite3.Row] = {}
            placeholders = ",".join("?" for _ in LIVE_DELEGATION_STATES)
            for row in _optional_rows(
                conn,
                tables,
                "async_delegations",
                "SELECT origin_session, COUNT(*) AS n, MIN(dispatched_at) AS first_at "
                f"FROM async_delegations WHERE state IN ({placeholders}) "
                "GROUP BY origin_session",
                LIVE_DELEGATION_STATES,
            ):
                delegations[str(row["origin_session"])] = row

            columns = _table_columns(conn, "sessions")
            # Older Hermes builds have no ``runtime_generation``; select a NULL
            # with the same name so the payload shape never changes shape.
            generation_expr = (
                "runtime_generation"
                if "runtime_generation" in columns
                else "NULL AS runtime_generation"
            )
            rows = list(
                conn.execute(
                    "SELECT id, profile_name, model, title, display_name, started_at, ended_at, "
                    "last_activity_at, last_activity_description, end_reason, message_count, "
                    "tool_call_count, input_tokens, output_tokens, estimated_cost_usd, cwd, "
                    "git_branch, parent_session_id, source, archived, hidden, "
                    f"{generation_expr} "
                    "FROM sessions WHERE COALESCE(hidden, 0) = 0 "
                    "AND (end_reason IS NULL OR COALESCE(last_activity_at, started_at) >= ?) "
                    "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?",
                    (cutoff, MAX_SESSIONS_PER_PROFILE),
                )
            )

            for row in rows:
                session_id = str(row["id"])
                lease = leases.get(session_id)
                lease_live = lease is not None and _as_float(lease["expires_at"]) is not None and (
                    float(lease["expires_at"]) > current
                )
                lease_expired = lease is not None and not lease_live
                delegation = delegations.get(session_id)
                end_reason = row["end_reason"]
                last_activity = _as_float(row["last_activity_at"]) or _as_float(row["started_at"])
                ended_at = _as_float(row["ended_at"])

                state, since = classify_session(
                    end_reason=end_reason,
                    ended_at=ended_at,
                    lease_live=lease_live,
                    lease_expired=lease_expired,
                    lease_acquired_at=_as_float(lease["acquired_at"]) if lease is not None else None,
                    delegating_since=(
                        _as_float(delegation["first_at"]) if delegation is not None else None
                    ),
                    queued=session_id in queued,
                    last_activity=last_activity,
                    cutoff=cutoff,
                    now=current,
                )

                tool_name = None
                if state in ("running", "queued", "idle"):
                    tool_name = _pending_tool(
                        conn, f"{db_path}:{session_id}", session_id
                    )

                appearance = appearances.get(profile_name) or {}
                avatar = {
                    "has_image": bool(appearance.get("has_image")),
                    "shape": appearance.get("shape"),
                    "color": appearance.get("color"),
                    "image_kind": appearance.get("image_kind"),
                }

                activity = (row["last_activity_description"] or "").strip()
                if not activity:
                    activity = tool_name or ""

                title = (row["title"] or "").strip() or (row["display_name"] or "").strip() or session_id
                cost = _as_float(row["estimated_cost_usd"])

                sessions.append(
                    {
                        "id": session_id,
                        "profile": profile_name,
                        "profile_label": profile_label(profile_name),
                        "profile_title": appearance.get("profile_title") or profile_label(profile_name),
                        "avatar": avatar,
                        "title": title,
                        "model": row["model"] or "",
                        "state": state,
                        "activity": activity,
                        "tool": tool_name,
                        "since": int(since) if since else None,
                        "last_activity_at": int(last_activity) if last_activity else None,
                        "elapsed_s": max(0, int(current - since)) if since else 0,
                        "messages": _as_int(row["message_count"]),
                        "tools": _as_int(row["tool_call_count"]),
                        "tokens_in": _as_int(row["input_tokens"]),
                        "tokens_out": _as_int(row["output_tokens"]),
                        "cost_usd": round(cost, 6) if cost is not None else 0.0,
                        "cwd": row["cwd"] or "",
                        "git_branch": row["git_branch"] or "",
                        "parent_id": row["parent_session_id"] or None,
                        "source": row["source"] or "",
                        "stalled": state == "stalled",
                        # F8: "waiting for the user" is not a new state, it is
                        # the honest reading of ``idle``: the turn ended and the
                        # ball is in the user's court. The reason is the exact
                        # activity line the row already exposes, so the panel
                        # never invents copy.
                        "waiting_for_user": state == "idle",
                        "waiting_reason": activity if state == "idle" else "",
                        "can_interrupt": state in INTERRUPTIBLE_STATES,
                        "execution_generation": _as_generation(row["runtime_generation"]),
                        "delegating": _as_int(delegation["n"]) if delegation is not None else 0,
                    }
                )
        except sqlite3.DatabaseError as exc:
            failures[profile_name] = f"{type(exc).__name__}: {exc}"
        finally:
            try:
                conn.close()
            except Exception:
                pass

    # Attention first, then the longest-running work inside each state band.
    sessions.sort(
        key=lambda item: (
            _STATE_ORDER.get(str(item["state"]), 9),
            -(item["elapsed_s"] or 0),
            -(item["last_activity_at"] or 0),
        )
    )

    # Dormant rows are counted, never listed: an abandoned session from last
    # week is history, not a live warning, and painting it red would make the
    # whole view useless.
    visible = [item for item in sessions if item["state"] != "dormant"]
    dormant = [item for item in sessions if item["state"] == "dormant"]

    per_state = {
        state: sum(1 for item in visible if item["state"] == state)
        for state in ("running", "queued", "stalled", "idle", "done", "failed")
    }

    totals = {
        **per_state,
        # Two aggregate readings the panel leads with: work in progress and
        # turns that ended and now wait on the user. Every per-state key stays,
        # so existing consumers are untouched.
        "working": per_state["running"] + per_state["queued"],
        "waiting": per_state["idle"],
        "live": sum(per_state[state] for state in LIVE_STATES),
        "dormant": len(dormant),
        "sessions": len(visible),
    }

    snapshot: dict[str, Any] = {
        "generated_at": int(current),
        "profiles": profile_names,
        "window_s": window_s,
        "sessions": visible,
        "totals": totals,
    }
    if failures:
        snapshot["profile_errors"] = failures
    return snapshot


# ---------------------------------------------------------------------------
# Change watcher (lazy, one thread, only while the plugin is used)
# ---------------------------------------------------------------------------


def _watcher_disabled() -> bool:
    return os.environ.get("RADAR_DISABLE_WATCHER", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _fingerprint(snapshot: dict[str, Any]) -> str:
    visible = [
        (
            item["id"],
            item["state"],
            item["tool"],
            item["activity"],
            item["messages"],
            item["tools"],
            item["last_activity_at"],
        )
        for item in snapshot.get("sessions", [])
    ]
    return json.dumps(
        {"profiles": snapshot.get("profiles"), "sessions": visible, "totals": snapshot.get("totals")},
        sort_keys=True,
    )


def _watcher_idle_expired(now: Optional[float] = None) -> bool:
    """True when no ``/live`` request arrived inside ``WATCHER_IDLE_TIMEOUT_S``."""
    monotonic = time.monotonic() if now is None else now
    return (monotonic - _LAST_LIVE_HIT) >= WATCHER_IDLE_TIMEOUT_S


def _watch_loop() -> None:
    last: Optional[str] = None
    last_broadcast = 0.0
    while True:
        # A panel that was closed (or a page that stopped polling) leaves no
        # signal other than the absence of requests: stop spending queries.
        if _watcher_idle_expired():
            return
        try:
            snapshot = build_snapshot()
            fingerprint = _fingerprint(snapshot)
            if fingerprint != last:
                # ``last`` is only advanced when the broadcast actually happens,
                # so a change that lands inside the floor is not lost: it goes
                # out on the next allowed tick.
                monotonic = time.monotonic()
                if monotonic - last_broadcast >= BROADCAST_FLOOR_S:
                    last = fingerprint
                    last_broadcast = monotonic
                    try:
                        from hermes_cli.plugin_events import broadcast_plugin_event

                        broadcast_plugin_event(
                            PLUGIN_ID,
                            "changed",
                            {
                                "generated_at": snapshot["generated_at"],
                                "totals": snapshot["totals"],
                            },
                        )
                    except Exception:
                        pass
        except Exception:
            pass
        time.sleep(WATCH_INTERVAL_S)


def ensure_watcher() -> None:
    """Start the lazy change watcher once (no-op when explicitly disabled)."""
    global _WATCHER, _LAST_LIVE_HIT
    if _watcher_disabled():
        return
    with _WATCHER_LOCK:
        if _WATCHER is not None and _WATCHER.is_alive():
            return
        # A watcher started from anywhere other than ``live()`` still gets a
        # full idle window instead of exiting on its first tick.
        if _LAST_LIVE_HIT <= 0.0:
            _LAST_LIVE_HIT = time.monotonic()
        _WATCHER = threading.Thread(
            target=_watch_loop, name="radar-watcher", daemon=True
        )
        _WATCHER.start()


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


router = APIRouter()


@router.get("/avatar/{profile}")
def avatar(profile: str) -> Any:
    """The profile's real PNG avatar as a data URL.

    Only profiles that ``discover_profiles()`` actually returned are served,
    and the path is rebuilt from that profile's directory — a request segment
    is a lookup key, never a filesystem path.
    """
    target = _avatar_target(profile)
    if target is None:
        return JSONResponse({"data_url": None, "error": "unknown profile"}, status_code=404)
    return JSONResponse({"data_url": _read_avatar_data_url(target)})


@router.get("/live")
def live(window: int = DEFAULT_WINDOW_S, profiles: str = "all") -> dict[str, Any]:
    """Live snapshot of every discovered profile (read-only)."""
    global _LAST_LIVE_HIT
    _LAST_LIVE_HIT = time.monotonic()
    ensure_watcher()
    return build_snapshot(profiles=profiles, window=window)


def _json_for_script(value: Any) -> str:
    """JSON safe to embed inside an inline ``<script>``.

    ``json.dumps`` does not escape ``</script>``; the HTML parser would end the
    block there. Escaping ``<``, ``>`` and ``&`` as JS unicode escapes keeps the
    parsed value identical while the markup can never be closed early.
    """
    return (
        json.dumps(value)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


@router.get("/view", response_class=HTMLResponse)
def view(
    window: int = DEFAULT_WINDOW_S,
    profiles: str = "all",
    theme: str = "dark",
    tab: str = "all",
) -> Any:
    """Self-contained HTML mirror of ``/live`` (no CDN, no build step).

    The page never reflects the raw ``profiles`` query: it embeds the profile
    list that ``select_profiles()`` actually resolved, so an attacker-controlled
    selector has nothing to interpolate. ``theme`` and ``tab`` are validated
    against closed sets for the same reason; neither raw value reaches the
    markup.
    """
    try:
        window_s = max(MIN_WINDOW_S, min(MAX_WINDOW_S, int(window)))
    except (TypeError, ValueError):
        window_s = DEFAULT_WINDOW_S

    selected, names = select_profiles(hermes_home(), profiles or "all")
    # An empty selection travels as ``none``: ``profiles=`` would mean "all".
    selector = ",".join(names) if names else "none"
    palette = theme.strip().lower() if isinstance(theme, str) else "dark"
    if palette not in ("dark", "light"):
        palette = "dark"

    selected_tab = tab.strip().lower() if isinstance(tab, str) else "all"
    if selected_tab not in ("all", "working", "waiting", "problem"):
        selected_tab = "all"

    # At most nine small PNGs (one per selected profile): inlining them makes
    # the page paint avatars without a second round-trip and keeps the headless
    # capture deterministic. Only already-validated data URLs travel here.
    avatars: dict[str, Any] = {}
    for name, db_path in selected:
        appearance = profile_appearance(name, Path(db_path).parent)
        avatars[name] = {
            "title": appearance["profile_title"],
            "shape": appearance["shape"],
            "color": appearance["color"],
            "image_kind": appearance["image_kind"],
            "data_url": (
                _read_avatar_data_url(_avatar_path(Path(db_path).parent))
                if appearance["has_image"]
                else None
            ),
        }

    html = (
        _VIEW_HTML.replace("__PROFILES__", _json_for_script(selector))
        .replace("__AVATARS__", _json_for_script(avatars))
        .replace("__WINDOW__", str(window_s))
        .replace("__REFRESH_MS__", str(int(WATCH_INTERVAL_S * 1000)))
        .replace("__THEME__", palette)
        .replace("__TAB__", _json_for_script(selected_tab))
    )
    return HTMLResponse(content=html)


_VIEW_HTML = """<!doctype html>
<html lang="en" data-theme="__THEME__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radar</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #05070a;
    --app: #0d1117;
    --surface: #161b22;
    --surface-2: #1c2129;
    --border: #30363d;
    --border-soft: #21262d;
    --text: #e6edf3;
    --muted: #9aa4af;
    --dim: #7d8590;
    --accent: #ff4d00;
    --green: #3fb950;
    --amber: #d29922;
    --red: #f85149;
    /* Semantic inks derive from the text colour so both palettes keep their
       contrast: a light theme darkens them, a dark theme lightens them. */
    --violet: color-mix(in srgb, var(--text) 68%, #bc8cff);
    --warn: color-mix(in srgb, var(--text) 55%, var(--red));
    --success: color-mix(in srgb, var(--text) 45%, var(--green));
    --sans: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif;
    --mono: "JetBrains Mono", "Cascadia Code", "DejaVu Sans Mono", ui-monospace, monospace;
  }
  html[data-theme="light"] {
    color-scheme: light;
    --bg: #eef1f5;
    --app: #ffffff;
    --surface: #f6f8fa;
    --surface-2: #eef1f5;
    --border: #d0d7de;
    --border-soft: #e4e9ee;
    --text: #1f2328;
    --muted: #57606a;
    --dim: #6e7781;
    --accent: #d63a00;
    --green: #1a7f37;
    --amber: #9a6700;
    --red: #cf222e;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    padding: 24px 20px 32px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
  }
  .app {
    max-width: 1180px;
    margin: 0 auto;
    background: var(--app);
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 0 0 4px;
  }
  /* ---------- header ---------- */
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-soft);
  }
  .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .mark {
    width: 20px; height: 20px; flex: 0 0 20px;
    border-radius: 5px;
    background: var(--accent);
    color: #170600;
    font-size: 10px; font-weight: 800;
    display: grid; place-items: center;
    letter-spacing: .2px;
  }
  h1 { font-size: 14px; font-weight: 700; letter-spacing: .2px; margin: 0; white-space: nowrap; }
  .live {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: var(--mono); font-size: 10px; color: var(--success);
    background: color-mix(in srgb, var(--green) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--green) 32%, transparent);
    border-radius: 20px; padding: 2px 7px;
    white-space: nowrap;
  }
  .live.warn { color: var(--warn); background: color-mix(in srgb, var(--red) 10%, transparent); border-color: color-mix(in srgb, var(--red) 34%, transparent); }
  .live.warn i { background: var(--red); }
  .live.calm { color: var(--muted); background: color-mix(in srgb, var(--muted) 9%, transparent); border-color: color-mix(in srgb, var(--muted) 24%, transparent); }
  .live.calm i { background: var(--dim); animation: none; }
  .live i {
    width: 6px; height: 6px; border-radius: 50%; background: var(--green); display: block;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 45%, transparent);
    animation: beat 1.8s ease-out infinite;
  }
  @keyframes beat {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 45%, transparent); }
    70% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--green) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 0%, transparent); }
  }
  .status {
    margin-left: auto;
    font-family: var(--mono); font-size: 10.5px; color: var(--dim);
    white-space: nowrap;
  }
  .status[data-state="error"] { color: var(--warn); }
  .pip-btn {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    padding: 3px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .pip-btn:hover { color: var(--text); border-color: var(--accent); }
  .pip-btn.on {
    color: var(--text);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  /* ---------- counters ---------- */
  .summary {
    display: flex; flex-wrap: wrap; gap: 6px 14px;
    padding: 9px 14px 10px;
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
    border-bottom: 1px solid var(--border-soft);
  }
  .summary b { color: var(--text); font-weight: 600; }
  .summary .hot b { color: var(--warn); }
  .summary .wait b { color: var(--amber); }
  .summary .calm b { color: var(--dim); }
  /* ---------- segments ---------- */
  .segs { display: flex; gap: 2px; padding: 8px 12px 0; }
  .seg {
    appearance: none;
    background: transparent;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
    color: var(--dim);
    font: inherit; font-size: 11.5px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .seg:hover { color: var(--text); }
  .seg.on {
    color: var(--text);
    background: var(--app);
    border-color: var(--border-soft);
    margin-bottom: -1px;
  }
  /* ---------- cards ---------- */
  .grid {
    display: grid;
    gap: 8px;
    /* ``auto-fit`` collapses the empty tracks so a single card fills the row. */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    padding: 10px 12px 14px;
  }
  .card {
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 9px 10px 8px;
  }
  .card.run { border-color: color-mix(in srgb, var(--green) 30%, transparent); background: color-mix(in srgb, var(--green) 6%, var(--surface)); }
  .card.queue { border-style: dashed; background: color-mix(in srgb, var(--amber) 6%, var(--surface)); }
  .card.bad { border-color: color-mix(in srgb, var(--red) 42%, transparent); background: color-mix(in srgb, var(--red) 7%, var(--surface)); }
  .card.bad h2 { color: var(--warn); }
  .card.idle { background: var(--surface); }
  .card.idle h2 { color: var(--muted); font-weight: 500; }
  /* F8: idle means "the turn ended and the user is awaited". Amber, not grey:
     it must be findable at a glance, and red stays reserved for stalled/failed. */
  .card.wait {
    border-color: color-mix(in srgb, var(--amber) 38%, transparent);
    border-left: 3px solid var(--amber);
    background: color-mix(in srgb, var(--amber) 8%, var(--surface));
  }
  .card.wait h2 { color: var(--text); font-weight: 600; }
  .badge {
    flex: 0 0 auto;
    font-family: var(--mono); font-size: 9px; line-height: 1.5;
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--amber) 34%, transparent);
    border-radius: 4px; padding: 0 4px;
  }
  .card.done { opacity: .75; }
  .r1 { display: flex; align-items: center; gap: 9px; min-width: 0; }
  /* avatar: the profile's real PNG, clipped to its stored silhouette; the
     tinted initial is the fallback when a profile has no image. */
  .av {
    width: 30px; height: 30px; flex: 0 0 30px;
    display: grid; place-items: center;
    overflow: hidden;
    font-size: 11px; font-weight: 700; line-height: 1;
    color: var(--text);
    background: color-mix(in srgb, var(--text) 13%, transparent);
  }
  .av img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: inherit; }
  /* Photos keep the roster's soft square; the stored silhouette is the
     fallback vocabulary, not a crop mask for a real face. */
  .av-image { border-radius: 22%; }
  .av span { display: block; }
  .av-circle { border-radius: 50%; }
  .av-squircle { border-radius: 8px; }
  .av-pill { border-radius: 13px; }
  .av-triangle { clip-path: polygon(50% 2%, 98% 96%, 2% 96%); }
  .av-hexagon { clip-path: polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0% 50%); }
  .av-cloud { border-radius: 52% 48% 44% 56% / 58% 62% 38% 42%; }
  .av-drop { border-radius: 50% 50% 50% 50% / 62% 62% 38% 38%; }
  .av-blob { border-radius: 46% 54% 52% 48% / 55% 46% 54% 45%; }
  .rbody { flex: 1; min-width: 0; }
  .rname { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .prof {
    flex: 0 0 auto;
    font-family: var(--mono); font-size: 9px; color: var(--dim);
    border: 1px solid var(--border-soft); border-radius: 4px; padding: 0 4px;
  }
  /* One status mark per row: a single pulsing dot, never a row of dots that
     reads as a truncated title. */
  .st {
    flex: 0 0 14px; width: 14px; align-self: center;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--mono); font-size: 11px; line-height: 1;
    color: var(--dim);
  }
  .st.run { color: var(--muted); }
  .st.run span { display: block; animation: blink 1.4s infinite; }
  .st.q { color: var(--amber); font-size: 13px; }
  .st.bad { color: var(--red); font-size: 13px; }
  .st.wait { color: var(--amber); font-size: 13px; }
  .st.ok { color: var(--green); font-size: 13px; }
  @keyframes blink {
    0%, 60%, 100% { opacity: .25; }
    30% { opacity: 1; }
  }
  h2 {
    flex: 1; min-width: 0;
    margin: 0;
    font-size: 12.5px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .meta {
    margin: 4px 0 0;
    display: flex; align-items: center; gap: 6px; min-width: 0;
    font-family: var(--mono); font-size: 10px; color: var(--dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .meta em { font-style: normal; color: var(--muted); flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .meta .prof { flex: 0 0 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
  .act {
    margin: 6px 0 0;
    display: flex; gap: 6px; align-items: baseline;
    font-family: var(--mono); font-size: 10.5px; line-height: 1.45;
    color: var(--muted);
    overflow: hidden;
  }
  .act .name { color: var(--violet); flex: 0 0 auto; }
  .act .arg { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .foot {
    display: flex; flex-wrap: wrap; gap: 10px;
    margin: 7px 0 0;
    font-family: var(--mono); font-size: 9.5px; color: var(--dim);
  }
  .foot .warn { color: var(--warn); }
  .foot .ok { color: var(--success); }
  .empty {
    grid-column: 1 / -1;
    padding: 34px 10px 38px;
    text-align: center;
  }
  .empty strong { display: block; font-size: 13px; font-weight: 600; }
  .empty span { display: block; margin-top: 4px; color: var(--dim); font-size: 11.5px; }
  .errors {
    margin: 0; padding: 0 14px 10px;
    font-family: var(--mono); font-size: 10.5px; color: var(--warn);
  }
  .errors:empty { display: none; }
  .footbar {
    display: flex; flex-wrap: wrap; gap: 10px;
    padding: 8px 14px 10px;
    border-top: 1px solid var(--border-soft);
    font-family: var(--mono); font-size: 9.5px; color: var(--dim);
  }
  .footbar .right { margin-left: auto; }
  .footbar .scope { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    max-width: 220px; padding: 1px 7px;
    color: var(--text); background: var(--surface-2);
    border: 1px solid var(--border-soft); border-radius: 20px;
    font-size: 10px; line-height: 1.5;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: default;
  }
  @media (max-width: 640px) {
    body { padding: 12px 10px 20px; }
    .app { border-radius: 8px; }
    .head { padding: 10px 11px; }
    .status { margin-left: 0; width: 100%; }
    .summary { padding: 8px 11px 9px; gap: 5px 11px; }
    .grid { padding: 9px 10px 12px; }
    .footbar { padding: 8px 11px; }
  }
  @media (max-width: 380px) {
    h1 { font-size: 13px; }
    .summary { font-size: 10px; }
  }
</style>
</head>
<body>
<div class="app">
  <header class="head">
    <div class="brand">
      <span class="mark" aria-hidden="true">RD</span>
      <h1>Radar</h1>
    </div>
    <span class="live" id="live-pill"><i aria-hidden="true"></i><span id="live-label">0 live</span></span>
    <span class="status" id="status">connecting…</span>
    <button class="pip-btn" id="lang-btn" type="button" title="Switch language / Cambiar idioma">🌐 EN</button>
    <button class="pip-btn" id="pip-btn" type="button" aria-pressed="false" title="Keep mini-window always on top (Picture-in-Picture)">📌 Always on Top</button>
  </header>

  <div class="summary" id="summary"></div>

  <nav class="segs" id="segs" aria-label="Filter sessions">
    <button class="seg on" type="button" data-filter="all">All</button>
    <button class="seg" type="button" data-filter="working">Working</button>
    <button class="seg" type="button" data-filter="waiting">Waiting</button>
    <button class="seg" type="button" data-filter="problem">Problem</button>
  </nav>

  <main class="grid" id="grid" aria-live="polite"></main>
  <p class="errors" id="errors"></p>

  <div class="footbar">
    <span class="scope" id="scope">—</span>
    <span class="right" id="cadence">every 2 s</span>
  </div>
</div>
<script>
  const PROFILES = __PROFILES__;
  const AVATARS = __AVATARS__;
  const WINDOW = __WINDOW__;
  const REFRESH = __REFRESH_MS__;
  // Server-validated closed set (all|working|waiting|problem); never raw input.
  const INITIAL_TAB = __TAB__;
  const LIVE_URL = new URL(
    'live?profiles=' + encodeURIComponent(PROFILES) + '&window=' + WINDOW,
    window.location.href
  );

  const grid = document.getElementById('grid');
  const summaryEl = document.getElementById('summary');
  const statusEl = document.getElementById('status');
  const errorsEl = document.getElementById('errors');
  const livePill = document.getElementById('live-pill');
  const liveLabel = document.getElementById('live-label');
  const scopeEl = document.getElementById('scope');
  const cadenceEl = document.getElementById('cadence');
  const segsEl = document.getElementById('segs');

  const STATES = {
    running: { label: 'running', cls: 'run' },
    queued: { label: 'queued', cls: 'queue' },
    stalled: { label: 'stalled', cls: 'bad' },
    idle: { label: 'waiting', cls: 'idle wait' },
    done: { label: 'completed', cls: 'done' },
    failed: { label: 'failed', cls: 'done' }
  };

  const GLYPHS = {
    stalled: { cls: 'bad', glyph: '!', label: 'stalled' },
    queued: { cls: 'q', glyph: '◷', label: 'queued' },
    idle: { cls: 'wait', glyph: '●', label: 'waiting' },
    done: { cls: 'ok', glyph: '✓', label: 'completed' },
    failed: { cls: 'bad', glyph: '✗', label: 'failed' }
  };

  let filter = INITIAL_TAB;
  let latest = null;
  let currentLang = (new URLSearchParams(window.location.search).get('lang') || localStorage.getItem('radar.lang') || 'en').toLowerCase() === 'es' ? 'es' : 'en';

  const LOCALES = {
    en: {
      pipBtn: '📌 Always on Top',
      pipHeader: 'Radar · Always on Top',
      tabs: { all: 'All', working: 'Working', waiting: 'Waiting', problem: 'Problem' },
      runningLabel: 'running',
      waitBadge: 'waiting',
      noModel: 'no model',
      doneFoot: '✓ completed',
      failedFoot: '✗ failed',
      noHeartbeat: 'no heartbeat for ',
      queuedAct: 'queued admission',
      waitingUser: 'waiting for user',
      sessionOne: 'session',
      sessionMany: 'sessions',
      working: 'working',
      waiting: 'waiting',
      stalledOne: 'stalled',
      stalledMany: 'stalled',
      dormantOne: 'dormant',
      dormantMany: 'dormant',
      windowPrefix: 'window ',
      noProfiles: 'no profiles',
      noProfilesTitle: 'no profile selected',
      profilesMany: ' profiles',
      emptyAllTitle: 'No active sessions',
      emptyAllDormant: ' dormant, outside window',
      emptyAllNone: 'No sessions in recent history',
      emptyProbTitle: 'Nothing stalled',
      emptyProbSub: 'No session needs attention',
      emptyWaitTitle: 'Nobody waiting',
      emptyWaitSub: 'No turn waiting on user',
      emptyWorkTitle: 'No session working',
      updatedAgo: 'updated ',
      cadencePrefix: 'every ',
      offline: 'offline'
    },
    es: {
      pipBtn: '📌 Siempre encima',
      pipHeader: 'Radar · Siempre encima',
      tabs: { all: 'Todas', working: 'Trabajando', waiting: 'Esperan', problem: 'Problema' },
      runningLabel: 'corriendo',
      waitBadge: 'espera',
      noModel: 'sin modelo',
      doneFoot: '✓ completada',
      failedFoot: '✗ fallida',
      noHeartbeat: 'sin latido hace ',
      queuedAct: 'admisión en cola',
      waitingUser: 'esperando al usuario',
      sessionOne: 'sesión',
      sessionMany: 'sesiones',
      working: 'trabajando',
      waiting: 'esperando',
      stalledOne: 'colgada',
      stalledMany: 'colgadas',
      dormantOne: 'inactiva',
      dormantMany: 'inactivas',
      windowPrefix: 'ventana ',
      noProfiles: 'sin perfiles',
      noProfilesTitle: 'ningún perfil seleccionado',
      profilesMany: ' perfiles',
      emptyAllTitle: 'Ninguna sesión activa',
      emptyAllDormant: ' inactivas, fuera de la ventana',
      emptyAllNone: 'Sin sesiones en el historial reciente',
      emptyProbTitle: 'Nada colgado',
      emptyProbSub: 'Ninguna sesión necesita atención',
      emptyWaitTitle: 'Nadie espera',
      emptyWaitSub: 'Ningún turno esperando al usuario',
      emptyWorkTitle: 'Ninguna sesión trabajando',
      updatedAgo: 'actualizado hace ',
      cadencePrefix: 'cada ',
      offline: 'sin conexión'
    }
  };
  function L() { return LOCALES[currentLang] || LOCALES.en; }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function fmtClock(seconds) {
    let total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    total -= hours * 3600;
    const minutes = Math.floor(total / 60);
    const secs = total - minutes * 60;
    return hours
      ? hours + ':' + pad(minutes) + ':' + pad(secs)
      : pad(minutes) + ':' + pad(secs);
  }

  function fmtAgo(ts) {
    if (!ts) return '—';
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
    if (delta < 60) return delta + ' s';
    if (delta < 3600) return Math.floor(delta / 60) + ' min';
    if (delta < 86400) return Math.floor(delta / 3600) + ' h';
    return Math.floor(delta / 86400) + ' d';
  }

  function fmtTokens(value) {
    const n = Number(value) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function fmtCost(value) {
    const n = Number(value) || 0;
    return '$' + n.toFixed(2);
  }

  function activityText(session) {
    if (session.state === 'stalled') {
      return L().noHeartbeat + fmtAgo(session.last_activity_at);
    }
    if (session.state === 'queued') {
      return session.activity || L().queuedAct;
    }
    if (session.activity && session.activity !== session.tool) return session.activity;
    if (session.state === 'idle') return L().waitingUser;
    return '';
  }

  const AVATAR_SHAPES = ['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop', 'blob'];
  const BLOB_KIND_SHAPE = {
    round: 'circle', organic: 'blob', boxy: 'squircle', capsule: 'pill',
    nub: 'drop', cloud: 'cloud', droplet: 'drop', hexagon: 'hexagon',
    sun: 'circle', triangle: 'triangle'
  };

  function hashName(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash;
  }

  // A stored shape is either a silhouette or ``blobatar[:seed[:kind]]``; the
  // pinned kind wins, then the name hash, so the fallback never looks random
  // between two renders of the same profile.
  function shapeClass(shape, key) {
    const raw = String(shape || '').trim().toLowerCase();
    const hash = hashName(key);
    if (raw.indexOf('blobatar') === 0) {
      const kind = raw.split(':')[2] || '';
      return BLOB_KIND_SHAPE[kind] || AVATAR_SHAPES[hash % AVATAR_SHAPES.length];
    }
    return AVATAR_SHAPES.indexOf(raw) >= 0 ? raw : AVATAR_SHAPES[hash % AVATAR_SHAPES.length];
  }

  function avatar(session) {
    const key = String(session.profile || 'default').trim() || 'default';
    const info = AVATARS[key] || {};
    const title = String(session.profile_title || info.title || session.profile_label || key);
    // A photo is a real face, not a silhouette: it always gets the soft square.
    const photo = info.image_kind === 'photo' || !!info.data_url;
    const node = el('span', 'av ' + (photo ? 'av-image' : 'av-' + shapeClass(info.shape, key)));
    const color = /^#[0-9a-f]{6}$/i.test(String(info.color || '')) ? info.color : null;
    if (color) node.style.background = 'color-mix(in srgb, ' + color + ' 30%, transparent)';
    if (info.data_url) {
      // Already validated server-side (PNG signature + size bound).
      const img = document.createElement('img');
      img.src = info.data_url;
      img.alt = '';
      img.width = 30;
      img.height = 30;
      node.appendChild(img);
    } else {
      node.appendChild(el('span', null, title.charAt(0).toUpperCase() || '?'));
    }
    node.title = title;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function stateGlyph(state) {
    if (state === 'running') {
      const node = el('span', 'st run');
      node.setAttribute('aria-label', L().runningLabel);
      node.appendChild(el('span', null, '●'));
      return node;
    }
    const meta = GLYPHS[state] || GLYPHS.idle;
    const node = el('span', 'st ' + meta.cls, meta.glyph);
    node.setAttribute('aria-label', meta.label);
    return node;
  }

  function card(session) {
    const meta = STATES[session.state] || STATES.idle;
    const node = el('article', 'card ' + meta.cls);
    node.setAttribute('data-state', session.state || 'idle');

    const row = el('div', 'r1');
    row.appendChild(avatar(session));

    const body = el('div', 'rbody');
    const name = el('div', 'rname');
    name.appendChild(el('h2', null, session.title || session.id));
    if (session.state === 'idle') name.appendChild(el('span', 'badge', L().waitBadge));
    body.appendChild(name);

    const metaLine = el('div', 'meta');
    metaLine.appendChild(el('em', null, session.model || L().noModel));
    metaLine.appendChild(document.createTextNode(' · ' + fmtClock(session.elapsed_s)));
    // The profile badge lives on the metadata line: inside the title row it
    // competed with the title and moved the heading's start between cards.
    metaLine.appendChild(el('span', 'prof',
      session.profile_title || session.profile_label || session.profile || 'default'));
    body.appendChild(metaLine);

    row.appendChild(body);
    row.appendChild(stateGlyph(session.state));
    node.appendChild(row);

    const act = el('div', 'act');
    if (session.tool) act.appendChild(el('span', 'name', session.tool));
    const text = activityText(session);
    if (text) act.appendChild(el('span', 'arg', text));
    if (act.childNodes.length) node.appendChild(act);

    const foot = el('div', 'foot');
    if (session.state === 'done' || session.state === 'failed') {
      foot.appendChild(el('span', session.state === 'done' ? 'ok' : 'warn',
        session.state === 'done' ? L().doneFoot : L().failedFoot));
    }
    if (session.tools) {
      foot.appendChild(el('span', null,
        session.tools + (session.tools === 1 ? ' tool' : ' tools')));
    }
    if (session.tokens_in || session.tokens_out) {
      foot.appendChild(el('span', null,
        fmtTokens(session.tokens_in) + ' ↑ ' + fmtTokens(session.tokens_out) + ' ↓'));
    }
    if (session.cost_usd) foot.appendChild(el('span', null, fmtCost(session.cost_usd)));
    if (foot.childNodes.length) node.appendChild(foot);

    node.title = session.id + (session.git_branch ? ' · ' + session.git_branch : '');
    return node;
  }

  function visibleSessions(sessions) {
    if (filter === 'working') {
      return sessions.filter(s => s.state === 'running' || s.state === 'queued');
    }
    if (filter === 'waiting') {
      return sessions.filter(s => s.state === 'idle');
    }
    if (filter === 'problem') {
      return sessions.filter(s => s.state === 'stalled' || s.state === 'failed');
    }
    return sessions;
  }

  function renderCounters(totals) {
    const t = totals || {};
    summaryEl.replaceChildren();
    // A zero never earns a segment: six counters where four are "0" read as
    // noise and make the real numbers harder to find.
    const add = (count, one, many, cls, always) => {
      const value = count || 0;
      if (!value && !always) return;
      const item = el('span', cls);
      item.appendChild(el('b', null, String(value)));
      item.appendChild(document.createTextNode(' ' + (value === 1 ? one : many)));
      summaryEl.appendChild(item);
    };
    add(t.sessions, L().sessionOne, L().sessionMany, null, true);
    // F8: lead with work in progress and turns waiting on the user. Both are
    // derived from the per-state counters when an older payload omits them.
    const working = t.working !== undefined ? t.working : (t.running || 0) + (t.queued || 0);
    const waiting = t.waiting !== undefined ? t.waiting : (t.idle || 0);
    add(working, L().working, L().working);
    add(waiting, L().waiting, L().waiting, 'wait');
    add(t.stalled, L().stalledOne, L().stalledMany, t.stalled ? 'hot' : null);
    add(t.dormant, L().dormantOne, L().dormantMany, 'calm');

    liveLabel.textContent = (t.live || 0) + ' live';
    livePill.classList.toggle('warn', Boolean(t.stalled));
    livePill.classList.toggle('calm', !t.live && !t.stalled);
  }

  function renderTabs(data) {
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const counts = {
      all: sessions.length,
      working: sessions.filter(s => s.state === 'running' || s.state === 'queued').length,
      waiting: sessions.filter(s => s.state === 'idle').length,
      problem: sessions.filter(s => s.state === 'stalled' || s.state === 'failed').length
    };
    const labels = L().tabs || LOCALES.en.tabs;
    segsEl.querySelectorAll('button[data-filter]').forEach(button => {
      const name = button.dataset.filter;
      button.textContent = labels[name] + ' (' + (counts[name] || 0) + ')';
      button.classList.toggle('on', name === filter);
    });
  }

  function renderScope(data) {
    const names = Array.isArray(data.profiles) ? data.profiles : [];
    scopeEl.replaceChildren();
    scopeEl.appendChild(document.createTextNode(
      L().windowPrefix + (data.window_s || WINDOW) + ' s · '
    ));
    if (!names.length) {
      // ``?profiles=none`` is a real selection, not a missing one: never leave
      // a dangling "perfiles: " with nothing after it.
      const none = el('span', 'chip', L().noProfiles);
      none.title = L().noProfilesTitle;
      scopeEl.appendChild(none);
      return;
    }
    const chip = el('span', 'chip',
      names.length === 1 ? names[0] : names.length + L().profilesMany);
    chip.title = names.join(', ');
    scopeEl.appendChild(chip);
  }

  function render() {
    const data = latest;
    if (!data) return;
    renderCounters(data.totals);
    renderTabs(data);

    const sessions = visibleSessions(Array.isArray(data.sessions) ? data.sessions : []);
    grid.replaceChildren();
    if (!sessions.length) {
      const empty = el('div', 'empty');
      const dormant = (data.totals || {}).dormant || 0;
      if (filter === 'all') {
        empty.appendChild(el('strong', null, L().emptyAllTitle));
        empty.appendChild(el('span', null,
          dormant ? dormant + L().emptyAllDormant : L().emptyAllNone));
      } else if (filter === 'problem') {
        empty.appendChild(el('strong', null, L().emptyProbTitle));
        empty.appendChild(el('span', null, L().emptyProbSub));
      } else if (filter === 'waiting') {
        empty.appendChild(el('strong', null, L().emptyWaitTitle));
        empty.appendChild(el('span', null, L().emptyWaitSub));
      } else {
        empty.appendChild(el('strong', null, L().emptyWorkTitle));
        empty.appendChild(el('span', null, dormant + ' ' + L().dormantMany));
      }
      grid.appendChild(empty);
    } else {
      sessions.forEach(session => grid.appendChild(card(session)));
    }

    const errors = data.profile_errors || {};
    const names = Object.keys(errors);
    errorsEl.textContent = names.length
      ? names.map(name => name + ': ' + errors[name]).join(' | ')
      : '';

    statusEl.dataset.state = 'ok';
    statusEl.textContent = L().updatedAgo + fmtAgo(data.generated_at);

    renderScope(data);
    cadenceEl.textContent = L().cadencePrefix + Math.round(REFRESH / 1000) + ' s';
    if (pipCanvas && document.pictureInPictureElement === pipVideo) {
      drawPipCanvas(data);
    }
  }

  const langBtn = document.getElementById('lang-btn');
  const pipBtn = document.getElementById('pip-btn');
  function syncLangBtn() {
    document.documentElement.lang = currentLang;
    if (langBtn) langBtn.textContent = '🌐 ' + currentLang.toUpperCase();
    if (pipBtn) pipBtn.textContent = L().pipBtn;
  }
  syncLangBtn();
  if (langBtn) {
    langBtn.addEventListener('click', () => {
      currentLang = currentLang === 'en' ? 'es' : 'en';
      try { localStorage.setItem('radar.lang', currentLang); } catch (_e) {}
      syncLangBtn();
      render();
    });
  }
  let pipCanvas = null;
  let pipVideo = null;
  let pipStream = null;

  function drawPipCanvas(data) {
    if (!pipCanvas) return;
    const g = pipCanvas.getContext('2d');
    if (!g) return;
    const t = (data && data.totals) || {};
    const working = t.working !== undefined ? t.working : (t.running || 0) + (t.queued || 0);
    const waiting = t.waiting !== undefined ? t.waiting : (t.idle || 0);
    const stalled = t.stalled || 0;
    const list = (data && Array.isArray(data.sessions) ? data.sessions : []).slice(0, 5);

    g.fillStyle = '#0d1117';
    g.fillRect(0, 0, 720, 450);
    g.fillStyle = '#ff4d00';
    g.fillRect(0, 0, 720, 4);

    g.fillStyle = '#e6edf3';
    g.font = '700 16px system-ui, sans-serif';
    g.fillText(L().pipHeader, 18, 32);

    g.fillStyle = '#9aa4af';
    g.font = '600 12px monospace';
    g.fillText(working + ' ' + L().working + ' · ' + waiting + ' ' + L().waiting + ' · ' + stalled + ' ' + L().stalledMany, 18, 56);

    if (!list.length) {
      g.fillStyle = '#9aa4af';
      g.font = '500 14px system-ui, sans-serif';
      g.fillText(L().emptyAllTitle, 230, 240);
      return;
    }

    list.forEach((s, idx) => {
      const y = 74 + idx * 68;
      const isStalled = s.state === 'stalled';
      const isWait = s.state === 'idle';
      g.fillStyle = isStalled ? '#291417' : isWait ? '#261f12' : '#161b22';
      g.fillRect(16, y, 688, 58);
      g.fillStyle = isStalled ? '#f85149' : isWait ? '#d29922' : '#3fb950';
      g.fillRect(16, y, 5, 58);
      g.fillStyle = '#e6edf3';
      g.font = '600 14px system-ui, sans-serif';
      g.fillText(String(s.title || s.id).slice(0, 44), 32, y + 24);
      g.fillStyle = isStalled ? '#f85149' : isWait ? '#d29922' : '#9aa4af';
      g.font = '500 12px monospace';
      const prof = s.profile_title || s.profile_label || s.profile || 'default';
      const act = activityText(s);
      g.fillText((prof + (s.tool ? ' · ' + s.tool : '') + (act ? ' · ' + act : '')).slice(0, 64), 32, y + 45);
    });
  }

  if (pipBtn) {
    pipBtn.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          pipBtn.classList.remove('on');
          pipBtn.setAttribute('aria-pressed', 'false');
          return;
        }
        if (!pipCanvas) {
          pipCanvas = document.createElement('canvas');
          pipCanvas.width = 720;
          pipCanvas.height = 450;
        }
        drawPipCanvas(latest || {});
        if (!pipVideo) {
          pipVideo = document.createElement('video');
          pipVideo.muted = true;
          pipVideo.playsInline = true;
          pipVideo.style.position = 'fixed';
          pipVideo.style.width = '1px';
          pipVideo.style.height = '1px';
          pipVideo.style.opacity = '0';
          pipVideo.style.pointerEvents = 'none';
          pipVideo.addEventListener('leavepictureinpicture', () => {
            pipBtn.classList.remove('on');
            pipBtn.setAttribute('aria-pressed', 'false');
          });
          document.body.appendChild(pipVideo);
        }
        if (!pipStream && typeof pipCanvas.captureStream === 'function') {
          pipStream = pipCanvas.captureStream(2);
          pipVideo.srcObject = pipStream;
        }
        await pipVideo.play();
        await pipVideo.requestPictureInPicture();
        pipBtn.classList.add('on');
        pipBtn.setAttribute('aria-pressed', 'true');
      } catch (_err) {
        pipBtn.classList.remove('on');
        pipBtn.setAttribute('aria-pressed', 'false');
      }
    });
  }

  async function tick() {
    try {
      const response = await fetch(LIVE_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      latest = await response.json();
      render();
    } catch (error) {
      statusEl.dataset.state = 'error';
      statusEl.textContent = L().offline + ' · ' + error.message;
    }
  }

  segsEl.addEventListener('click', event => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    segsEl.querySelectorAll('.seg').forEach(item => {
      item.classList.toggle('on', item === button);
    });
    render();
  });

  tick();
  setInterval(tick, REFRESH);
</script>
</body>
</html>
"""
