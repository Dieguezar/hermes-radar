# Radar F7 — list finished sessions in the panel

## Objective

The desktop panel showed only live rows (`running`, `stalled`, `queued`, `idle`) while the
backend already returned and ordered `done` / `failed`. List terminal sessions too, without
letting them compete visually with a hung turn.

## Problem

`desktop/plugin.js` filtered the payload with `LISTED_STATES` and ordered rows with a
`STATE_ORDER` that stopped at `idle`. A session that just finished vanished from the panel
even though `/live` carried it with `ended_at` inside the window.

## Scope

- `desktop/plugin.js` — listed states, panel order, terminal row treatment, footer counters.
- `tests/desktop_behaviour.test.mjs` — terminal row behaviour and footer order.
- `tests/test_api.py` — version assertion reads `dashboard/manifest.json` instead of a pinned
  literal (this was the pre-existing 41/42 failure; `plugin.yaml` shipped 0.4.1 while the test
  still expected 0.4.0).
- `plugin.yaml`, `dashboard/manifest.json`, `desktop/plugin.js` — version 0.4.2.

## Constraints

- Backend logic untouched (`dashboard/plugin_api.py` keeps its own `_STATE_ORDER`).
- No `pip install`, no writes under `/opt/data/plugins`, no gateway/dashboard restart.
- `/view` capture not required: it already lists terminal sessions.

## Tasks

- [x] T1 — `LISTED_STATES` → `running, stalled, queued, idle, done, failed`; `STATE_ORDER` gains
      `done: 4`, `failed: 5` (mirrors the backend).
- [x] T2 — Terminal rows paint at `opacity: 0.72`, never render the stop control (`canStop`
      requires a non-terminal state even if `can_interrupt` were true), and use `✓` in the
      dimmed green ink for `done` / `✕` in the dimmed red ink for `failed`.
- [x] T3 — Footer reads `N live · M terminadas · K inactivas`, in that order, printing the
      finished and dormant segments only when they are non-zero.
- [x] T4 — Version 0.4.2 on `plugin.yaml`, `dashboard/manifest.json` and the plugin's `VERSION`.
- [x] T5 — Panel tests: `done` lists after every active state, `failed` too, neither offers a
      stop, both keep the glyph, active rows keep full opacity plus the stop, footer order.
- [x] T6 — Verification: backend suite, panel harness, `hermes plugins validate .`.

## Verification

| Check | Result |
| --- | --- |
| `node tests/desktop_behaviour.test.mjs` against the pre-change `plugin.js` | 21/25 — the four changed-behaviour tests fail (RED observed) |
| `/opt/hermes/.venv/bin/python tests/test_api.py` | 42/42 passed |
| `node tests/desktop_behaviour.test.mjs` | 25/25 passed (20 existing + 5 new) |
| `/opt/hermes/bin/hermes plugins validate .` | passed, 0 failures / 0 warnings |

## Route

Delegated direct not required: one already-understood file carried the behaviour change
(`desktop/plugin.js`, 62 changed lines) plus tests and two version literals. No mapping or
research was needed, so the writer trigger never fired.

## Out of scope / not exercised

The floating pane inside the real Desktop shell (not installed in this container); evidence is
the Node harness over the real module body plus the backend suite.
