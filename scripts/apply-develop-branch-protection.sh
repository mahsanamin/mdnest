#!/usr/bin/env bash
#
# apply-develop-branch-protection.sh
#
# Create/update the `develop-branch` ruleset so nothing lands on the
# integration branch unreviewed, unbuilt, or unaudited.
#
# WHY THIS EXISTS
# ---------------
# `develop` is where every contributor PR lands first and where a change sits
# for a few days of soak before the release PR to `main`. Until this ruleset
# existed, `develop` had:
#
#   - No required status checks. CI and the Security Audit *ran* on PRs into
#     develop but nothing *required* them — the same "running is not requiring"
#     gap that let GO-2026-5856 reach main via the v3.11.5 release. A red PR
#     merged just as easily as a green one.
#   - Zero required approvals. The `mahsan_bypass` ruleset (~ALL) forces a PR
#     on every branch, but with required_approving_review_count=0 there was
#     nothing to satisfy. Outside contributors work from forks and have no
#     write access, so they cannot merge today — but the moment anyone is
#     granted write, they could self-merge into develop. This closes that in
#     advance rather than after.
#   - No deletion / force-push protection.
#
# WHAT IT DOES NOT DO
# -------------------
# The repo owner (admin role) is a bypass actor here, deliberately: the
# md-fix-bugs / md-add-improvement flow merges each verified branch straight
# into develop locally and pushes, and required status checks gate ref updates,
# not just merges. So this ruleset gates *contributors*, while the local
# .githooks/pre-push remains the owner's gate on develop. That is a real
# tradeoff — the hook silently skips govulncheck on a host without Go — which
# is why this script also relies on security-audit.yml running on pushes to
# develop, so the branch tip is scanned even when the hook could not.
#
# `main` is unaffected. Its gate is `main-branch` (no bypass actors, binds even
# the owner) — see apply-main-branch-protection.sh.
#
# REQUIREMENTS
# ------------
#   - gh CLI authenticated with a token that has repository "Administration"
#     write permission. A contents/PR-scoped fine-grained PAT returns HTTP 403
#     on the ruleset POST/PUT.
#   - python3 for the JSON assembly; jq is not required.
#
# USAGE
# -----
#   scripts/apply-develop-branch-protection.sh
#   REPO=owner/name scripts/apply-develop-branch-protection.sh
#
# Idempotent: creates the ruleset if absent, otherwise replaces its rules with
# exactly the set below.

set -euo pipefail

REPO="${REPO:-mahsanamin/mdnest}"
RULESET_NAME="develop-branch"
BRANCH_REF="refs/heads/develop"

# The check "context" strings must match what GitHub Actions actually reports,
# NOT the job `name:` value in the workflow. For a matrix job the reported
# context appends the matrix values — `ci.yml`'s `images` job includes both
# `name` and `context` keys, so it reports as
# "Docker images (build only) (backend, backend)". A string that never reports
# becomes a permanently "Expected" check and blocks the branch forever, so
# verify against a real run before editing this list:
#
#   gh api "repos/$REPO/commits/$(git rev-parse origin/develop)/check-runs" \
#     --jq '.check_runs[].name' | sort -u
CONTEXTS=(
  # .github/workflows/ci.yml — build + test
  "Backend (build + test)"
  "Frontend (build + test)"
  "Helm chart (lint + render)"
  "Docker images (build only) (backend, backend)"
  "Docker images (build only) (frontend, frontend)"
  # .github/workflows/security-audit.yml — the same four jobs main requires
  "Frontend (npm audit)"
  "MCP Server (npm audit)"
  "Backend (govulncheck)"
  "Shell scripts (shellcheck)"
)
GITHUB_ACTIONS_APP_ID=15368  # the "GitHub Actions" app; pins the check to Actions

# Repository-role ids used as bypass actors. 5 is the admin role — verified
# empirically below via `current_user_can_bypass`, since there is no roles
# listing endpoint for a user-owned (non-org) repository.
ADMIN_ROLE_ID=5

echo "Looking for an existing '$RULESET_NAME' ruleset on $REPO ..."
RULESET_ID="$(gh api "repos/$REPO/rulesets" \
  --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" || true)"

PAYLOAD="$(CONTEXTS_JSON="$(printf '%s\n' "${CONTEXTS[@]}")" \
  APP_ID="$GITHUB_ACTIONS_APP_ID" \
  ADMIN_ROLE_ID="$ADMIN_ROLE_ID" \
  NAME="$RULESET_NAME" \
  BRANCH_REF="$BRANCH_REF" python3 - <<'PY'
