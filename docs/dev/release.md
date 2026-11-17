# Release process and branch gates

For maintainers. Contributors do not release: open a PR into `develop` and stop there.

## Shipping a release

**Ship carefully: other teams run mdnest in production.** Before any release,
`md-ship` Step 0 (the ship gate) must hold, and it is blocking:

- every change soaked on the dev stack (features at least a day), and at most
  one release a day unless it fixes a security hole or data loss;
- `develop` is green on the commit being released, and the audits were re-run
  that day;
- `bash tests/release-gate.sh` passed on the release commit itself. It runs the
  pre-push release tier, Go tests against a real Redis, shellcheck and the
  end-to-end suites the changed files call for, and records the tree it tested.
  The pre-push hook accepts a push to `release/*` or `main` only for that tree;
- every topology the change touches was run (single, multi, HA), and an upgrade
  from the last release was tried when anything stored changed;
- nothing users rely on is removed without the owner's sign-off (#135), and no
  change narrows what a superadmin can do in the default configuration;
- every required check on the release PR is green. `main` requires the CI jobs
  as well as the Security Audit ones (`scripts/apply-main-branch-protection.sh`).

A regression in a released version is fixed with a test shown failing on that
tag (`MDNEST_BUILD_ROOT=<checkout of the tag>`).

