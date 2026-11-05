# Radar — F2 final (v2 brief, verified research)

## Objective

Ship the complete Radar package: the floating Desktop pane
(`desktop/plugin.js`, the product's primary surface), the backend additions the
pane needs (`execution_generation`, honest SQLite fallbacks), the web mirror
`/view`, a truthful `plugin.yaml` disclosure, and a README a reviewer can read
without asking a question.

## Why

F1 shipped the backend and `/view`; `desktop/plugin.js` does not exist yet, so
the product has no live panel. The hackathon catalog submission needs the panel
the mockup shows, plus a manifest whose disclosure matches what the code
actually does.

## Verified inputs (do not re-investigate)

1. `placement: 'floating'` is real in the renderer: no track, no tab, an
   `anchor`, `width`/`height`, and app-drawn drag + collapse chrome.
2. `host.paneVisibility('radar')` is always `false` for a floating pane. The
   pane must not gate refresh on it; without `lifecycleKeepAlive` the body
   unmounts on collapse, which kills the component interval by construction.
3. Opening a session is `host.openSession(storedSessionId)`, not
   `session.activate`.
4. Interrupting is `host.request('session.interrupt', { session_id })`;
   `execution_generation` is optional in the handler, and `stale_generation`
   means retry once with the generation `/live` reports.
5. SQLite opens with a 5.0 s timeout. If opening fails and no `-wal` sidecar
   exists next to the file, retry with `?mode=ro&immutable=1`. On Windows, when
   sidecars from another process exist, `?mode=ro&readonly_shm=1` is the
   fallback. A profile failure is recorded in `profile_errors`, never fatal.
6. `plugin.yaml` must stop claiming "read-only" while promising stops; declare
   `platforms: [linux, windows]`, `requires_hermes: ">=0.22"`, no
   `capabilities`, and empty `provides_tools` / `provides_hooks`.

## Scope

In: `dashboard/plugin_api.py`, `tests/test_api.py`, `desktop/plugin.js` (new),
`plugin.yaml`, `dashboard/manifest.json`, `README.md`, `PROGRESS.md`.

Out: installing under `/opt/data/plugins`, restarting gateway/dashboard,
network calls from the plugin, new Python dependencies, git history (this
directory is not a git repository, so work-unit commits are unavailable; each
milestone is recorded in `PROGRESS.md`).

## Constraints

- Read-only SQLite (`mode=ro` + `query_only`); bounded queries; no writes.
- `broadcast_plugin_event` at most once every 2 s.
- Desktop half imports only `@hermes/plugin-sdk` and `react` /
  `react/jsx-runtime`; no `eval`, no app-markup queries, no script injection.
- No `lifecycleKeepAlive` on the floating pane.
- Theme colors read the brief's variables with the published Desktop tokens as
  fallbacks: `var(--foreground, var(--dt-foreground))`,
  `var(--card, var(--dt-card))`, `var(--border, var(--dt-border))`,
  `var(--muted-foreground, var(--dt-muted-foreground))`. The unprefixed names
  are not guaranteed outside the app's base layer; `--dt-*` is what
  `applyTheme()` publishes.
- Orange `#FF4D00` only for the live dot and the stop button.

## Tasks

- [x] T1 — Backend: `execution_generation` from `sessions.runtime_generation`
      (`None` when the column is absent), 5.0 s open timeout, candidate-URI
      fallbacks, 2 s broadcast floor.
- [x] T2 — Tests: SQLite candidate/fallback, `can_interrupt`, corrupt profile
      isolation, `execution_generation` present/absent, platforms, interval
      floor. Existing suite stays green.
- [x] T3 — `desktop/plugin.js`: floating 320×214 pane, four-state rows, avatars,
      two-step stop with `stale_generation` retry, 2 s `ctx.rest` poll,
      debounced `plugin.radar.changed`, offline footer.
- [x] T4 — `plugin.yaml` + `dashboard/manifest.json`: truthful disclosure,
      `[linux, windows]`, `>=0.22`, version 0.3.0.
- [x] T5 — `README.md`: what it does, screenshot, install (catalog, Git, manual),
      states, `/live`, disclosure, limits, Windows/Linux, requirements.
- [x] T6 — `/view` headless Chromium DOM check (no stuck “conectando…”).
- [x] T7 — Full verification with evidence in `PROGRESS.md`; devserver stopped.

## Route declaration

Two sequential units, one writer at a time:

- T1–T2 delegated to one bounded writer (`dashboard/plugin_api.py`,
  `tests/test_api.py`). Trigger: two non-trivial files plus test-first proof.
- T3–T7 inline. Trigger exception: the Desktop half is the one artifact whose
  correctness depends on the SDK surface verified in this session (floating
  adoption, collapse unmount, `openSession`, `requestProfile` routing); a
  fresh writer would have to re-derive it and could not hand back the
  browser/CLI evidence the brief requires in one pass. Docs are mechanical.

## Acceptance criteria

1. `desktop/plugin.js` registers the floating pane and satisfies the brief's
   content, interaction and styling rules.
2. `/live` carries `can_interrupt` and `execution_generation`, orders by state
   then elapsed, survives an unreadable profile, and opens with the documented
   fallbacks.
3. `/view` renders in a real browser and leaves “conectando…” once data lands.
4. `plugin.yaml` disclosure, platforms and requirements match the brief.
5. Every command in the brief's verification block passes with recorded
   evidence; the devserver is stopped afterwards.

## Checks

- `/opt/hermes/.venv/bin/python tests/test_api.py`
- `/opt/hermes/bin/hermes plugins doctor .`
- `/opt/hermes/bin/hermes plugins validate .`
- devserver on 8791 + `curl` `/live` and `/view`
- `node --check desktop/plugin.js` + import audit
- headless Chromium DOM dump of `/view`

## Progress / evidence

See `PROGRESS.md` (append-only, one line per milestone with UTC time).
