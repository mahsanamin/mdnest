---
name: md-review-collab
description: Review pull requests from outside contributors on mdnest. Check three things in order — is the work legit (does it do what it claims?), does it add a security hole, and is it mdnest's direction — then decide the merge order, write the review, and merge. Say "/md-review-collab" when someone opens a PR, or when asked to look at contributor PRs, decide what to merge, or vet incoming work. (Part of the md-* mdnest skill family alongside md-fix-bugs, md-add-improvement and md-ship.)
---

## Purpose

Someone outside the project opened one or more PRs. This skill is how we decide
what gets merged, in what order, without a security regression or a change to
what mdnest *is* slipping through on the strength of a convincing description.

Outside contributions are welcome and this batch has genuinely improved the
project. The job is not to be suspicious — it's to be **specific**. Trust the
person, verify the code.

## The three gates

Run them in this order. A PR must pass all three.

1. **Legit** — does the code do what the description says?
2. **Safe** — does it add a security hole, or weaken an existing check?
3. **Right direction** — does it fit mdnest, or quietly replace it?

Gates 1 and 2 are ours to judge on the evidence. **Gate 3 is the owner's call**
whenever a founding property is in play — surface it, don't decide it alone.

## Step 0 — map the batch before reading any code

```bash
gh pr list --state open --limit 30 --json number,title,author,baseRefName,\
additions,deletions,changedFiles,mergeStateStatus --template '...'
for n in <numbers>; do gh pr checks $n; done
```

Then, for each PR: `gh pr view <n> --json title,body,comments,reviews,commits`.

- **Read the existing comment thread first.** Half the questions are already
  answered, and a contributor who addressed feedback deserves credit for it,
  not the same note twice.
- **Contributors target `main`.** We integrate through `develop`. Ask them to
  retarget; don't merge to `main` outside a release.
- **Stacked PRs show their ancestors' commits.** A 5-file PR can look like 30
  files. Identify the top commit — that's the new work. `git show <sha> --stat`.
- Fetch every PR locally so you can actually run things:
  ```bash
  for n in <numbers>; do git fetch origin "pull/$n/head:pr/$n" --force -q; done
  git diff --stat origin/develop...pr/<n>
  ```

## Step 1 — Gate 1: is the work legit?

**Green CI means it compiles, not that the claim is true.** Every PR in the last
batch was green; one of them silently removed a security check.

- **Test the claim, don't read it.** For "pure refactor, no behaviour change",
  write a probe that runs **old and new side by side on the same input** and
  prints both results. Go isn't installed on the dev host — use Docker:
  ```bash
  git worktree add -f <scratch>/wt pr/<n>
  cd <scratch>/wt && docker run --rm -v "$PWD/backend":/src -w /src \
    golang:<go-version-from-go.mod>-alpine go test -run <Probe> -v ./handlers/
  git worktree remove --force <scratch>/wt   # always clean up
  ```
- **Mutation-test their tests.** A passing test proves nothing. Undo the fix,
  re-run, and confirm the test goes red. If it stays green the test is
  decoration. (This is how we confirmed #53's permission tests were real: with
  the superadmin bypass restored, four cases failed across two packages.)
- **Diff the test files, not just the source.** Adapting a constructor call is
  fine. A changed *assertion* in an existing security test is a red flag — it
  may mean the behaviour it pinned was quietly dropped.
- **Trace the option end to end.** A flag can be honestly documented and still
  wired wrong. Follow it through `setup.sh`, the generated `docker-compose.yml`,
  the Helm chart, and — the part that gets missed — **whatever keeps running
  against the old assumption.** Ask: if I turn this on, what else is still
  operating on data it no longer owns?

## Step 2 — Gate 2: does it add a security hole?

Grep the diff for these first. Each one is a hole we have actually shipped.

- **Path checks getting weaker.** `SafePath()` resolves symlinks and re-verifies
  containment; a lexical-only replacement looks equivalent and isn't. A symlink
  reaches a namespace legitimately — git stores them as mode `120000`, so
  git-sync checks them out, and a host-side `cp -a` preserves them.
  ```bash
  git grep -n "SafePath\|SafeRelPath\|RequireNamespace" pr/<n> -- backend/
  ```
