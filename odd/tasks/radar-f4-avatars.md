# Radar F4 — real bot avatars

## Objective

Every row of the floating panel and every card of `/view` renders the profile's
real avatar (photo first, vector fallback) instead of a generic initial, and the
profile badge shows the bot's display title.

## Context

- F3 shipped `v0.3.0` and a final reviewer verdict of "listo".
- Each profile keeps its appearance in `profile.yaml` under
  `ui_meta['hermes-bots']` (`shape`, `color`, `title`, `imageKind`) and its
  raster avatar in `assets/avatar.png` (`$HERMES_HOME/assets/avatar.png` for the
  root profile). The Bots roster paints exactly that PNG.
- Hermes ships `hermes_yaml` (no PyYAML in the venv); the plugin must not add a
  dependency.
- The checkout is not a git repository, so ODD work-unit commits are not
  available; evidence lives in `PROGRESS.md`.

## Scope

- `dashboard/plugin_api.py`: per-profile appearance cache, `/live` fields,
  `GET /avatar/{profile}`, `/view` embedded avatar map.
- `desktop/plugin.js`: module-level avatar cache, lazy per-profile request,
  `<img>` rendering, title badge.
- `tests/test_api.py`, `tests/desktop_behaviour.test.mjs`.
- `README.md`, `PROGRESS.md`, `docs/view-*.png`.

## Tasks

- [x] T1 — Feature doc created; baseline `tests/test_api.py` 30/30 PASS.
- [x] T2 — RED: backend tests for `/avatar`, traversal rejection, `/live`
      `profile_title`/`avatar.has_image`, then GREEN.
- [x] T3 — RED: `/view` embeds PNG data URLs and the title badge; then GREEN.
- [x] T4 — Panel `Avatar` with module cache + one request per profile; badge
      shows `profile_title`.
- [x] T5 — Verification: tests, `plugins validate`, devserver curls, Chromium
      dark + light captures and a DOM check for `img[src^="data:image/png"]`.
- [x] T6 — README/PROGRESS updated.

## Acceptance criteria

1. `/avatar/<discovered>` → `data:image/png;base64,...` with a real PNG signature.
2. Traversal/unknown/empty selectors → 400/404, never a path outside `assets/`.
3. `/live` carries `profile_title` and `avatar.{has_image,shape,color}`; a
   profile without a PNG reports `has_image: false`.
4. `/view` renders `<img>` data URLs and still degrades to the vector fallback.
5. Panel requests each avatar at most once per mounted panel and never blocks
   the list.
6. No install under `/opt/data/plugins`, no gateway restart, no `pip install`.

## Test-first policy

Behaviour lives in stdlib-testable pure functions and in the Node harness; a
runnable RED exists for each backend and panel behaviour before implementation.
