---
name: md-issue-process
description: Take a GitHub issue on mdnest from a URL all the way to done — read it properly, split it into its real symptoms, decide whether it's even ours, reproduce the mechanism, fix each part on its own branch from develop, add the regression test that would have caught it, release it, then reply to the reporter and close. Say "/md-issue-process" (it will ask for the issue URL if you don't give one), or ask in your own words: "take care of issue 87", "handle this issue <url>", "someone reported X, deal with it", "process the open issues". (Part of the md-* mdnest skill family alongside md-fix-bugs, md-add-improvement, md-review-collab and md-ship.)
---

## Purpose

`md-fix-bugs` clears the *brain* backlog. `md-review-collab` handles *incoming
PRs*. This skill is the third door: **a GitHub issue from someone outside the
project**, which needs things neither of the others do — reading a report that
may be one screenshot, working out which parts are actually mdnest's fault,
reproducing a machine you don't have, and then *replying to a human* who is
waiting.

The mechanics of fixing and releasing are deliberately NOT re-specified here;
they are `md-fix-bugs` step 2-5 and `md-ship`. This skill owns the parts that
are specific to an issue: **triage, reproduction, the reply, and the close.**

## Input

Accept any of: a full URL (`https://github.com/mahsanamin/mdnest/issues/87`),
`mahsanamin/mdnest#87`, or a bare `87`. **If the user didn't give one, ask for it
before doing anything else** — do not guess from the open-issue list. If they
name several, or say "the open ones", process them **one at a time, oldest
first**, and finish one before starting the next (the release at the end can
cover several issues — see step 7).

---

## Step 0 — Read the whole issue, including the pictures

```bash
gh issue view <N> --json number,title,state,body,author,labels,comments,createdAt
gh issue view <N> --comments        # if the body references a discussion
```

- **The body is often just an image.** Issue #87 was one screenshot plus "Note: I
  am on Fedora 44" — and that screenshot contained *two independent bugs*. If the
  harness can read the attached image, read it. If it can't, **ask the user to
  paste it** rather than guessing from the title.
- Note the reporter's `author_association` (`NONE` = first-time external) and any
  platform detail they gave (distro, python version, browser, mdnest version).
  Platform detail is a clue about the *mechanism*, not a requirement to own that
  platform (step 2).
- Check for duplicates and for work already in flight:
  ```bash
  gh issue list --search "<key words>" --state all --limit 10
  gh pr list --search "<key words>" --state open
  ```
  If a contributor already has a fix open, say so on the thread and route to
  `md-review-collab` instead of writing a competing fix.

## Step 1 — Split the report into symptoms, before deciding anything

One report is not one bug. Write the list out explicitly:

| # | Symptom, as the user sees it | Suspected layer | Ours? |
|---|---|---|---|
| 1 | traceback printed above the output | CLI ↔ host python | ours (we invoke python) |
| 2 | output is unreadable raw JSON | CLI rendering | ours, and affects everyone |

Do this even when it looks like one thing. In #87, symptom 2 had nothing to do
with Fedora and was hitting *every user on every OS* — it would have been missed
entirely by "fix the Fedora traceback".

## Step 2 — Classify each symptom, then route

| Verdict | What it means | Do this |
|---|---|---|
| **Real bug, ours** | mdnest produces the wrong behaviour | continue to step 3 |
| **Already fixed** | current `develop` doesn't do this | verify on `./mdnest` / a rebuilt stack, then reply naming the version that fixed it, and close |
| **Feature request** | "it should also be able to…" | stop. Write the analysis note (step 9) and route to `md-add-improvement`. Don't half-build it inside an issue fix |
| **Environment, but we can harden** | root cause is on their box, yet mdnest's behaviour made it worse | fix *our* half only, and say plainly on the thread which half was theirs |
| **Not ours, can't harden** | nothing mdnest can do | reply once, factually, with the actual cause; close. No lecture |
| **Needs info** | not reproducible as written | ask exactly one round of specific questions (command, version, `mdnest servers -v`, OS) and label it |

