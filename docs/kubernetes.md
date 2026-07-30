# Kubernetes (Helm)

*Available from v3.11.7. Optional — Docker Compose remains the primary, fully-supported install.*

Most people should use the Compose install described in [setup.md](setup.md): one host, one config file, `./mdnest-server start`. It's the deployment mdnest is designed around, and nothing about it changed when the chart was added.

The Helm chart exists for the case where you already run a cluster and want mdnest to live in it like everything else — same ingress, same TLS issuer, same secret management, same backup story. If that isn't you, skip this page.

## What it deploys

Plain Kubernetes resources — no CRDs, no operator:

- **Backend** — the Go API and WebSocket server (`8080`)
- **Frontend** — nginx serving the SPA and proxying `/api` and `/api/ws` (`80`)
- **git-sync sidecar** *(opt-in)* — mirrors the notes repo to a git remote
- Ingress, TLS, PVCs, probes, resource limits, ServiceAccount, PodDisruptionBudget

PostgreSQL is **never bundled**. In `multi` mode you point the chart at an external or managed instance, the same as the Compose install expects.

The chart's own reference — every value, with defaults — lives at [`deploy/helm/mdnest/README.md`](https://github.com/mahsanamin/mdnest/blob/main/deploy/helm/mdnest/README.md).

## Install

Charts and images are published to GHCR on each release tag:

```bash
helm install mdnest oci://ghcr.io/mahsanamin/charts/mdnest \
  --namespace mdnest --create-namespace \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=notes.example.com
```

Or from a checkout:

```bash
helm install mdnest ./deploy/helm/mdnest --namespace mdnest --create-namespace
```

Multi-user mode with an external PostgreSQL:

```bash
helm install mdnest oci://ghcr.io/mahsanamin/charts/mdnest \
  --namespace mdnest --create-namespace \
  --set auth.mode=multi \
  --set postgres.host=pg.databases.svc \
  --set postgres.password=… \
  --set collab.enabled=true
```

## What's supported in this release

Single-replica `single` or `multi` mode, live collaboration, git-sync, ingress, and TLS.

Three options are present in `values.yaml` and documented, but the chart **refuses to install** if you set them, because the code behind them isn't in this release:

| Option | Why it's rejected |
|---|---|
| `storage.backend=s3` | The backend reads notes from the filesystem and ignores `S3_*` — notes would be written to the PVC while the install looked configured for your bucket. |
| `collab.redis.*` | There is no presence/event backplane, so replicas would diverge instead of syncing. |
| `mcp.enabled=true` | The bundled MCP server speaks stdio only; the Service and Ingress would route to a port nothing listens on. |

`backend.replicaCount > 1` is rejected for the same reason — active/active needs the backplane. **Run one backend replica.**

This is deliberate. A setting the backend silently ignores doesn't fail, it lies: the deployment reports `Ready` while doing the wrong thing with your notes. Failing at install time with a message naming what's missing is the honest behaviour. Each guard is removed in the release that lands the capability behind it.

To run the MCP server today, run it next to your AI client over stdio — see [the MCP section of the README](https://github.com/mahsanamin/mdnest#mcp-server-ai-agents).

## Notes storage

Notes are files, in Kubernetes as much as anywhere else. The chart provisions a PVC (`persistence.notes`) and the backend treats it exactly as it treats a bind mount: `git log` is your history, `cp -r` is your backup, and a `kubectl exec` into the pod gives you a normal directory of `.md` files.

Namespaces still come from directories on that volume — there's no runtime namespace creation, matching the Compose install.

## Git-native HA and durability (RPO)

Setting `storage.backend=git` **with** `REDIS_URL` turns on the active/active topology: the notes tree lives in per-namespace git repos owned by a single **writer** replica (a StatefulSet with its own PVC), and the stateless **app** replicas (a Deployment, `MDNEST_ROLE=app`) serve reads from a Redis **working set** and hand writes to the writer over a Redis **durability queue**. `storage.backend=git` *without* `REDIS_URL` stays the single-box, in-process committer — synchronous, no queue.

Understand the durability contract before choosing this topology, because it moves the boundary of "your save is safe":

- **An acknowledged save can be lost.** On an app replica, `PUT /api/note` returns success once the write is on the Redis queue — *not* once the writer has committed it to git. If Redis loses that entry before the writer drains it, the user saw a successful save and the note is gone. The window is the queue-drain latency: sub-second in steady state, longer while the writer is down or failing over. That window is the RPO of this topology. A single-box install, or `storage.backend=git` without Redis, has an RPO of zero — the bytes are on disk before the response returns.

- **Redis is a durability component here, not a cache.** Between the ack and the writer applying the op, the Redis queue is the *only* copy of that change. So **run Redis with AOF persistence** (`appendonly yes`, `appendfsync everysec` at least) for this topology: the working-set cache would survive a Redis rebuild by rehydrating from the git tree, but the *unflushed queue* would not — a Redis restart in that window is real data loss. This is a deliberate trade for horizontal scale without ReadWriteMany storage; make it knowingly. (Note this is a stronger requirement than the presence/event backplane role Redis plays for live collaboration, where a lost event only costs a reconnect.)

The opt-in mirror (`storage.git.remote.url`) pushes each namespace repo to an external git host, so the durable tree also exists off-cluster — a copy independent of the writer's PVC.

## Upgrades

`helm upgrade` with the new chart version. Image tags default to the chart's `appVersion`, which tracks the mdnest release, so upgrading the chart upgrades mdnest. Pin explicitly with `image.backend.tag` / `image.frontend.tag` if you'd rather control that yourself.

Because a single backend replica is the supported topology, the backend Deployment uses the `Recreate` strategy by default — the pod stops before the new one starts, so two pods never hold the same notes volume at once.
