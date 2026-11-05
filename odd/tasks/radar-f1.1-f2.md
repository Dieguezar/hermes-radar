# Radar — F1.1 corrections + F2 (Desktop half)

## Objective

Fix the three defects reproduced by the coordinator on the F1 delivery (D1 TDZ
crash in `/view`, D2 dishonest `stalled` classification, D3 `/view` visual
language) and ship F2: the Desktop half (`desktop/plugin.js`) as part of the
same unified package, with no install.

## Problem

- D1: `const URL` inside the page script shadows the global `URL` constructor
  during its own initializer (temporal dead zone). The script aborts with
  `ReferenceError`, `tick()` never paints, the status stays `connecting…`.
- D2: every session with `end_reason IS NULL` whose last activity fell outside
  the window was classified `stalled`. Old abandoned rows (October, Nov 3)
  showed as red "hung now". 6 of 8 rows were false positives.
- D3: the view is a minimal grid, not the product's visual language. It cannot
  be used as a demo screenshot.

## Scope

In: `dashboard/plugin_api.py` (state machine + `/view`), `tests/test_api.py`,
`desktop/plugin.js` (new), `plugin.yaml` / `dashboard/manifest.json` versions,
`README.md`, `PROGRESS.md`.

Out: installing under `/opt/data/plugins`, restarting gateway/dashboard, network
calls from the plugin, new dependencies, git history (this directory is not a
git repository, so ODD work-unit commits are unavailable; each milestone is
recorded in `PROGRESS.md` instead).

## Constraints

- Read-only SQLite access (`mode=ro` + `query_only`), bounded queries.
- No CDN, no build step, no decorative gradients in `/view`.
- F2 imports only `@hermes/plugin-sdk` and `react` (`react/jsx-runtime` for
  `jsx`; the SDK does not re-export `jsx` — documented deviation).
- No `document.querySelector` over app markup, no `eval`.
- Theme colors in F2 via the brief's variables with `--dt-*` runtime fallbacks
  (the Desktop publishes `--dt-card` / `--dt-border` / `--dt-foreground` /
  `--dt-muted-foreground`; the unprefixed names are not guaranteed to exist).

## Tasks

- [x] T1 — D1: rename `URL` to `LIVE_URL` in the generated page.
- [x] T2 — D2: new state machine (`running`, `queued`, `stalled`, `idle`,
      `dormant`, `done`, `failed`), `live`/`dormant` totals, dormant rows out of
      the visible list.
- [x] T3 — D2 tests: old open session → `dormant`; expired lease within 30 min
      → `stalled`; recent failure → `failed`; open row with a failing reason and
      no `ended_at` → `stalled`.
- [x] T4 — D3: rebuild `_VIEW_HTML` with the mockup language (dark surface,
      compact header + counters, dense cards, state colors, 360 px responsive).
- [x] T5 — F2: `desktop/plugin.js` with pane, status-bar chip, palette command,
      visibility-scoped 2 s polling, debounced event refresh, SDK-only render.
- [x] T6 — Docs and versions (`README.md`, `plugin.yaml`, `dashboard/manifest.json`).
- [x] T7 — Verification with evidence in `PROGRESS.md`: tests, `plugins doctor`,
      `plugins validate`, dev server + `/live` curl, headless Chromium DOM check.

## Route declaration

Single inline pass. The change set is one coherent unit — the backend state
machine, the page that renders it, and the Desktop consumer of the same payload
— and its only real proof is executing the page in a browser. A fresh-context
writer would have to re-derive the state machine and could not hand back the
browser evidence the brief requires, so the parent kept the write and the
verification together. No exploration delegation was needed: F1's files, the
mockup and the reference plugin were already small enough to read directly.

## Acceptance criteria

1. `/live?profiles=all&window=180` no longer reports abandoned sessions as
   `stalled`; `totals` separates `live`, `idle`, `dormant`, `sessions`.
2. `/view` renders cards in a real browser and never leaves `conectando…`.
3. `desktop/plugin.js` registers a pane, a status-bar chip and a palette
   command, polls only while visible, and renders through the SDK.
4. All checks in the brief pass with recorded evidence.

## Checks

- `/opt/hermes/.venv/bin/python tests/test_api.py`
- `/opt/hermes/bin/hermes plugins doctor .`
- `/opt/hermes/bin/hermes plugins validate .`
- dev server + `curl` on `/live`
- headless Chromium dump of `/view` (`--virtual-time-budget`) asserting cards
  and a non-connecting status.

## Progress / evidence

See `PROGRESS.md` (append-only, one line per milestone with UTC time).
