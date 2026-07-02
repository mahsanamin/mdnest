---
name: md-fix-bugs
description: Fix the mdnest bug backlog. Read the bugs from the mdnest brain (MyProjects/mdNest/Bugs), judge what's actually a bug (some are already fixed), then fix them one by one — each on its own branch from develop, verified and merged STRAIGHT into develop (no per-bug PR) — and finish with one clean release PR built on top of main. Say "/md-fix-bugs". (Part of the md-* mdnest skill family alongside md-add-improvement and md-ship.)
---

## Purpose

A repeatable process for clearing the mdnest bug backlog. The bugs live in the
user's mdnest "brain" (their private notes). This skill reads them, decides which
are **really** bugs (some logged ones are already fixed — verify first), then
fixes them **one by one** — each on its own branch, verified with the CLI
smoke-test harness and merged **straight into `develop`** (no per-bug PR) — and
finally opens **one** clean release PR, built on top of `main`.

Run it whenever the user points you at the bug folder. (Sibling skill:
`md-add-improvement` does the same for the `Features/` backlog.)

## mdnest brain locations (the backlog lives here, not in the repo)

- **Bugs (input):** `@srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/Bugs/`
- **TODOs (output):** `@srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/ToDos/`
- **In progress (optional):** `@srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/InProgress/`

Use the `mdnest` CLI to read/write these (`mdnest read`, `mdnest list`,
`mdnest search`). Run `mdnest servers -v` first if the alias/namespace has
changed. **Gotcha:** the *installed* `mdnest` CLI self-updates from `main`, so it
can lag the fixes you just merged to `develop`. When writing TODO/notes into the
brain, prefer `mdnest append … -` (creates if missing, supports stdin) — it's the
safe path regardless of which CLI version is installed. Bugs are sometimes logged
against the stale installed CLI; before re-fixing, check whether the current
repo code already fixes it (then just verify + mark resolved).

## Critical conventions (read before committing anything)

- **Clean commits — no attribution.** Do NOT add a `Co-Authored-By: Claude …`
  trailer or any "Generated with Claude Code" footer to commits or PR bodies for
  this project. The user wants the history clean. (This intentionally overrides
  the global default commit/PR footer.)
- **No per-bug PRs — merge each fix straight into `develop`.** Each bug gets its
  own short-lived branch (`fix/<slug>`) cut from the latest `develop`; once it's
  verified, merge it **directly into `develop`** (`git merge --no-ff` + push,
  no PR) and delete the branch. The ONLY PR in the whole cycle is the final
  release PR (`main` ← the release branch). Opening a PR per bug just adds noise.
- **Verify every change before merging to develop** — run the smoke-test harness
  (and `npm run build`/`npm test` for frontend changes). Don't merge red.
- **Sequential, not parallel.** Branch each fix from `develop` only after the
  previous one merged, so shared files (`mdnest`, `App.css`) never conflict.

## Steps

### 1. Read & triage the bug backlog
- `mdnest list @srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/Bugs` then
  `mdnest read` each bug file.
- For each, judge: **is it really a bug**, and worth fixing now? State the verdict
  and a one-line reason. Park anything that isn't actionable and say why.
- **Check whether it's already fixed.** Bugs are often logged against the stale
  *installed* CLI (which self-updates from `main`); the current repo code may
  already fix it. If so, verify + mark it resolved — don't re-fix.
- `git fetch origin` and note `main`'s current version — `main` may be **ahead**
  of `develop` from parallel work (e.g. a docs PR), which affects the release
  version number later.

### 2. Fix each bug (one branch, no PR)
- `git checkout develop && git pull --ff-only origin develop`
- `git checkout -b fix/<slug>`
- Make the change. Match surrounding code style. Gotchas:
  - The `mdnest` CLI runs under `set -e` — any helper used as a bare statement
    must `return 0` on its success path or it aborts the script.
  - Reproduce the bug first (against the `testing_workspace` namespace) so you're
    fixing the real thing, not the report's guess. Several past "bugs" were CLI
    path-handling, not backend.
- (Optional) For a multi-step fix, jot a quick TODO in the brain
  `MyProjects/mdNest/ToDos` with `mdnest append … -`. Not required for small fixes.

### 3. Verify (gate — don't merge red)
- **Add a regression test to the layer that would have caught the bug** — this is
  part of the fix, not optional: a CLI-behaviour bug → a `tests/cli-smoke-test.sh`
  assertion; a parser/fallback bug (e.g. anything that must work without
  `python3`) → a `tests/cli-unit.sh` case; a UI bug → a `tests/browser` spec.
- Run the tier that matches the change:
  - CLI/pure helpers: `bash tests/cli-unit.sh` (instant; runs with AND without
    python3) + `bash -n mdnest`.
  - CLI end-to-end: `tests/cli-smoke-test.sh` against the disposable
    `testing_workspace` (mount via `MOUNT_testing_workspace=<path>` +
    `./mdnest-server reload` if missing), or the full `bash tests/e2e-docker.sh`
    (builds the backend, boots a throwaway instance, runs the CLI on the host and
    in a bare no-python3 container).
  - Frontend/UI: `npm run build` + `npm test`, and `bash tests/e2e-browser.sh`
    (full stack + Playwright) for user-facing flows.
