---
name: md-add-improvement
description: Implement mdnest features/improvements from the backlog. Read the items in the mdnest brain (MyProjects/mdNest/Features), pick what to build, then implement them one by one — each on its own branch from develop, its own PR into develop, verified and merged — and finish with a single release PR develop→main. Say "/md-add-improvement". (Part of the md-* mdnest skill family alongside md-fix-bugs and md-ship.)
---

## Purpose

The feature/improvement counterpart to `md-fix-bugs`. Same disciplined flow, but
the backlog is enhancements rather than defects: read the items, agree what to
build (and how much), then ship each as its own clean PR into `develop`, and
finish with one release PR `develop` → `main`.

## mdnest brain locations (the backlog lives here, not in the repo)

- **Features / improvements (input):** `@srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/Features/`
- **TODOs (optional working notes):** `@srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/ToDos/`

Read with `mdnest read` / `mdnest list`. Some feature notes (e.g.
`SmallEnhancement.md`) are **lists of many items** — treat each bullet as its own
unit, and when one ships, trim just that bullet rather than deleting the file.

## Conventions (identical to md-fix-bugs)

- **Clean commits — no attribution.** No `Co-Authored-By: Claude` / "Generated
  with Claude Code" footer on commits or PRs (intentional override of the global
  default).
- **One PR per unit into `develop`.** Branch `feat/<slug>` from the latest
  `develop`, PR into `develop`, verify, merge, delete branch. Sequential, not
  parallel (shared files like `App.css` / `mdnest` conflict otherwise).
- **Scope discipline.** Solve the actual improvement; don't over-engineer or
  reach outside mdnest's box (see `CLAUDE.md` → "Scope discipline"). Confirm
  scope with the user when a feature is open-ended (offer options).
- **Verify before PR.** `npm run build` + `npm test` (frontend), `bash -n mdnest`
  (CLI), and `tests/cli-smoke-test.sh` when CLI behavior changed. For visual/UI
  work, headless-screenshot a mock against the built CSS, or rebuild brain
  (`./mdnest-server rebuild`) so the user can eyeball it before merge.

## Steps

1. **Read & agree.** `mdnest list .../Features` then `mdnest read` each. For each
   item, restate it, propose the smallest good approach, and (for anything
   open-ended) offer 2–3 options before building. Park anything not worth doing.
2. **Implement each unit** on `feat/<slug>` from the latest `develop`. Match the
   surrounding code style and the conventions in `CLAUDE.md`.
3. **Verify** (build/test/smoke/visual as above). Don't merge red.
4. **Commit / push / PR / merge** into `develop` (clean message, no attribution),
   then mark the item done in the brain — for a single-feature note delete it;
   for a multi-item list, trim just the shipped bullet.
5. **Repeat** for the next unit, strictly sequential.
6. **Release** exactly as in `md-fix-bugs` step 7: version bump + CHANGELOG,
   `release/vX.Y.Z` branch → squash PR into `main` (resolve squash-divergence
   with `git merge -X ours origin/main` if it conflicts), tag, publish the GitHub
   Release, then reconcile `develop` with `git merge -s ours origin/main`.
   Optionally run `/md-ship` for docs + website sync.

## Done criteria
- Every agreed item has a merged PR into `develop` and a green verification.
- Backlog notes updated (shipped items removed/trimmed).
- One release PR `develop` → `main` merged, version bumped, CHANGELOG + tag +
  GitHub Release published; `develop` reconciled with `main`.
- Commit history clean (no Claude attribution).