- **One PR per release.** Bundle all the work for a release into a single branch (`feat/<name>` or `release/v3.X.Y`) and open **one** PR against `main`. Don't open intermediate / sibling PRs for sub-features during the same release cycle — they cause merge conflicts on shared files (`CHANGELOG.md`, the three version files, `App.jsx`, docs) when one lands while another is still open. Hotfix exception: a true emergency (security CVE, prod crash) can ship as its own PR ahead of the release, but flag it before opening. v3.10.0 hit exactly this — PR #10 (v3.9.1) merged while PR #11 (v3.10.0) was open and produced six-file conflicts; resolve by merging `main` into the release branch and keeping the higher version + the deletion of any files the cutover removed.
- **Version scheme — `develop` carries `X.Y.Z-dev`, releases drop the suffix.** `develop` always holds the in-flight version with a `-dev` pre-release suffix (e.g. `3.11.3-dev`), so a develop/staging box reads `v3.11.3-dev` ("candidate, still validating") and production reads the plain `v3.11.3`. The **release branch sets the plain `X.Y.Z`** (drops `-dev`); after the release merges, bump `develop` to the *next* `X.Y.(Z+1)-dev`. `isVersionNewer` (App.jsx) is pre-release-aware so a `-dev` build shows no false "update available" against the last release but does see the final release as newer once it ships.
- Set the version in four files — on the release branch use the plain `X.Y.Z`; on `develop` use `X.Y.Z-dev`:
  - `backend/handlers/config.go` — `"version": "3.X.Y"`
  - `frontend/package.json` — `"version": "3.X.Y"`
  - `mdnest` CLI script — `MDNEST_CLI_VERSION="3.X.Y"`
  - `deploy/helm/mdnest/Chart.yaml` — `appVersion: "3.X.Y"` (v3.11.7+, the Helm chart's default image tag). Note `version:` in the same file is the **chart's own** SemVer and moves independently — bump it when the chart's templates change, not on every app release. The release workflow passes `--app-version` when packaging, so a *published* chart is stamped from the tag either way; this file only governs `helm install ./deploy/helm/mdnest` from a source checkout.
- Update `CHANGELOG.md` with the new version section
- Merge to `main`, tag as `v3.X.Y`, push with `--tags`
- **Publish a GitHub Release for the tag** — `gh release create vX.Y.Z --title "..." --notes-file <file>` with the CHANGELOG entry as the notes. Tags ≠ Releases on GitHub: `git push --tags` only creates the git ref, but the in-app "update available" banner polls `https://api.github.com/repos/<owner>/<repo>/releases/latest` which returns **404** when zero Releases have been published — so without this step, no running mdnest install will ever notice a new version. The frontend's banner (`appConfig.latestRelease.name` + `.notes` preview) is also designed around Release metadata, not bare tag names. The clean recipe:
  ```bash
  # after tag + push --tags
  awk '/^## v3.X.Y —/{found=1} found{print} /^## v[0-9]/ && NR>1 && !/^## v3.X.Y —/{exit}' CHANGELOG.md > /tmp/rel-notes.md
  gh release create vX.Y.Z --title "vX.Y.Z — <headline>" --notes-file /tmp/rel-notes.md
  ```
- Run `/md-ship` skill after code changes to update docs, website, and test instance. (mdnest skills use the `md-*` prefix: `md-fix-bugs` clears the Bugs backlog, `md-add-improvement` the Features backlog, `md-ship` does the post-change docs/website/release chores.)
- Pre-push hook (`.githooks/pre-push`) verifies builds, security, lock files, version consistency
- New developers run `./mdnest-server dev-setup` to activate hooks

### The merge-to-main security gate (required status checks)

**Nothing merges to `main` until the Security Audit passes — this is enforced server-side, not by trust.** The `Security Audit` workflow (`.github/workflows/security-audit.yml`) runs four jobs on every PR to `main` — `Frontend (npm audit)`, `MCP Server (npm audit)`, `Backend (govulncheck)`, `Shell scripts (shellcheck)` — and those four are **required status checks** on the `main-branch` repository ruleset. A red or pending check blocks the merge (`gh pr merge` refuses; the PR sits at `mergeStateStatus=BLOCKED`). The `main-branch` ruleset has **no bypass actors** (`current_user_can_bypass: never`), so the gate binds even the repo owner — the separate `mahsan_bypass` ruleset only exempts the *pull-request-required* rule on non-default branches (that's how `develop` takes direct pushes), it does **not** exempt `main`'s status checks.

- **Why it exists / the failure it prevents:** *running* a check is not *requiring* it. Before this gate, the audit ran but wasn't required, so a PR merged at `mergeStateStatus=UNSTABLE` with a failing check — that's how the `crypto/tls` stdlib vuln **GO-2026-5856** landed on `main` via the v3.11.5 release (CI caught it only on the *post-merge* push). Bumping Go `1.26.4 → 1.26.5` (go.mod `go` directive + `backend/Dockerfile` builder image) fixed the vuln.
- **Read the threshold the gate actually sets before "fixing" what an audit
  prints.** Both npm audit jobs run `--audit-level=high`, so a moderate
  advisory is below the gate on purpose (`security-audit.yml` says as much:
  "Bump severity here when those are cleaned up"). A bare local `npm audit`
  lists every severity, and reading that as the gate is how v4.4.0-dev grew an
  `overrides` entry for a MODERATE advisory that was never blocking anything —
  and the override then made the tree invalid to npm's legacy quick-audit
  endpoint (`400 … Invalid package tree`), which refuses the whole audit. One
  moderate advisory traded for no audit signal at all. Local runs passed
  because local npm reached the working bulk endpoint while CI fell back to
  the legacy one — **verifying in one environment verified one environment**,
  which is the durable half of this lesson: CI pins Node 20 (npm 10.x) and a
  dev box on Node 24 (npm 11.x) is a different audit client, so test a
  dependency change in `node:20` before believing it.

  **Updated in v4.5.1: that `@xmldom/xmldom` override is now in place and
  required.** The advisory was re-rated **high**, which put it above the gate
  and blocked every merge to `main` — the exact condition the old note said to
  revisit on. `speech-rule-engine@4.1.4` still pins `0.9.10` exactly and
  `marp-core`/`mathjax-full` are both already at their latest, so an
  `overrides` entry forcing `^0.9.12` is the only route, and re-testing under
  `node:20`/npm 10.8.2 shows it no longer breaks the audit the way it did in
  v4.4.0-dev. Two things made it safe to take: `xmldom` and
  `speech-rule-engine` are **tree-shaken out of every shipped chunk** (grep
  `frontend/dist/assets/*.js` — zero hits), so nothing about the browser
  bundle changes; and Marp still renders, verified by rendering a real deck
  with front-matter, pagination and math through `marp-core` in Node rather
  than by trusting the unit tests, which cover our own `isMarpDoc` and not
  marpit's YAML parsing.
- **"Could not check" is not "found something", and the hook got this wrong.**
  `npm audit` exits non-zero for a real advisory AND for a failure to reach the
  advisories endpoint. The hook discarded stderr and reported every non-zero
  exit as `VULNERABILITIES FOUND`, so an npm outage (503s on
  `/-/npm/v1/security/advisories/bulk`) blocked pushes while naming the wrong
  cause — and `npm audit fix` exited 0 having applied nothing, which is how the
  same outage looks from the other side. `npm_audit_check` now separates them:
  an unreachable endpoint SKIPs with the reason printed (matching how the hook
  already treats a missing Go toolchain or shellcheck), a real finding still
  blocks. `tests/pre-push-audit.sh` drives the helper against fake `npm`s
  covering all seven outcomes, and the load-bearing one is "REAL vulnerability
  still exits non-zero" — a fix here that reclassified too much would silently
  disarm the check. Same rule as `curl_reason` in the CLI: keep the reason when
  the reason is what the reader has to act on.
- **The local pre-push hook is defense-in-depth, not the gate.** It runs `govulncheck` too, but **silently skips it when `go` isn't installed on the host** (e.g. this dev machine) and can be `--no-verify`'d — and it doesn't run at all on a GitHub-side PR merge. Treat CI required checks as the authoritative gate; never assume a green local push means the security scan ran.
- **Managing the gate as code:** `scripts/apply-main-branch-protection.sh` (idempotent) adds/updates the required-status-check rule on the `main-branch` ruleset. It needs a token with repo **Administration: write** (a contents/PR-scoped fine-grained PAT gets HTTP 403 on the ruleset PUT). The check-context strings in that script must match the workflow job `name:` values **exactly** — a typo becomes an "Expected" check that never reports and blocks `main` permanently.

### The `develop` gate (contributors gated, owner bypasses)

`develop` is the integration branch: every contributor PR lands there first and soaks for a few days before the release PR to `main`. Its ruleset is `develop-branch`, managed by `scripts/apply-develop-branch-protection.sh` (idempotent — creates if absent, else replaces the rules).

- **What it enforces:** `deletion` + `non_fast_forward` protection, **1 required approval**, and **9 required status checks** — the five `CI` jobs (`ci.yml`) plus the same four `Security Audit` jobs `main` requires.
- **The owner (admin role) is a bypass actor, deliberately.** Required status checks gate *ref updates*, not just merges, so without the bypass the `md-fix-bugs` / `md-add-improvement` flow — merge each verified branch straight into `develop` locally, then push — would start getting rejected. So `develop-branch` gates *contributors*; the local `.githooks/pre-push` remains the owner's gate. Because that hook silently skips `govulncheck` without a host Go toolchain, `security-audit.yml` also runs on **pushes** to `develop`, so the branch tip is scanned even when the hook couldn't.
- **Why 1 approval and not 0:** outside contributors work from forks and have **no write access to the base repo**, so they cannot merge anything today regardless of rulesets — merging requires write on the base. But `mahsan_bypass` (`~ALL`) only requires *that a PR exist*, with `required_approving_review_count: 0`. The moment anyone is granted write, they could self-merge into `develop`. An author cannot approve their own PR, so requiring 1 routes any future collaborator through the owner. Set in advance rather than after.
- **`require_code_owner_review` is left off on `develop`, and is inert on `main`** — there is no `CODEOWNERS` file in the repo. Adding one would be actively harmful while the owner is sole maintainer: `main-branch` has no bypass actors, and GitHub forbids self-approval, so a `CODEOWNERS` entry would hard-block the owner's own release PRs.
- **Check-context strings must match what Actions *reports*, not the job `name:`.** For a **matrix** job the reported context appends the matrix values — `ci.yml`'s `images` job carries both `name` and `context` keys, so it reports as `Docker images (build only) (backend, backend)`. Always verify against a real run before editing the list, or the branch blocks forever on an "Expected" check that never arrives:
  ```bash
  gh api "repos/<owner>/<repo>/commits/$(git rev-parse origin/develop)/check-runs" \
    --jq '.check_runs[].name' | sort -u
  ```
- **Repository-role bypass ids are asserted, not looked up** — a user-owned (non-org) repo has no roles listing endpoint. `5` is the admin role; the script verifies by asserting `current_user_can_bypass == "always"` after writing and exits non-zero if not, since a wrong id silently breaks the owner's direct pushes to `develop`.

### Where contributor PRs should target

`main` is still the default branch, so GitHub prefills `main` as the base for fork PRs and contributors have to retarget by hand. This is a known, accepted rough edge — the trunk-based model (PRs into `main`, release branches cut off it) is the ecosystem norm that contributors expect, whereas mdnest uses git-flow because it ships explicit versioned self-hosted releases with an in-app update banner keyed to GitHub Releases. Two ways to close it if the friction becomes real: make `develop` the default branch (**repoint `main-branch`'s condition from `~DEFAULT_BRANCH` to literal `refs/heads/main` first**, or the whole security gate silently follows the default onto `develop`), and/or add a required check on `main` that fails when a PR's head isn't `develop` / `release/*` / `hotfix/*`. Neither is in place yet.


## Public wording (README, docs, website, release notes)

mdnest is pitched as **"Your team and your AI agents, working from the same notes."**: a self-hosted Markdown knowledge base for developer teams who work with coding agents. A single developer can try it alone first, but teams are the main readers. The owner sets the audience and the pitch, so do not change either on your own.

Every public sentence (this repo's `README.md`, the user-facing `docs/`, CHANGELOG entries, GitHub release notes, and the website) follows the writing standard in the website repo: `../mdnest-website/WRITING.md` ([on GitHub](https://github.com/mahsanamin/mdnest-website/blob/main/WRITING.md)). In short:

- Plain English: short common words, one idea per sentence, no metaphors, no em or en dashes, no marketing words.
- Say what the user gets, then the fact that proves it.
- Promise only what the **released** code does. No time claims ("3 minutes"), no "one command", no "nothing leaves your server", no "built-in AI". `WRITING.md` has the full list and the wording to use instead.
- Label features the basic install does not turn on: "Optional" (for example the task board, drawings, MCP) or "Needs team setup" (comments, presence, per-person access, groups, private chats).

When a change here alters one of those defaults or what the server sends out, update the facts in `WRITING.md` in the same release. `md-ship` step 7 covers this.