- **Permission checks moving or vanishing.** `middleware/permission.go` is the
  chokepoint for every content endpoint. `/api/files/` takes its namespace from
  the **URL path**, so its read check lives *inside* the handler, not in
  middleware — a refactor can drop it without breaking a build.
- **Namespace input reaching storage unvalidated.** Every `ns` must pass
  `ValidNamespaceName` / `RequireNamespace*` before it becomes a path segment.
- **New render targets.** Any new `innerHTML` / `dangerouslySetInnerHTML` must
  go through `frontend/src/sanitize.js`. Never sanitize inline.
- **New dependencies.** `git diff origin/develop...pr/<n> -- '*/go.mod' '*/package.json'`.
  A lean client for a real feature is a fair trade; a framework is not.
- **Fail-open vs fail-closed.** An unrecognised value should be refused, not
  ignored. Silently falling back to the safe default is fine; silently falling
  back to the permissive one is not.

Write the finding as a **reproduction**, not an opinion. Paste the failing
output into the review. "I ran this and got X" ends the argument; "this looks
unsafe" starts one.

## Step 3 — Gate 3: is it mdnest's direction?

These are the properties the product is built on. A change that trades one away
isn't a feature request — it's a different product.

- **Git is the storage layer, not an add-on.** Notes are plain Markdown files in
  a git repo. History is `git log`. Backup is `git push`. Recovery is `cp -r`.
  Search is `grep`. It's free, and adopting mdnest requires trusting us with
  nothing. If a change routes note data where git can't see it, it doesn't add a
  backend — it removes the foundation, and takes version history with it.
- **Namespaces come from mounts (or declarative config), never runtime creation
  by users.** Note the trap: `/data/notes` is **not** a volume in
  `docker-compose.yml` — only each namespace is bind-mounted individually. So a
  namespace created at runtime lives in the container's writable layer and is
  destroyed by `./mdnest-server rebuild`, and git-sync never sees it. Creation
  reports success. That's silent data loss.
- **No database in single mode.**
- **The core stays lean; new capability arrives off by default behind a flag.**
  Measure it, don't assert it: new `go.mod` / `package.json` entries, gzipped
  bundle delta, and whether `setup.sh`, `mdnest.conf.sample`,
  `docker-compose.yml`, the Dockerfiles, `mdnest-server` or `nginx.conf` moved
  at all. An operator who doesn't need the feature must carry none of its weight.
- **Config surface must never outrun the code.** The backend ignores env it
  doesn't read, so a knob with no implementation doesn't fail — it lies. Guard
  it so it fails at install time naming what's missing, and delete the guard in
  the same change that lands the capability.
- **Two modes that can't coexist must say so.** If a new backend makes an
  existing feature meaningless, make them mutually exclusive in code. Don't
  leave the old one running against stale data.

**Before telling anyone to change direction:**

- **Ask what they're running today.** If their fork is already live, a direction
  change is a migration bill. That changes the sequencing and the tone.
- **Find the need under the request.** Their stated solution is rarely their
  actual constraint. Read their Helm values, their validation rules, their env
  — the constraint is usually written down somewhere. In the last batch the real
  driver was "multi-replica without ReadWriteMany", and their own merged chart
  already contained a better answer than the PR they'd opened.
- **Check whether the repo already solves it.** Twice now the mdnest-native
  answer was already merged and nobody noticed.
- **Never decline on vibes.** Name the invariant, show the cost, and offer the
  path that meets their real need. Declining a mechanism is fine; dismissing
  the need is not.

## Step 4 — decide the merge order

- **Widest blast radius first.** The PR that touches the most shared files
  becomes the base everyone else rebases onto. Merging a small one ahead of it
  dumps rebase work on the contributor.
- **Simulate before you commit to an order.** Don't guess at conflicts:
  ```bash
  git worktree add -f <scratch>/wtm origin/develop --detach
  cd <scratch>/wtm
  git merge --no-commit --no-ff pr/<a> && git commit -qm sim
  git merge --no-commit --no-ff pr/<b>; git diff --name-only --diff-filter=U
  git worktree remove --force <scratch>/wtm
  ```