**The "environment, but we can harden" row is the one that pays.** #87's
traceback came from the reporter's own broken `matplotlib` `.pth`. We could not
fix his python — but mdnest was the thing that surfaced it, so `-S -E` plus
"drop stderr and fall back" was ours to write. Fix our layer; **don't try to
police theirs** (see AGENTS.md "Scope discipline").

## Step 3 — Reproduce the *mechanism*, not the environment

You almost never have the reporter's machine. You don't need it — you need the
mechanism. Reproduce locally, in the working tree, **before** changing a line.

- **Test the working-tree CLI (`./mdnest`), never the installed `mdnest`.** The
  installed one self-updates from `main` and can be many versions behind, so it
  will happily "reproduce" bugs you already fixed and hide ones you just wrote.
- **A PATH shim fakes a hostile dependency.** This is how #87 was reproduced
  exactly, on macOS, without Fedora or python 3.14:

  ```bash
  SHIM=$(mktemp -d); REAL=$(command -v python3)
  cat > "$SHIM/python3" <<EOF
  #!/bin/sh
  echo "Error processing line 1 of /home/u/.local/lib/python3.14/site-packages/x-nspkg.pth:" >&2
  echo "AttributeError: 'NoneType' object has no attribute 'loader'" >&2
  PATH='$PATH'; export PATH; exec "$REAL" "\$@"     # restore PATH first: pyenv-style
  EOF
  chmod +x "$SHIM/python3"                          # shims re-resolve via PATH and
  PATH="$SHIM:$PATH" ./mdnest list <ns>             # would recurse forever otherwise
  ```

  Vary the shim to cover the other failure shape: `exit 1` instead of `exec`, for
  "the dependency is present but broken". **Present-but-broken is the dangerous
  one** — a `have <tool>` check passes, so no fallback runs.
- Other mechanisms worth faking the same way: no `python3`/`jq` at all (`have()`
  override, or the bare alpine container in `tests/e2e-docker.sh`), a different
  `awk` (`docker run alpine` = busybox, `debian:stable-slim` = mawk), a
  read-only or non-writable install path, a slow/unreachable server
  (`MDNEST_TIMEOUT`).
- Write down the exact command that reproduces and the exact wrong output. That
  string is what you assert against in step 5, and what you quote in the reply.

## Step 4 — Fix it

Follow **`md-fix-bugs` steps 2 and 4** exactly — they are authoritative:

- one short-lived `fix/<slug>` branch **per distinct symptom**, cut from the
  latest `develop`, strictly sequential;
- merge each verified fix **straight into `develop`** (`git merge --no-ff` +
  push). **No per-issue PR** — the only PR is the release;
- clean commits, **no `Co-Authored-By` / "Generated with" trailer**;
- match surrounding style; smallest change that genuinely fixes the user-visible
  problem.

Two things this repo's CLI will bite you with: it runs under `set -e` (a helper
used as a bare statement must `return 0` on success), and that `set -e` leaks
into anything that *sources* it. See the "Client CLI" section of AGENTS.md before
touching `mdnest`.

**If you find an adjacent bug while in there, fix it on its own branch** and say
so in the changelog — but don't let it grow the release beyond what you can
verify. (#87's fix uncovered legacy `mdnest note read` printing a tree entry
instead of the note body; separate branch, one line in the changelog.)

## Step 5 — Add the test that would have caught it

Non-negotiable, and it goes in the layer that failed:

| What broke | Where the test goes |
|---|---|
| a CLI pure function / parser / fallback | `tests/cli-unit.sh` |
| CLI end-to-end behaviour | `tests/cli-smoke-test.sh` |
| a Go handler | `backend/handlers/*_test.go` |
| frontend logic | `frontend/src/__tests__/*` |
| a UI flow | `tests/browser/*.spec.js` |

