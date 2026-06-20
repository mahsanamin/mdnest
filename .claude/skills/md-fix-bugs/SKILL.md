---
name: md-fix-bugs
description: Fix the mdnest bug backlog. Read the bugs from the mdnest brain (MyProjects/mdNest/Bugs), judge what's real, then fix them one by one — each on its own branch from develop, its own PR into develop, verified and merged — and finish with a single release PR develop→main. Say "/md-fix-bugs". (Part of the md-* mdnest skill family alongside md-add-improvement and md-ship.)
---

## Purpose

A repeatable process for clearing the mdnest bug backlog. The bugs live in the
user's mdnest "brain" (their private notes). This skill reads them, decides which
are real and worth fixing, then fixes them **one by one** — each as its own clean
PR into `develop`, verified with the CLI smoke-test harness and merged — and
finally opens one release PR from `develop` to `main`.

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
- **One PR per fix into `develop`.** Each bug/fix gets its own short-lived branch
  (`fix/<slug>` for bugs, `feat/<slug>` for additive work) cut from the latest
  `develop`, its own PR into `develop`, then merge + delete the branch.
- **Branch flow:** feature → `develop` (per fix), and a single final release PR
  `develop` → `main` at the end. Never open the per-fix PRs against `main`.
- **Verify every change** by running the smoke-test harness before opening the
  PR (see step 4). Don't merge red.
- **Sequential, not parallel.** Branch each fix from `develop` only after the
  previous one merged, so the shared `mdnest` file never conflicts.

## Steps

### 1. Read & triage the bug backlog
- `mdnest list @srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/Bugs` then
  `mdnest read` each bug file.
- For each, judge: is it a real defect? Is it worth fixing now? State the verdict
  and a one-line reason. Skip/park anything that isn't actionable and say why.
- Confirm the branch flow with the user only if it's ambiguous; otherwise proceed
  with feature→develop, final→main.

### 2. Decompose into executable TODOs
- Break each accepted bug into one or more independently-shippable units (a unit
  = one cohesive PR). A single bug report with several requirements usually maps
  to several TODOs.
- Write one TODO file per unit into the ToDos folder with a clear title and:
  problem, goal, concrete changes (files + functions), acceptance criteria, and a
  copy-pasteable test. Use `mdnest append … -` with the content piped in.

### 3. Implement each unit (one branch / one PR)
- `git checkout develop && git pull --ff-only origin develop`
- `git checkout -b fix/<slug>`
- Make the change. Match surrounding code style. For the `mdnest` CLI: it runs
  under `set -e`, so any helper used as a bare statement must `return 0` on its
  success path or it will abort the script.

### 4. Verify with the smoke-test harness (gate)
- Run `tests/cli-smoke-test.sh` (it tests the working-tree `./mdnest` against the
  disposable `testing_workspace` namespace). If `testing_workspace` isn't
  mounted: add `MOUNT_testing_workspace=<path>` to `mdnest.conf`, create the dir,
  `./mdnest-server reload`, then run.
- All checks must pass. Add new checks to the harness when a fix introduces
  behavior the harness doesn't yet cover, and re-run.
- `bash -n mdnest` for a quick syntax gate on CLI edits.

### 5. Commit, push, PR, merge (clean)
- `git commit` with a clear subject + body. **No co-author / no generated-by
  footer.**
- `git push -u origin fix/<slug>`
- `gh pr create --base develop --head fix/<slug> --title "…" --body "…"` —
  describe problem, fix, and the harness result.
- `gh pr merge <n> --merge --delete-branch`
- `git checkout develop && git pull --ff-only origin develop`
- Mark the corresponding TODO done in the brain (`mdnest append` a `✅ DONE —
  merged to develop` line, or move it to a Done area).

### 6. Repeat for the next unit
- Back to step 3 with the next TODO. Keep it strictly sequential.

### 7. Final release PR (develop → main)
- Once every unit is merged into `develop`, run the full smoke test on `develop`
  one more time.
- Bump the version in all three files (`backend/handlers/config.go`,
  `frontend/package.json`, the `mdnest` CLI `MDNEST_CLI_VERSION`) and add a
  `CHANGELOG.md` section. Bug-fix-only cycle → patch bump; new CLI behavior →
  minor bump. (Often the version was already bumped by the first fix of the cycle
  — keep all three consistent; the pre-push hook enforces it.)
- Create a `release/vX.Y.Z` branch from `develop` and open one PR → `main`
  summarizing every fix (clean body, no attribution).
- **`main` requires SQUASH merges** (its history is one "Release vX.Y.Z" commit
  per release) — merge the release PR with `gh pr merge <n> --squash`, not a
  merge commit.
- **Squash-divergence gotcha:** because past releases were squash-merged, `main`
  has commits not in `develop`'s history, so the release PR can show CONFLICTING.
  Fix it on the release branch with `git merge -X ours origin/main` before/again
  after opening the PR (`develop` is a content superset of `main`, so `-X ours`
  is safe). CI only runs once the PR is mergeable.
- After merge: `git tag vX.Y.Z && git push origin vX.Y.Z`, then **publish a GitHub
  Release** (`gh release create vX.Y.Z --notes-file <changelog section>`) — the
  in-app update banner only notices Releases, not bare tags.
- **Then reconcile so the NEXT release is clean:** `git checkout develop &&
  git merge -s ours origin/main && git push` — records `main`'s release commit as
  an ancestor of `develop` (content-neutral) so the next release PR doesn't
  conflict.
- See the "Release Process" section of `CLAUDE.md`. Optionally run `/md-ship`
  to sync docs + website as part of the release.

## Done criteria
- Every actionable bug has a TODO, a merged PR into `develop`, and a green
  harness run.
- TODOs are marked done in the brain.
- One release PR from `develop` → `main` is open/merged, version bumped,
  CHANGELOG updated, tag + GitHub Release published.
- Commit history is clean (no Claude attribution).