import json, os

contexts = [c for c in os.environ["CONTEXTS_JSON"].splitlines() if c]
app_id = int(os.environ["APP_ID"])

print(json.dumps({
    "name": os.environ["NAME"],
    "target": "branch",
    "enforcement": "active",
    # Admin bypasses so the owner's local merge-and-push flow into develop keeps
    # working. Contributors hold no role here (they work from forks), so this
    # exempts nobody but the owner.
    "bypass_actors": [{
        "actor_id": int(os.environ["ADMIN_ROLE_ID"]),
        "actor_type": "RepositoryRole",
        "bypass_mode": "always",
    }],
    # Literal ref, not ~DEFAULT_BRANCH: the default branch is `main` today and
    # this ruleset must stay pinned to develop even if that ever changes.
    "conditions": {"ref_name": {"include": [os.environ["BRANCH_REF"]], "exclude": []}},
    "rules": [
        {"type": "deletion"},
        {"type": "non_fast_forward"},
        {
            "type": "pull_request",
            "parameters": {
                # 1, not 0: an author cannot approve their own PR, so any future
                # write collaborator must route through the owner.
                "required_approving_review_count": 1,
                "dismiss_stale_reviews_on_push": False,
                # No CODEOWNERS file exists in this repo, which makes a
                # code-owner requirement inert — and with the owner as sole
                # maintainer it would hard-block their own PRs (no
                # self-approval). Left off deliberately.
                "require_code_owner_review": False,
                "require_last_push_approval": False,
                "required_review_thread_resolution": False,
                "allowed_merge_methods": ["merge", "squash", "rebase"],
            },
        },
        {
            "type": "required_status_checks",
            "parameters": {
                "required_status_checks": [
                    {"context": c, "integration_id": app_id} for c in contexts
                ],
                # False: don't force contributors to rebase onto every develop
                # commit before merging. develop moves too often for that.
                "strict_required_status_checks_policy": False,
                "do_not_enforce_on_create": False,
            },
        },
    ],
}))
PY
)"

if [ -z "$RULESET_ID" ]; then
  echo "  none found — creating it."
  RULESET_ID="$(echo "$PAYLOAD" \
    | gh api -X POST "repos/$REPO/rulesets" --input - --jq '.id')"
  echo "  created ruleset id: $RULESET_ID"
else
  echo "  found ruleset id: $RULESET_ID — updating in place."
  echo "$PAYLOAD" | gh api -X PUT "repos/$REPO/rulesets/$RULESET_ID" --input - >/dev/null
fi

echo "Verifying ..."
FINAL="$(gh api "repos/$REPO/rulesets/$RULESET_ID")"

echo "$FINAL" | python3 -c '
import json, sys
rs = json.load(sys.stdin)
print("  target refs:", ", ".join(rs["conditions"]["ref_name"]["include"]))
print("  enforcement:", rs["enforcement"])
print("  rules:", ", ".join(sorted(r["type"] for r in rs["rules"])))
for r in rs["rules"]:
    if r["type"] == "pull_request":
        print("  required approvals:", r["parameters"]["required_approving_review_count"])
    if r["type"] == "required_status_checks":
        for c in r["parameters"]["required_status_checks"]:
            print("  required check:", c["context"])
print("  owner can bypass:", rs.get("current_user_can_bypass"))
'

# The admin-role id is asserted, not looked up (no roles endpoint for a
# user-owned repo), so confirm the bypass actually resolved for the caller —
# who is the repo admin. "never" here means ADMIN_ROLE_ID is wrong and the
# owner's direct pushes to develop are about to start failing.
BYPASS="$(echo "$FINAL" | python3 -c \
  'import json,sys; print(json.load(sys.stdin).get("current_user_can_bypass"))')"
if [ "$BYPASS" != "always" ]; then
  echo "" >&2
  echo "WARNING: current_user_can_bypass=$BYPASS (expected 'always')." >&2
  echo "The admin role id ($ADMIN_ROLE_ID) did not resolve to a bypass for the" >&2
  echo "repo owner. Direct pushes to develop will be blocked until this is" >&2
  echo "fixed — compare against the working ids in the 'mahsan_bypass' ruleset:" >&2
  echo "  gh api repos/$REPO/rulesets --jq '.[].id' | xargs -I{} gh api repos/$REPO/rulesets/{} --jq '{name, bypass_actors}'" >&2
  exit 1
fi

echo "Done. develop now requires CI + Security Audit green and 1 approval for"
echo "anyone without the admin role."
