# Radar — rename from the previous plugin name

## Objective

Rename the plugin to `radar` / "Radar" without changing behaviour: same
backend, same panel logic, same payload.

## Scope

- `plugin.yaml`, `dashboard/manifest.json`: identity, homepage, description, version 0.4.0.
- `dashboard/plugin_api.py`: `PLUGIN_ID`, watcher thread name, `/view` title, mark, heading, env-var prefix.
- `desktop/plugin.js`: plugin id/name, registered pane id/title, event name, component name.
- `tools/devserver.py`: mount prefix, title.
- Tests: expectations for id, event and title.
- `README.md`, `PROGRESS.md`, historical `odd/tasks/*` references.
- `docs/*.png`: regenerate because the page title is in the capture.

## Constraints

- No logic changes. No `pip install`, no writes outside the repo, no gateway restart.
- The checkout directory keeps its current name; the coordinator renames it later.

## Route

Direct inline: mechanical, already-understood substitutions after an inline
occurrence map (`grep` over the whole tree). No new behaviour to design.

## Tasks

- [x] 1. Rename manifest identity (yaml + dashboard manifest).
- [x] 2. Rename backend identity (id, watcher name, HTML title/mark/heading, env vars).
- [x] 3. Rename desktop half (id, name, pane id/title, event, component).
- [x] 4. Rename dev harness prefix and test expectations.
- [x] 5. Update live documentation and historical task docs.
- [x] 6. Run tests, `plugins validate`, and the devserver HTTP checks.
- [x] 7. Regenerate `docs/*.png` and record evidence in `PROGRESS.md`.

## Acceptance criteria

- The old identifier appears only in `PROGRESS.md` dated entries.
- `tests/test_api.py` all PASS.
- `hermes plugins validate .` 0 failures, 0 warnings.
- `/api/plugins/radar/view` 200 with "Radar" in the DOM; the old prefix returns 404.
