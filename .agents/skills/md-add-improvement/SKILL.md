---
name: md-add-improvement
description: Implement mdnest features/improvements from the backlog. Read the items in the mdnest brain (MyProjects/mdNest/Features), pick what to build, then implement them one by one — each on its own branch from develop, verified and merged straight into develop (no per-unit PR) — and finish with one clean release PR built on top of main. Say "/md-add-improvement". (Part of the md-* mdnest skill family alongside md-fix-bugs and md-ship.)
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

- **Clean commits — no attribution.** No `Co-Authored-By: Codex` / "Generated
  with Codex" footer on commits or PRs (intentional override of the global
  default).
- **No per-unit PRs — merge each into `develop` directly.** Branch `feat/<slug>`
  from the latest `develop`, verify, then `git merge --no-ff` into `develop` +
  push (no PR). The only PR is the final release. Sequential, not parallel
  (shared files like `App.css` / `mdnest` conflict otherwise).
- **Scope discipline.** Solve the actual improvement; don't over-engineer or
  reach outside mdnest's box (see `AGENTS.md` → "Scope discipline"). Confirm
  scope with the user when a feature is open-ended (offer options).
- **Verify before merging to develop.** `npm run build` + `npm test` (frontend),
  `bash -n mdnest` (CLI), and `tests/cli-smoke-test.sh` when CLI behavior changed.
  For visual/UI work, headless-screenshot a mock against the built CSS, or rebuild
  brain (`./mdnest-server rebuild`) so the user can eyeball it before release.

## Steps

1. **Read & agree.** `mdnest list .../Features` then `mdnest read` each. For each
   item, restate it, propose the smallest good approach, and (for anything
   open-ended) offer 2–3 options before building. Park anything not worth doing.
2. **Implement each unit** on `feat/<slug>` from the latest `develop`. Match the
   surrounding code style and the conventions in `AGENTS.md`.
3. **Verify** (build/test/smoke/visual as above). Don't merge red.
4. **Commit + merge into `develop` directly** (no PR; clean message, no
   attribution), then mark the item done in the brain — delete a single-feature
   note, or trim just the shipped bullet from a multi-item list.
5. **Repeat** for the next unit, strictly sequential.
6. **Release** exactly as in `md-fix-bugs` step 6 — build **one clean commit on
   top of `main`** (don't PR straight from develop, or it shows ~50 commits):
   union develop+main in a throwaway branch (`git merge -X ours origin/main`),
   reset a `release/vX.Y.Z` branch to `origin/main` and `git checkout` only the
   changed files onto it, bump version + CHANGELOG, commit once, open ONE PR →
   `main`. Squash-merge, tag, publish the GitHub Release, then reconcile
   `develop` (`git merge -s ours origin/main`). Optionally run `/md-ship`.

## Done criteria
- Every agreed item has a merged PR into `develop` and a green verification.
- Backlog notes updated (shipped items removed/trimmed).
- One release PR `develop` → `main` merged, version bumped, CHANGELOG + tag +
  GitHub Release published; `develop` reconciled with `main`.
- Commit history clean (no Codex attribution).
