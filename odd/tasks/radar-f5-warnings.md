# Radar F5 — zero `plugins validate` warnings

## Objective

Leave `hermes plugins validate .` with **0 failures and 0 warnings** while keeping the
existing behaviour: real profile avatars, `/live` metadata, `/view` rendering and the
desktop panel.

## Problem

Two advisory findings remain after F4:

1. Catalog rule 9 (`private core imports`): `dashboard/plugin_api.py` imports
   `hermes_yaml.safe_load`, a private Hermes core module.
2. Security scan `system_passwd_access`: `PROGRESS.md:45` spells a literal traversal
   path used during the F4 HTTP checks.

Both are read by the catalog reviewer, so both must disappear without weakening the
feature.

## Scope

- `dashboard/plugin_api.py` — replace the YAML dependency with a bounded stdlib reader;
  expose `imageKind`; 30 px avatars; 9 px title separation.
- `desktop/plugin.js` — 30 px avatar, 9 px separation, 22 % radius for photo profiles.
- `tests/test_api.py` — five `_read_bot_meta` cases plus avatar-size/`imageKind` checks.
- `tests/desktop_behaviour.test.mjs` — 30 px and photo-fallback assertions.
- `PROGRESS.md` — rewrite the traversal line without the sensitive path.

## Constraints

- No `pip install`; no writes under `/opt/data/plugins`; no gateway/dashboard restart.
- No writes outside the repo except `/tmp`.
- The traversal test may keep its literals; documentation may not.
- This checkout is not a git repository, so work-unit commits are unavailable and the
  evidence lives in `PROGRESS.md`.

## Tasks

- [x] T1 — Add `_read_bot_meta(profile_dir)` (level-0 `ui_meta:`, level-2 `hermes-bots:`,
      level-4 pairs; never raises; missing/corrupt/tabbed file → `{}`) and a minimal
      level-0 `display_name` reader; drop the `hermes_yaml` import.
- [x] T2 — Tests for T1: normal block, `hermes-bots: {}`, missing `profile.yaml`,
      comments, empty `title`.
- [x] T3 — Rewrite `PROGRESS.md:45` without the literal path; confirm no other sensitive
      absolute path survives documentation.
- [x] T4 — Avatar polish: 30 px in `/view` and the panel, 9 px separation, 22 % radius
      when `imageKind` is `photo` or a `data_url` exists, silhouette otherwise.
- [x] T5 — Full verification: tests, `plugins validate` (no warnings), `plugins doctor`,
      devserver `/live` + `/avatar/maca`, dark/light captures, DOM 30×30 check, stop the
      devserver.

## Acceptance criteria

- `hermes plugins validate .` prints no `⚠` line.
- `tests/test_api.py` green, desktop harness green.
- `/live` still carries `profile_title` and `avatar`; `/avatar/maca` returns a PNG.
- `docs/view-dark.png` and `docs/view-light.png` regenerated from a real render that
  contains a 30×30 `data:image/png` `<img>`.
- `PROGRESS.md` records one line per milestone, with no sensitive path.

## Verification commands

```bash
/opt/hermes/.venv/bin/python tests/test_api.py
/opt/hermes/bin/hermes plugins validate .
/opt/hermes/bin/hermes plugins doctor .
```

## Evidence

- `_read_bot_meta` plus `_read_top_level_value` replace the `hermes_yaml` import; six
  parser tests cover the brief's five cases plus a tabbed file.
- `tests/test_api.py` 41/41 (from 35/35), Node harness 20/20.
- `hermes plugins validate .` → 0 failures, 0 warnings, `security scan — safe`.
- `hermes plugins doctor .` → OK.
- `/live` keeps `profile_title` + `avatar.image_kind`; `/avatar/maca` 200 PNG.
- Headless DOM: 25 PNG `<img>` elements at 30×30 in `.av.av-image` spans.
- `docs/view-dark.png` / `docs/view-light.png` regenerated at 1200×760.
- Devserver stopped; nothing installed outside the repo.
