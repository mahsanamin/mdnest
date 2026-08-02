---
name: md-ship
description: After implementing a feature or fix in mdnest, run this to update CHANGELOG, docs, website, bump version, sync, and rebuild the local dev stack. Say "/md-ship" after completing any code change. (Part of the md-* mdnest skill family alongside md-fix-bugs and md-add-improvement.)
---

## Purpose

Automate the post-implementation checklist for mdnest: update all documentation, sync to the website repo, rebuild the local dev stack so changes are runnable. Run this after every feature or fix is code-complete.

## Conventions

- All paths in this skill are relative to the repo root unless absolutely required to be absolute.
- Resolve the repo root with `git rev-parse --show-toplevel` (or just `pwd` if Claude Code was started in the repo).
- The website repo is expected as a sibling directory at `../mdnest-website` relative to this repo. If that path doesn't exist, skip the website-sync steps and tell the user.
- The local dev stack lives in this repo and is started/rebuilt via `./mdnest-server rebuild` (uses `COMPOSE_PROJECT_NAME` from `mdnest.conf` to pick a compose project name — see `mdnest.conf.sample`).

## Steps

### 1. CHANGELOG.md
Add the change to the current version section at the top. If the latest version is already shipped (tagged + pushed), create a new patch / minor section above it, matching the existing format (bold feature name + description). Don't append new entries to a tagged release.

### 2. Version bump (only if a new version section was created)
Bump all three in lockstep:
- `backend/handlers/config.go` — `"version": "X.Y.Z"`
- `frontend/package.json` — `"version": "X.Y.Z"`
- `mdnest` CLI — `MDNEST_CLI_VERSION="X.Y.Z"`

The pre-push hook (`.githooks/pre-push`) verifies these match — if any disagrees the push is blocked.

### 3. README.md
Only touch the "Why mdnest?" section if this is a major user-visible feature. Bug fixes and internal changes don't belong on the README.

### 4. CLAUDE.md
- New files in the project tree → add them to the structure block in the appropriate section.
- New conventions, patterns, gotchas → add to the Conventions section.

### 5. docs/
Match the change to the right doc:
- New end-user feature → `docs/user-guide.md`
- Architecture change (handler / store / package added; data model change) → `docs/architecture.md`
- New API endpoint or behaviour → `docs/api.md`
- New config option / env var → `docs/setup.md`
- New CLI subcommand → `docs/cli.md`
- New auth / permission / threat-model behaviour → `docs/security.md`
- Identity-provider-specific setup → `docs/sso-setup.md` or `docs/firebase-setup.md`

### 5b. Help-text verification (if a new CLI command was added)
For any command added to `mdnest-server` or the `mdnest` CLI, verify it shows up in three places:
- The `case` block (the dispatch).
- The `help` text **Commands** section.
- The `help` text **Examples** section.

```bash
grep -c '<new-command>' mdnest-server   # expect ≥ 3
grep -c '<new-command>' mdnest          # expect ≥ 3 (if added there)
```

### 6. Website sync
If `../mdnest-website` exists, copy the doc set + CHANGELOG over:

```bash
REPO="$(git rev-parse --show-toplevel)"
WEBSITE="$REPO/../mdnest-website"
[ -d "$WEBSITE" ] || { echo "no sibling mdnest-website — skipping website sync"; }

cp "$REPO"/docs/*.md "$WEBSITE/docs/"
cp "$REPO"/CHANGELOG.md "$WEBSITE/docs/changelog.md"
```

### 7. Website index.html (only for major features)
If this is a headline feature, update `../mdnest-website/index.html`:
- Hero badge version (`v3.X.Y`)
- Feature grid cards (add or refresh wording)
- CLI terminal demo if the CLI changed

Bug fixes don't need landing-page changes.

### 8. Commit website
Only if step 6 or 7 actually changed something in the website repo:

```bash
cd "$WEBSITE"
git add docs/ index.html
git commit  # author the message describing what synced
cd "$REPO"
```

### 9. Rebuild local dev stack
Build the new images and recreate the running containers so the change is testable in a browser at the dev port:

```bash
./mdnest-server rebuild
```

`mdnest-server` reads `COMPOSE_PROJECT_NAME` from `mdnest.conf` so this dev stack lives under its own project name and won't collide with any sibling install. After rebuild, hit `/api/config` to confirm the new `version` string is being served.

### 10. Commit mdnest
Stage and commit all changed files in this repo. Branch protection on `main` may require this to land via a PR — use `git push origin main:refs/heads/release/vX.Y.Z` + `gh pr create` if so. Tag with `v<X.Y.Z>` after the PR merges.

### 10a. Verify the merged tree is what you reviewed — BEFORE tagging

**A squash merge can silently drop a change from your release branch.** v4.0.0
shipped without its `mdnest-mcp-server` image because of exactly this:

