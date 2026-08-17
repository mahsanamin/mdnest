# Kubernetes (Helm)

*Available from v3.11.7. Optional — Docker Compose remains the primary, fully-supported install.*

Most people should use the Compose install described in [setup.md](setup.md): one host, one config file, `./mdnest-server start`. It's the deployment mdnest is designed around, and nothing about it changed when the chart was added.

The Helm chart exists for the case where you already run a cluster and want mdnest to live in it like everything else — same ingress, same TLS issuer, same secret management, same backup story. If that isn't you, skip this page.

## What it deploys

Plain Kubernetes resources — no CRDs, no operator:

- **Backend** — the Go API and WebSocket server (`8080`). A single StatefulSet by default; in the git-native HA topology it splits into N stateless **app** replicas plus one **writer** replica (see [Git-native HA](#git-native-ha-and-durability-rpo)).
- **Frontend** — nginx serving the SPA and proxying `/api` and `/api/ws` (`80`)
- **MCP server** *(opt-in)* — a streamable-HTTP Model Context Protocol endpoint for AI clients, with optional per-user OAuth
- **git-sync sidecar** *(opt-in)* — mirrors the notes repo to a git remote (mutually exclusive with `storage.backend=git`, which owns commits itself)
- Ingress, TLS, PVCs, probes, resource limits, ServiceAccount, PodDisruptionBudget

PostgreSQL and Redis are **never bundled** — point the chart at external or managed instances. Postgres backs `multi` mode; Redis backs live-collaboration scaling and the git-native HA coherence tier.

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

## What's supported

- `single` and `multi` mode, ingress, and TLS.
- Live collaboration, with an optional **Redis backplane** for active/active — multiple backend replicas whose presence and edits stay in sync.
- **Task board** (opt-in) — set `taskBoard.enabled=true` to enable the per-namespace kanban (`ENABLE_TASK_BOARD`). Off by default and independent of `auth.mode`; while off the board routes are not registered and the UI chunk is never loaded.
- **Excalidraw drawings** (opt-in) — set `excalidraw.enabled=true` to open `.excalidraw.md` notes on a drawing canvas (`ENABLE_EXCALIDRAW`). Off by default and independent of `auth.mode`; while off the editor chunk is never loaded. Preload shared shape libraries with `excalidraw.libraries` (a list of `.excalidrawlib` URLs). See [docs/excalidraw.md](excalidraw.md).
- Storage backends: **`local`** (default — the notes PVC) and **`git`** (in-process git history, one repo per namespace). Add `REDIS_URL` to the `git` backend for the horizontally-scaled [git-native HA topology](#git-native-ha-and-durability-rpo).
- **MCP server** over streamable-HTTP with optional per-user OAuth.
- **git-sync** sidecar — mutually exclusive with `storage.backend=git` (both commit to the working tree, so the chart makes you pick one).

`storage.backend` accepts `local` and `git`; any other value is refused at install time — the chart's values surface never outruns the code.

## Notes storage

Notes are files. The **`local`** backend (default) keeps them on the notes PVC and treats it like a bind mount: `git log` is your history, `cp -r` is your backup, and a `kubectl exec` into the pod gives you a normal directory of `.md` files.

The **`git`** backend keeps the same on-disk layout but owns the git history in-process (one repo per namespace), so it replaces the git-sync sidecar. On a single replica it's synchronous — a write is on disk before the response returns. Add `REDIS_URL` to scale it out; see [Git-native HA](#git-native-ha-and-durability-rpo).

Namespaces come from directories on the volume — there's no runtime namespace creation, matching the Compose install.

## Git-native HA and durability (RPO)

Setting `storage.backend=git` **with** `REDIS_URL` turns on the active/active topology: the notes tree lives in per-namespace git repos owned by a single **writer** replica (a StatefulSet with its own PVC), and the stateless **app** replicas (a Deployment, `MDNEST_ROLE=app`) serve reads from a Redis **working set** and hand writes to the writer over a Redis **durability queue**. `storage.backend=git` *without* `REDIS_URL` stays the single-box, in-process committer — synchronous, no queue.

Understand the durability contract before choosing this topology, because it moves the boundary of "your save is safe":

- **An acknowledged save can be lost.** On an app replica, `PUT /api/note` returns success once the write is on the Redis queue — *not* once the writer has committed it to git. If Redis loses that entry before the writer drains it, the user saw a successful save and the note is gone. The window is the queue-drain latency: sub-second in steady state, longer while the writer is down or failing over. That window is the RPO of this topology. A single-box install, or `storage.backend=git` without Redis, has an RPO of zero — the bytes are on disk before the response returns.

- **Redis is a durability component here, not a cache.** Between the ack and the writer applying the op, the Redis queue is the *only* copy of that change. So **run Redis with AOF persistence** (`appendonly yes`, `appendfsync everysec` at least) for this topology: the working-set cache would survive a Redis rebuild by rehydrating from the git tree, but the *unflushed queue* would not — a Redis restart in that window is real data loss. This is a deliberate trade for horizontal scale without ReadWriteMany storage; make it knowingly. (Note this is a stronger requirement than the presence/event backplane role Redis plays for live collaboration, where a lost event only costs a reconnect.)

The opt-in mirror (`storage.git.remote.url`) pushes each namespace repo to an external git host, so the durable tree also exists off-cluster — a copy independent of the writer's PVC.

## Upgrades

`helm upgrade` with the new chart version. Image tags default to the chart's `appVersion`, which tracks the mdnest release, so upgrading the chart upgrades mdnest. Pin explicitly with `image.backend.tag` / `image.frontend.tag` if you'd rather control that yourself.

The backend runs as a StatefulSet, so each pod's notes volume has a stable identity across restarts. Upgrading a pre-`0.2.0` (Deployment-based) release must adopt the old notes PVC via `persistence.notes.existingClaim: <release>-notes`, otherwise Helm deletes the old volume and the StatefulSet provisions an empty one. The install-time `validateUpgrade` guard refuses a CLI upgrade that would hit this and names the value to set; a GitOps render won't trigger the guard, so the same note lives in `values.yaml`.