For anything host-dependent, assert across **every** environment that matters,
not just the happy one — `cli-unit.sh` now runs its checks under real python3, a
noisy python3, a broken python3, and no parser at all. And assert the *negative*:
"no traceback reached stderr", "no JSON keys in the listing". A test that only
checks the good path would have passed throughout #87.

## Step 6 — Verify before merging (gate)

Run the tier that matches the change (see AGENTS.md "Testing"): `cli-unit.sh` +
`bash -n` for CLI helpers, `cli-smoke-test.sh` for CLI end-to-end,
`npm test`/`npm run build` for frontend, `tests/e2e-docker.sh` for the
fresh-machine path, `tests/e2e-browser.sh` for UI flows. **Don't merge red.**

Expect the push itself to surface unrelated breakage, and handle it honestly:

- **`npm audit` can be red from advisories published since the last release** —
  nothing to do with your fix, but it blocks the pre-push hook *and* the required
  checks on `main`. Clear it on its own `chore/` branch (lock-file-only
  `npm audit fix`, verify build + tests + that the MCP server still boots), merge
  that to `develop` separately, and say so in the changelog under Chores. **Never
  `--no-verify` past it.**
- `govulncheck`/`shellcheck` may be skipped locally (no host Go, no shellcheck).
  Treat CI as the authoritative gate; run shellcheck yourself via
  `docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable -S error <files>`.

## Step 7 — Release it

Run **`md-ship`**, which owns the release end to end (single commit on top of
`main`, one PR, four version files, CHANGELOG, tag **and** GitHub Release,
post-merge tree diff, artifact verification, website sync, `develop` reconciled
at the next `-dev` with the changelog carried over).

The issue-specific additions:

- PR body starts with **`Closes #N.`** so the merge closes the issue.
- The CHANGELOG entry **names the issue and the reporter's platform** ("fixing
  GitHub issue #87, reported from Fedora 44") and describes the *user-visible*
  symptom first, not the code.
- **Work out how the fix actually reaches this reporter, and don't confuse the
  channels:**

  | Fix is in | Reaches users when | They run |
  |---|---|---|
  | `mdnest` CLI script | it lands on **`main`** (`mdnest update` pulls from `raw.githubusercontent.com/.../main`) | `mdnest update` |
  | backend / frontend / chart | the **tag + Release + images** publish | `git pull && ./mdnest-server rebuild`, or bump the image tag |

  The tag and Release still matter for a CLI-only fix (they drive the in-app
  update banner), but they are not what delivers it. Say the right one in the
  reply.
- If several issues are fixed in the same cycle, one release covers them all —
  list each in the changelog and reply on each thread.

## Step 8 — Reply to the reporter, then close

**Only after the fix is verified and released.** No "should be fixed soon"
comments; either it's out, or you're asking a question.

**Posting is outward-facing and goes out under the owner's name, so draft the
comment, show it to the owner, and post only on their go-ahead** — unless they
have told you in this session to post without asking. Never post a comment on a
public issue you haven't been cleared to post.

```bash
gh issue comment <N> --body-file <file>
gh issue close <N> --reason completed   # if the PR body's "Closes #N" didn't
```

What the comment must contain, in this order, and nothing else:

1. **What shipped**, in one line, naming the version: *"Fixed in v4.1.2."*
2. **A symptom-by-symptom account** — both halves if there were two. Show the
   new output if it's visual (a listing, an error message); it's the fastest
   proof.
3. **Exactly how to get it** — the literal command (`mdnest update`, or
   `git pull && ./mdnest-server rebuild`).
4. **What wasn't ours, stated once and without judgement.** #87: "the `.pth`
   error is coming from a stale matplotlib install in your `~/.local` and will
   still show up in your other python usage — mdnest just no longer surfaces it."
   Say it because they'll otherwise think we fixed their python. Don't tell them
   how to run their machine.
