# Tests

Everything runs locally with Docker; no CI access is needed. The full guide,
suite by suite, is `docs/dev/testing.md`.

## Pick the level

| Level | When | Command |
|---|---|---|
| iterate | while working | `bash tests/check.sh --level iterate` with `MDNEST_E2E_SPECS="spec-a.spec.js ..."` (add `MDNEST_E2E_HARNESS=collab` for two-user specs) |
| develop | before the PR / merge into `develop` | `bash tests/check.sh --level develop` |
| ship | release only | `bash tests/release-gate.sh` |

`develop` picks the end-to-end suites from the files you changed since
`origin/develop`. A spec whose flake you just fixed gets
`MDNEST_E2E_ARGS="--repeat-each 3"`.

## Which test goes with which change

| You changed | Add or run |
|---|---|
| Go code | `go test -race` in the package; multi-mode access: `tests/e2e-*-multi.sh` |
| frontend logic | a vitest case in `frontend/src/__tests__/` |
| UI behavior | a Playwright spec in `tests/browser/` |
| `mdnest` CLI | `tests/cli-unit.sh` (pure helpers), `tests/cli-smoke-test.sh` (behavior) |
| `mdnest-server` | `tests/server-unit.sh` |
| `setup.sh` / config knobs | a `tests/setup-*.sh` check that the value reaches `.env` |
| collab, save paths, Live editor | `tests/e2e-collab-multi.sh` |

## Rules

- A bug fix comes with a test that fails without the fix.
- A spec that creates files cleans them up (one folder per test, deleted in
  `afterEach`); leftovers break later specs.
- A test that destroys per-user data must refuse to run against a real account
  (see the guard in `tests/browser/stickies.spec.js`).
- Playwright runs with `colorScheme: 'dark'`; a theme-specific spec sets it with
  `page.emulateMedia()`.
- A test that compares a duration with a fixed number is tagged `@budget`, and
  the code it times goes in `BUDGET_CODE_PAT` in `tests/check.sh`.
- Run CLI tests with the repo's `./mdnest`, not an installed `mdnest`.
- `tests/browser/` contains only specs; all output goes to `tests/browser-results/`.
