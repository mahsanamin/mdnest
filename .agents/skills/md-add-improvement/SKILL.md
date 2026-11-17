---
name: md-add-improvement
description: Add a feature or improvement to mdnest the disciplined way, for anyone working on the repo. Agree the scope, build it on its own branch from develop, verify it with the right test level, then hand it in (a contributor opens a PR into develop; the maintainer merges into develop directly and later releases). The input can be a description from the user, a GitHub issue, or the maintainer's private Features backlog. Say "/md-add-improvement", or ask in your own words ("add X", "build this feature", "improve Y"). (Part of the md-* mdnest skill family alongside md-fix-bugs, md-issue-process and md-ship.)
---

## Purpose

The feature counterpart to `md-fix-bugs`: agree what to build and how much,
build each unit on its own branch from `develop`, verify it, and hand it in.

## First: contributor or maintainer?

- **Contributor** (anyone working from a fork, the usual case): the input is what
  the user describes or a GitHub issue. You finish by opening a pull request
  into `develop`. Skip every step marked *maintainer*.
- **Maintainer** (the repo owner, with access to the private notes server
  `@srv-ahsan-mini/...`): the steps marked *maintainer* apply as well.

If you cannot tell, you are a contributor.

## Where the work comes from

- The user's description, or a GitHub issue (`gh issue view <n>`).
- *Maintainer:* the backlog in
  `@srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/Features/`, read with
  `mdnest list` / `mdnest read`. Some notes (e.g. `SmallEnhancement.md`) list many
  items: treat each bullet as its own unit.

## Rules

- **Read `AGENTS.md`** at the root, and the `AGENTS.md` of every folder you will
  touch, before writing code. Check `docs/codemap.md` for the files you change.
- **Scope.** Build the actual improvement, nothing more. For anything
  open-ended, offer the user 2 or 3 options before building.
- **Off by default.** A feature that changes how an existing install behaves is
  off by default behind a flag, adds no required dependency, and removes nothing
  users rely on. A change to what mdnest is (files as source of truth, namespaces
  from mounts, no database in single mode) needs the maintainer's agreement
  first: open an issue to discuss it before coding.
- **One branch per unit**, `feat/<slug>` from the latest `develop`. Units go one
  after another, not in parallel: shared files (`App.jsx`, `App.css`, `mdnest`)
  conflict otherwise.
- **Commits:** clear messages, no AI co-author trailer or "Generated with" footer.
- **Do not** bump versions, write a release section in `CHANGELOG.md`, tag or
  release. That is the maintainer's release step.

## Steps

1. **Agree the scope.** Restate the item, propose the smallest good approach, and
   for anything open-ended offer options. Park what is not worth doing.
2. **Branch:** `git fetch origin && git switch -c feat/<slug> origin/develop`
   (in a fork, fetch `develop` from the upstream remote).
3. **Build it.** Match the surrounding style and the folder's `AGENTS.md`. Add
   tests for the new behavior (`tests/AGENTS.md` says which kind). Update user
   docs in `docs/` when behavior changes, and `docs/codemap.md` when you add or
   move a file.
4. **Verify.**
   - While working: `bash tests/check.sh --level iterate`, with the feature's
     browser specs in `MDNEST_E2E_SPECS` (add `MDNEST_E2E_HARNESS=collab` for
     two-user specs), plus `tests/cli-smoke-test.sh` if CLI behavior changed.
   - Before handing in: `bash tests/check.sh --level develop` once (15 to 20
     min). It picks the end-to-end suites from the files you changed.
   - For visual work, take a screenshot so the user can see it.
   - If a suite cannot run on this machine (no Docker, for example), say which
     one in the PR. Do not report it as passed. Do not hand in red.
5. **Hand it in.**
   - *Contributor:* push the branch to your fork and open a PR with base
     `develop` (not `main`): `gh pr create --base develop`. In the body say what
     changed, why, how it is switched on, and which test levels ran.
   - *Maintainer:* `git merge --no-ff` the branch into `develop` and push, then
     mark the item done in the backlog (delete a single-feature note, or trim the
     shipped bullet from a list).
6. **Next unit**, if there is one: back to step 1.
7. *Maintainer, release:* only after `md-ship` Step 0 (the ship gate) holds; a
   feature soaks on the dev stack for at least a day. Then follow `md-fix-bugs`
   step 6 and `md-ship`: one clean release commit on top of `main`, one PR,
   tag, GitHub Release, reconcile `develop`. Details: `docs/dev/release.md`.

## Done

- Contributor: a PR into `develop` per unit, with tests, and the test levels that
  ran named in the PR.
- Maintainer: each unit merged into `develop` with green verification, backlog
  updated, and (when releasing) the release shipped per `md-ship`.
