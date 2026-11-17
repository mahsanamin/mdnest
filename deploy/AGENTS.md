# Install and deploy (`deploy/`, `setup.sh`, Dockerfiles)

The default install is `mdnest.conf` -> `setup.sh` -> generated
`docker-compose.yml` + `.env`. `deploy/` holds a plain compose example and the
optional Helm chart (`docs/kubernetes.md`).

- **Namespaces come from mounts**: `MOUNT_<name>=<host_path>` in `mdnest.conf`
  becomes a volume in the generated compose. Never create namespaces at runtime.
- **A new config knob must reach `.env`** and be tested (see
  `tests/setup-*.sh`): the backend silently ignores env it does not read, so
  broken plumbing looks like "off".
- **A config option must not exist before its code.** Guard unsupported Helm
  values in `mdnest.validateSupported`
  (`deploy/helm/mdnest/templates/_helpers.tpl`) so install fails with a reason,
  and delete the guard in the change that lands the feature.
- **The default install must not grow** for a feature that is off: no new
  service, required env var or dependency in `setup.sh`, `mdnest.conf.sample` or
  the Dockerfiles unless the feature is on.
- Backend image: tini is PID 1 (`ENTRYPOINT ["/sbin/tini", "--"]`). Keep it if
  you override the command in compose or Helm (`tests/backend-image-init.sh`).
- Frontend image: node:20-alpine build, nginx:alpine serve; nginx proxies
  `/api/`, SPA fallback to `index.html`, but `/assets/` and `/cli/` 404 on a
  miss. The CLI is copied in through the named build context `cli`.
- git-sync is optional (on when keys exist in `git-sync/keys/`); Postgres is
  added only when `AUTH_MODE=multi`.
- Helm chart: `appVersion` tracks the app version; `version` is the chart's own
  and moves only when templates change.
