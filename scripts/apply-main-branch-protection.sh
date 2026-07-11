#!/usr/bin/env bash
#
# apply-main-branch-protection.sh
#
# Enforce the "Security Audit must pass before merge to main" gate.
#
# WHY THIS EXISTS
# ---------------
# The Security Audit workflow (.github/workflows/security-audit.yml) already
# runs on every pull_request targeting main. But *running* is not *requiring*:
# unless the `main-branch` repository ruleset lists those job checks as
# REQUIRED status checks, a red or pending check does not block the merge
# (the PR shows mergeStateStatus=UNSTABLE and merges anyway). That gap let a
# crypto/tls stdlib vuln (GO-2026-5856) land on main via the v3.11.5 release —
# CI caught it only on the post-merge push.
#
# This script adds a `required_status_checks` rule to the `main-branch`
# ruleset so all four Security Audit jobs must be green before anything
# merges to main. The `main-branch` ruleset has no bypass actors
# (current_user_can_bypass: never), so the gate binds even the repo owner —
# `gh pr merge` will refuse until the checks pass. Direct pushes to main are
# already blocked by that ruleset's pull_request rule.
#
# REQUIREMENTS
# ------------
#   - gh CLI authenticated with a token that has repository "Administration"
#     write permission (a fine-grained PAT needs Administration: Read+Write;
#     the default contents/PR-scoped token returns HTTP 403 on ruleset PUT).
#   - jq is NOT required; this uses python3 for the JSON surgery.
#
# USAGE
# -----
#   scripts/apply-main-branch-protection.sh            # apply to mahsanamin/mdnest
#   REPO=owner/name scripts/apply-main-branch-protection.sh
#
# Idempotent: re-running replaces any existing required_status_checks rule
# with exactly the set below.

set -euo pipefail

REPO="${REPO:-mahsanamin/mdnest}"
RULESET_NAME="main-branch"

# The check "context" strings must match the GitHub Actions job `name:` values
# in .github/workflows/security-audit.yml exactly — a mismatch creates an
# "Expected" check that never reports and blocks main forever.
CONTEXTS=(
  "Frontend (npm audit)"
  "MCP Server (npm audit)"
  "Backend (govulncheck)"
  "Shell scripts (shellcheck)"
)
GITHUB_ACTIONS_APP_ID=15368  # the "GitHub Actions" app; pins the check to Actions

echo "Locating '$RULESET_NAME' ruleset on $REPO ..."
RULESET_ID="$(gh api "repos/$REPO/rulesets" \
  --jq ".[] | select(.name == \"$RULESET_NAME\") | .id")"
if [ -z "$RULESET_ID" ]; then
  echo "ERROR: no ruleset named '$RULESET_NAME' on $REPO." >&2
  echo "Create a branch ruleset targeting the default branch first, then re-run." >&2
  exit 1
fi
echo "  ruleset id: $RULESET_ID"

CURRENT="$(gh api "repos/$REPO/rulesets/$RULESET_ID")"

PAYLOAD="$(CONTEXTS_JSON="$(printf '%s\n' "${CONTEXTS[@]}")" \
  APP_ID="$GITHUB_ACTIONS_APP_ID" python3 - "$CURRENT" <<'PY'
import json, os, sys
rs = json.loads(sys.argv[1])
contexts = [c for c in os.environ["CONTEXTS_JSON"].splitlines() if c]
app_id = int(os.environ["APP_ID"])
rules = [r for r in rs["rules"] if r.get("type") != "required_status_checks"]
rules.append({
    "type": "required_status_checks",
    "parameters": {
        "required_status_checks": [
            {"context": c, "integration_id": app_id} for c in contexts
        ],
        "strict_required_status_checks_policy": False,
        "do_not_enforce_on_create": False,
    },
})
print(json.dumps({
    "name": rs["name"],
    "target": rs["target"],
    "enforcement": rs["enforcement"],
    "bypass_actors": rs.get("bypass_actors", []),
    "conditions": rs["conditions"],
    "rules": rules,
}))
PY
)"

echo "Applying required status checks: ${CONTEXTS[*]}"
echo "$PAYLOAD" | gh api -X PUT "repos/$REPO/rulesets/$RULESET_ID" --input - >/dev/null

echo "Verifying ..."
gh api "repos/$REPO/rulesets/$RULESET_ID" --jq \
  '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' \
  | sed 's/^/  required: /'

echo "Done. main now requires the Security Audit checks to pass before merge."