- **A ready PR does not outrank sequencing.** If the wide PR is blocked on the
  contributor, wait — don't merge a small one past it just because it's green.
- **Unstack what isn't really stacked.** A PR that shares no files with its
  "parent" is stacked by branch convenience. Ask for it rebased onto `develop`
  so it can move independently.
- **Version bump.** If the batch is a minor, `develop` becomes `X.Y.0-dev` when
  it lands. The pre-push consistency check compares the four version files *to
  each other*, so it will not catch semver drift — this one is on us.

## Step 5 — write the review

### The bar for posting at all

**Before posting, ask: if this comment did not exist, would anything be worse?**
If the answer is no, don't post it. A PR thread is a shared workspace, not a
notebook. Comments that read as thorough but change nothing make the real
findings harder to see.

Post only these:

1. **A blocker**, with a reproduction.
2. **An answer to a question they actually asked.**
3. **A decision they are blocked on** (merge order, direction, accept/decline).

Do **not** post:

- A preview of a review you haven't done yet ("things I'll want when I review
  this properly") — do the review, then comment once.
- A restatement of something already said on another PR — link it instead.
- Praise as its own comment.
- Style and naming opinions on code that works.
- Anything you cannot back with a command you ran and its output.

**Every factual claim must be validated by code, not inference.** Not "this
probably breaks git-sync" — read `setup.sh`, read the generated
`docker-compose.yml`, confirm the mount is emitted, then say so and cite it. If
you can't verify it, either verify it or leave it out. A confident wrong claim
costs the contributor real time and costs us credibility.

### How to write the one you do post

- **Shortest version that transfers the finding.** Then cut it again.
- **Lead with the blocker, not with context.** They need to know what to fix.
- **Separate blocking from non-blocking, explicitly.**
- **Show the evidence.** Paste the failing output — "I ran this and got X" ends
  the argument; "this looks unsafe" starts one.
- **Say what you want instead.** "Have `LocalStorage` resolve symlinks and keep
  the lexical check as the shared contract" is actionable. "This is unsafe" isn't.
- **If they pushed back and were right, say so in one line** and move on.
- **One place for long reasoning.** Put the architectural argument on the
  tracking PR; everything else links to it.

Post with `gh pr review <n> --request-changes --body-file <file>` for blockers,
`gh pr comment <n> --body-file <file>` when a decision or answer is owed.

## Step 6 — the contributor's decisions are theirs

**Never close, retarget, force-push, or edit someone else's PR on their behalf.**
Recommend, then let them act. Their name is on it.

This applies even when the outcome is already agreed — including when they have
said in the thread that they're abandoning the approach. "They said they'd drop
it" is not the same as them dropping it, and closing it for them takes the
decision out of their hands over a few seconds of convenience.

- **Should be closed?** Say why, say you think it should close, and ask them to
  close it. Leave it open until they do.
- **Wrong base branch?** Ask them to retarget.
- **Needs a rebase or a fix?** Ask, with a concrete description of the change.
  Don't push to their branch unless they've invited it.

What *is* ours: merging (once it passes the gates), approving, requesting
changes, and saying plainly what we will and won't take.

If a PR sits stale after a recommendation, ping the thread — don't reach for the
close button.

## Step 7 — merge

- Merge into **`develop`**, never `main` outside a release. `main` is protected
  by required Security Audit checks with no bypass — that gate is authoritative,
  and the local pre-push hook is not a substitute (it silently skips
  `govulncheck` when `go` isn't installed on the host).
- **Clean commits — no `Co-Authored-By` or "Generated with Claude Code"
  footers.** This overrides the global default.
- Credit the contributor by name in the CHANGELOG entry for the release.
- After merging, tell the contributor if their other PRs now need a rebase.
- **Get the owner's sign-off before merging anything that touches Gate 3.**

## Done criteria

- Every open contributor PR has been through all three gates.
- Every blocking finding is backed by a reproduction, not a suspicion.
- The merge order is decided and, if non-obvious, was simulated.
- No contributor PR was closed, retargeted or pushed to on their behalf.
- Direction questions are surfaced to the owner, not silently decided.
- Contributors know what's expected of them next, and why.
