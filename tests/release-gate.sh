#!/usr/bin/env bash
# release-gate.sh: everything a release must pass, run BEFORE pushing it.
#
#   bash tests/release-gate.sh
#
# The ship level of tests/check.sh (see its header for what it runs): the
# hook's release tier, Go with Redis, shellcheck and every end-to-end suite,
# compared with origin/main. When every check passes it records the exact tree
# it tested in .git/mdnest-release-gate, and the pre-push hook accepts a push
# to main or release/* only for that tree. Kept under this name because the
# hook, md-ship and the release docs all point here; it never runs less than
# the full gate.
exec bash "$(dirname "$0")/check.sh" --level ship "$@"