5. **A link to the release** and, if useful, the commit or test that pins it.

What it must NOT contain: an apology paragraph, a changelog dump, a roadmap, a
request to star the repo, or any mention of how the fix was authored. Thank them
once, briefly — a good report is worth acknowledging, and this may be someone's
first interaction with the project.

Template:

```markdown
Fixed in v4.1.2 — thanks for the report, the screenshot had two separate bugs in it.

**The traceback.** mdnest shells out to `python3` for percent-encoding and JSON
parsing, so your broken `.pth` printed into the middle of our output. Every
python3 call now runs with `-S -E` (skips site init, so `.pth` files are never
processed), drops python's stderr, and falls back to a pure-bash/awk path if
python3 fails at all. To be clear about which half was which: the `.pth` error
itself is a stale matplotlib install in your `~/.local` — mdnest just doesn't
surface it any more.

**The raw JSON.** That one hit everyone, not just Fedora. `mdnest list` now
renders a tree, with `--json` if you want the old payload for scripts:

    engineering
    ├── Architecture/
    │   └── system-overview.md
    └── README.md

    1 folder, 2 files

Run `mdnest update` to pick it up. Release: <link>
```

## Step 9 — Record it in the brain

One file per externally-reported issue, in
`@srv-ahsan-mini/mahsan_brain/MyProjects/mdNest/ExternalRequests/`, named
`YYYY-MM-DD-issue-<N>-<slug>.md`. Follow the mdnest writing rules (Write the file
locally, send it with `mdnest create <path> "$(cat file)"`, then verify no
escaped backticks survived).

Keep it short for a fixed bug — source, reporter, date, verdict, what the real
mechanism was, what shipped, and **the lessons that generalise**. The lessons are
the reason the file exists; #87's were "a present-but-broken dependency is worse
than a missing one — gate on the result, not on presence" and "raw API JSON is
not a CLI feature". A feature request gets the longer analysis treatment instead
(see the issue-#85 note for the shape).

Nothing goes in the brain `Bugs/` folder — that folder is Ahsan's own backlog,
and a GitHub issue is already tracked by GitHub.

---

## Done criteria

- Every symptom in the report is classified, and each one is either fixed,
  explained as not-ours, or explicitly deferred with a reason.
- A regression test exists in the layer that failed, asserting the negative too.
- Each fix merged straight into `develop`; **no per-issue PR**; clean commits.
- Released via `md-ship`: one PR on top of `main`, four version files, CHANGELOG,
  tag **and** GitHub Release, artifacts verified, `develop` reopened at the next
  `-dev` with the changelog carried over.
- The reply is posted **with the owner's go-ahead**, names the version, tells
  them the exact upgrade command, and separates our half from theirs.
- Issue closed. Brain note written and verified.

## Anti-patterns

- **Fixing the title instead of the report.** Read the screenshot; enumerate the
  symptoms; #87 would have been half-fixed otherwise.
- **Believing you need their OS.** Fake the mechanism with a PATH shim or a
  container. Waiting on a Fedora box is how issues rot.
- **Reproducing against the installed `mdnest`.** It lags `main`; use `./mdnest`.
- **Trusting a `have <tool>` check.** Present-but-broken passes it. Gate on the
  result and always keep the fallback reachable.
- **Fixing their environment.** Harden our layer, name theirs once, move on.
- **Commenting before it ships**, or promising a date.
- **Posting to a public issue without the owner's go-ahead.**
- **`--no-verify` past a red audit**, or bundling an unrelated dependency bump
  into the fix commit instead of its own `chore/` branch.
- **Tagging without publishing a Release** (tags ≠ Releases — the in-app banner
  needs the Release), or telling the reporter to wait for a Release when the fix
  is CLI-only and already on `main`.
- **Letting the fix grow into the feature the reporter also asked for.** Split
  it: fix the bug, route the feature to `md-add-improvement`.