- the merge base (`v3.11.7`) had `mcp-server` in `release.yml`'s build matrix,
- `main` removed it in a hotfix (#57),
- the release branch's file was **byte-identical to the merge base** — #51's
  re-add restored exactly the pre-hotfix content,
- so git saw a change on one side only and legitimately took `main`'s removal.

The release branch was correct. `main` was not. Nothing warned. So after the PR
merges and **before** you tag, diff the tree you reviewed against what landed:

```bash
git fetch origin
git diff origin/release/vX.Y.Z origin/main -- .github/ deploy/ setup.sh docker-compose.yml
# expect: no output. Anything here is a change the merge discarded.
```

Two habits that prevent the divergence in the first place:

- **Merge `main` back into `develop` after every main-only hotfix.** #57 never
  came down, which is what let the two branches disagree about this file.
- **Cut the release branch from an up-to-date `develop`,** and if `main` has
  moved since, merge `main` into the release branch first so the three-way
  merge has a base that reflects both.

### 11. Publish a GitHub Release for the tag
**This step is required and easy to forget.** `git push --tags` only creates the git ref; a GitHub Release is a separate object. Without a Release, `https://api.github.com/repos/<owner>/<repo>/releases/latest` returns **404**, the backend's update-availability poller silently skips, and no running mdnest install ever sees the "update available" banner in the sidebar footer. The in-app banner is designed around Release metadata (name + notes preview), not bare tag names — so even a hand-rolled tag-fallback wouldn't carry the changelog text the UI shows.

Extract the CHANGELOG section as the release notes and create the Release:

```bash
# After PR merge + `git tag vX.Y.Z && git push --tags`:
REPO="$(git rev-parse --show-toplevel)"
awk '/^## v3\.X\.Y —/{found=1} found{print} /^## v[0-9]/ && NR>1 && !/^## v3\.X\.Y —/{exit}' "$REPO/CHANGELOG.md" \
  | sed '$d' | sed '$d' > /tmp/rel-notes.md
gh release create vX.Y.Z \
  --title "vX.Y.Z — <headline same as CHANGELOG>" \
  --notes-file /tmp/rel-notes.md
```

Verify: hit `/api/config` on any install — `latestRelease.version` should match the tag you just pushed within ~30s of the next poll cycle.

### 12. Verify the artifacts actually published

A green workflow is not proof that everything shipped. `chart: needs: images`
catches build *failures*, not a service silently missing from the build matrix
— so the chart can publish while pointing at an image tag nobody built. That is
how v4.0.0's chart referenced `mdnest-mcp-server:4.0.0`, which did not exist:
any `mcp.enabled=true` install got `ImagePullBackOff` (#76).

`release.yml` now has a preflight that reconciles every first-party image the
chart references against the registry and aborts before `helm push`. Confirm it
did its job rather than assuming:

```bash
for img in mdnest-backend mdnest-frontend mdnest-mcp-server; do
  tok=$(curl -s "https://ghcr.io/token?scope=repository:<owner>/$img:pull" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
  echo "$img: $(curl -s "https://ghcr.io/v2/<owner>/$img/tags/list" -H "Authorization: Bearer $tok" \
    | python3 -c 'import sys,json;print(",".join(json.load(sys.stdin).get("tags") or []))')"
done
```

Every image the chart names must carry the new tag. If one is missing, the
release is broken for anyone who enables that component — say so on the issue
tracker and cut a patch rather than leaving it.

## Key Paths

| Reference | Resolution |
|---|---|
| mdnest repo | `$(git rev-parse --show-toplevel)` (don't hard-code) |
| Website repo | `../mdnest-website` relative to the repo root (sibling convention) |
| Local dev stack | This repo, started via `./mdnest-server rebuild` |
| Local dev URL | Whatever `FRONTEND_PORT` is set to in `mdnest.conf` (most installs use 3100 for the dev project; the public install at `..../PublicRepos/mdnest` uses 3236) |

## Anti-patterns to avoid

- Hardcoding `/Volumes/Work/...` absolute paths — those are machine-specific and break for any other contributor (or the same operator on a different laptop).
- Adding entries to a CHANGELOG section that's already been tagged + pushed. Always create a new section for new fixes after a release ships.
- Skipping the version-consistency check across the three files; the pre-push hook will reject the push if they drift.
- Pushing directly to `main` when branch protection is on. Push to a release branch and open a PR — the PR body should track the CHANGELOG entry.
- Tagging before diffing the merged tree against the release branch (Step 10a).
  A squash merge that drops a workflow change is invisible until a user hits it.
- Treating a green release workflow as proof the artifacts exist (Step 12).
- Cutting a release when a contributor has already told you a fix is in flight
  for a defect that's in this cut. v4.0.0 shipped three known-broken behaviours
  that were fixed hours later. Either wait, or say on the thread which release
  it's going into and why.
- Pushing a tag without also publishing a GitHub Release (Step 11). Tags ≠ Releases; the in-app update banner needs Releases to fire. This was the gap that hid the banner feature for the entire pre-v3.10.0 history of the repo.