- The pre-push hook runs the fast tier on every push and the full Docker + browser
  suites when pushing a `release/*` branch — so the release PR can't go up red.
  Don't skip it (`MDNEST_SKIP_E2E=1`) except in a real emergency.

### 4. Merge straight into develop (NO per-bug PR)
- `git commit` — clear subject + body, **no co-author / generated-by footer**.
- `git checkout develop && git pull --ff-only origin develop`
- `git merge --no-ff fix/<slug> -m "Merge fix/<slug> into develop"`
- `git push origin develop` and `git branch -d fix/<slug>`.
- **Delete the bug's file** from the brain `Bugs/` folder
  (`mdnest delete @srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/Bugs/<file>.md`)
  once it's merged to develop — a fixed bug left in the folder gets re-read and
  re-picked next cycle. The fix is recorded in git + the CHANGELOG; the backlog
  file's job is done. (Same for a bug found to be already-fixed in step 1.)
  Per-bug PRs are deliberately skipped — the only PR is the release.

### 5. Repeat for the next bug
- Back to step 2 with the next one. Keep it strictly sequential.

### 6. Release: ONE clean PR on top of main
Run the full smoke test on `develop` once more, then build the release as a
**single commit on top of current `main`** — NOT a develop-based branch. A
develop-based PR lists every individual commit that `main` only has as squashed
releases (~50 of them), which looks alarming even though the file diff is tiny.
Two phases:

**A. Get the correct content (union of develop + main), in a throwaway branch:**
```
git fetch origin
git checkout -b _rel-tmp develop
git merge -X ours origin/main -m "merge main"
```
`develop` is a content superset of `main`, so `-X ours` keeps our fixes and
pulls in any **main-only** work (e.g. a separate README/docs PR merged while you
were fixing) without clobbering it. Sanity-check: `git diff _rel-tmp origin/main`
for any main-only paths should be empty.

**B. Collapse to one commit ON main so the PR is clean:**
```
FILES=$(git diff origin/main.._rel-tmp --name-only)        # only the net-new changes
git checkout -B release/vX.Y.Z origin/main
git checkout _rel-tmp -- $FILES
git branch -D _rel-tmp
```
Then set the version in all three files (`backend/handlers/config.go`,
`frontend/package.json`, `mdnest`’s `MDNEST_CLI_VERSION`) to the **plain release
number `X.Y.Z`** — the next bump above **`main`'s** current version (main may be
ahead of develop from parallel work; don't trust develop's number). Note develop
carries `X.Y.Z-dev`; the release branch **drops the `-dev` suffix**. Add the
`CHANGELOG.md` section, and commit it all as **one** `Release vX.Y.Z` commit.

> **Version scheme.** `develop` always carries the in-flight version with a
> `-dev` suffix (e.g. `3.11.3-dev`) so a develop/staging box reads
> `v3.11.3-dev` (clearly "candidate, still validating") while production reads
> the plain `v3.11.3`. The release branch drops `-dev`. **After the release
> merges**, bump develop to the *next* `-dev` (e.g. `3.11.4-dev`) so develop is
> immediately ahead again. `isVersionNewer` is pre-release-aware, so a `-dev`
> build shows no false "update available" against the last release but does see
> the final release as newer once it ships.

Verify (build/test/smoke), `git push -u origin release/vX.Y.Z`, and open ONE PR
→ `main`. Because the base IS `main`, it's a 1-commit, small-diff, conflict-free
PR (this is the fix for the "why so many commits" problem).

**After the user approves / merges:**
- `gh pr merge <n> --squash` (main only allows squash merges).
- `git tag vX.Y.Z && git push origin vX.Y.Z`, then **publish a GitHub Release**
  (`gh release create vX.Y.Z --notes-file <changelog section>`) — the in-app
  update banner only notices Releases, not bare tags.
- **Reconcile develop + open the next `-dev`:** `git checkout develop &&
  git merge -s ours origin/main` (records main's release commit as an ancestor of
  develop, content-neutral), then bump develop's three version files to the next
  pre-release (`X.Y.(Z+1)-dev`) and push. develop is now ahead of the release
  again.
- Optionally run `/md-ship` to sync docs + website.

See the "Release Process" section of `CLAUDE.md`.

## Done criteria
- Every actionable bug is fixed, verified (green harness + a regression check),
  and merged straight into `develop`; already-fixed ones are marked resolved.
- The brain bug notes are marked ✅ RESOLVED.
- **One** clean release PR (a single commit on top of `main`, small diff) is
  open/merged, version bumped, CHANGELOG updated, tag + GitHub Release published,
  and `develop` reconciled with `main`.
- No per-bug PRs. Commit history clean (no Claude attribution).
