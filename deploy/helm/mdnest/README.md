# mdnest

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 3.11.6](https://img.shields.io/badge/AppVersion-3.11.6-informational?style=flat-square)

mdnest — self-hosted Markdown knowledge base with live collaboration.
Standard-Kubernetes chart (no CRDs). PostgreSQL and Redis are expected to be
provided externally. Defaults to a single-instance (active/passive)
deployment; horizontal scaling (active/active) is strictly opt-in.

**Homepage:** <https://github.com/mahsanamin/mdnest>

A standard-Kubernetes Helm chart (no CRDs) that deploys [mdnest](https://github.com/mahsanamin/mdnest) — a self-hosted Markdown knowledge base with real-time collaboration.

- **Backend** — Go API + WebSocket collaboration server (port `8080`).
- **Frontend** — nginx serving the SPA and reverse-proxying `/api` and `/api/ws` to the backend (port `80`).
- **MCP server** *(opt-in)* — exposes mdnest over the Model Context Protocol via streamable-HTTP.
- **git-sync sidecar** *(opt-in)* — mirrors the notes repository to a git remote.

PostgreSQL and Redis are **never bundled**: point the chart at external/managed instances.

> [!IMPORTANT]
> **Not every option below is available yet.** The chart is versioned with mdnest,
> and two opt-in capabilities documented here are not implemented in this
> release — the chart **refuses to install** rather than come up "healthy" while
> doing the wrong thing:
>
> | Option | Why it is rejected |
> |---|---|
> | `storage.backend=s3` | The backend reads notes from the filesystem and ignores `S3_*`; notes would land on the PVC, not your bucket. |
> | `mcp.enabled=true` | The bundled MCP server speaks stdio only; the Service and Ingress would route to a port nothing listens on. |
>
> **Supported today:** `single` or `multi` mode, live collaboration, git-sync,
> ingress, TLS, and active/active (`backend.replicaCount > 1`) with a Redis
> backplane and ReadWriteMany storage.

## Deployment models

Single instance is the default and matches upstream mdnest exactly. The horizontally-scaled column is opt-in: it requires a Redis backplane and ReadWriteMany storage, which `validateHA` enforces at install time.

| | Single instance (default) | Horizontally scaled (opt-in) |
|---|---|---|
| `auth.mode` | `single` (file auth, no DB) | `multi` (external PostgreSQL) |
| `backend.replicaCount` | `1` | `> 1` |
| `backend.strategy.type` | `Recreate` | `RollingUpdate` |
| Live collaboration | off | `collab.enabled=true` |
| Cross-replica sync | n/a | Redis (`collab.redis.*`) |
| Notes storage | `local` PVC (RWO) | RWX PVC **or** `storage.backend=s3` |

The chart **validates these invariants and fails fast** with a clear message if a multi-replica deployment is missing PostgreSQL, Redis, collaboration, or shared (RWX/S3) storage.

## TL;DR

```bash
# Single-instance, from the packaged OCI chart
helm install mdnest oci://ghcr.io/mahsanamin/charts/mdnest \
  --set auth.password='change-me' \
  --set auth.jwtSecret='another-long-random-secret' \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=mdnest.example.com \
  --set backend.frontendOrigin=https://mdnest.example.com
```

> Prefer a values file and Secrets over `--set` for anything sensitive (see below).

## Installing

```bash
helm install mdnest oci://ghcr.io/mahsanamin/charts/mdnest -f my-values.yaml
# or from a local checkout
helm install mdnest ./deploy/helm/mdnest -f my-values.yaml
```

Uninstall:

```bash
helm uninstall mdnest
```

PVCs are retained on uninstall — delete them manually if you want to discard the notes/secrets data.

## Configuration guide

### Credentials & Secrets

Never commit real credentials to a values file. For every secret the chart accepts **either** an inline value (fine for local testing) **or** a reference to an existing Secret (recommended for production, e.g. one synced from Vault by an ExternalSecret):

| Concern | Inline | Existing Secret |
|---|---|---|
| Admin / JWT | `auth.password`, `auth.jwtSecret` | `auth.existingSecret` (+ `auth.secretKeys`) |
| PostgreSQL | `postgres.password` | `postgres.existingSecret` |
| Redis | `collab.redis.url` | `collab.redis.existingSecret` or `collab.redis.passwordSecret` |
| SSO | `sso.clientSecret` | `sso.existingSecret` |
| S3 | `storage.s3.accessKey/secretKey` | `storage.s3.existingSecret` |
| MCP token | `mcp.auth.token` | `mcp.auth.existingSecret` |
| MCP OAuth | `mcp.oauth.secret.value` | `mcp.oauth.secret.existingSecret` |

When an `existingSecret` is set, the chart-managed Secret does not carry those keys and inline values are ignored.

### Multi-user + PostgreSQL

```yaml
auth:
  mode: multi
  existingSecret: mdnest-auth          # provides MDNEST_JWT_SECRET
postgres:
  host: pg-primary.databases.svc
  database: mdnest
  user: mdnest
  existingSecret: mdnest-postgres      # provides POSTGRES_PASSWORD
```

### Live collaboration + Redis (active/active)

Enable collaboration and give every replica a shared Redis backplane so presence/edits sync across pods:

```yaml
backend:
  replicaCount: 3
  strategy:
    type: RollingUpdate
collab:
  enabled: true
  redis:
    url: rediss://:password@redis.databases.svc:6379/0
```

For managed Redis that only exposes a password (KubeBlocks, ElastiCache), use *compose mode* — the chart builds `REDIS_URL` from parts:

```yaml
collab:
  enabled: true
  redis:
    host: mdnest-redis-redis.databases.svc
    tls: true
    passwordSecret:
      name: mdnest-redis-account-default
      key: password
```

### Storage backend (local vs S3)

`storage.backend=local` (default) keeps notes on the `notes` PVC — byte-identical to upstream. Set `storage.backend=s3` to store notes in an S3-compatible bucket, which lets multiple replicas share notes **without** ReadWriteMany storage and enables self-service namespace creation:

```yaml
storage:
  backend: s3
  s3:
    endpoint: s3.fr-par.scw.cloud      # no scheme
    bucket: mdnest-notes
    region: fr-par
    pathStyle: true                    # required for MinIO / Ceph RGW
    existingSecret: mdnest-s3          # provides S3_ACCESS_KEY / S3_SECRET_KEY
persistence:
  notes:
    enabled: false                     # no notes PVC needed with S3
```

> Note *history* (git) and the git-sync sidecar always use the local filesystem and are orthogonal to this setting.

### Shared storage for active/active (local backend)

If you stay on the `local` backend but scale out, both PVCs must be `ReadWriteMany`:

```yaml
persistence:
  notes:
    accessMode: ReadWriteMany
    storageClass: nfs
  secrets:
    accessMode: ReadWriteMany
    storageClass: nfs
```

### SSO / OIDC

```yaml
sso:
  enabled: true
  issuerUrl: https://idp.example.com
  clientId: mdnest
  allowedDomains: example.com
  adminEmails: alice@example.com
  existingSecret: mdnest-sso           # provides SSO_CLIENT_SECRET
backend:
  frontendOrigin: https://mdnest.example.com
```

`sso.redirectUrl` defaults to `<backend.frontendOrigin>/api/auth/sso/callback`.

### MCP server

Opt-in Model Context Protocol endpoint. See the dedicated MCP docs in the app repository for client configuration. Minimal service-token setup:

```yaml
mcp:
  enabled: true
  auth:
    existingSecret: mdnest-mcp-token   # key: token (an mdnest_... API token)
  ingress:
    enabled: true
    hosts:
      - host: mcp.example.com
        paths: [{ path: /, pathType: Prefix }]
```

For per-user attribution, enable `mcp.oauth.enabled=true` and set `mcp.oauth.publicUrl` + `mcp.oauth.ssoAuthorizeUrl` (requires SSO).

### git-sync

```yaml
gitSync:
  enabled: true
  intervalSeconds: 600
  author: { name: mdnest, email: mdnest@example.com }
  sshSecretName: mdnest-gitsync-keys   # create yourself; SSH deploy key(s)
```

### Ingress

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: mdnest.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - secretName: mdnest-tls
      hosts: [mdnest.example.com]
```

All traffic goes to the frontend Service, which proxies `/api` and `/api/ws` (WebSocket upgrades pass through nginx).

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| auth | object | `{"adminUser":"admin","existingSecret":"","jwtSecret":"","mode":"single","password":"","secretKeys":{"jwtSecret":"MDNEST_JWT_SECRET","password":"MDNEST_PASSWORD"}}` | --------------------------------------------------------------------------- |
| auth.adminUser | string | `"admin"` | Bootstrap admin username for single mode (`MDNEST_USER`). Ignored in multi mode. |
| auth.existingSecret | string | `""` | Existing Secret holding credentials. When set, the chart-managed Secret is not created and inline values are ignored. |
| auth.jwtSecret | string | `""` | Inline JWT signing secret (used only when `existingSecret` is empty). CHANGE THIS. |
| auth.mode | string | `"single"` | Authentication mode: `single` (file-based, no DB) or `multi` (PostgreSQL-backed, required for HA). |
| auth.password | string | `""` | Inline admin password (used only when `existingSecret` is empty). CHANGE THIS. |
| auth.secretKeys | object | `{"jwtSecret":"MDNEST_JWT_SECRET","password":"MDNEST_PASSWORD"}` | Keys expected inside `existingSecret`. |
| backend | object | `{"affinity":{},"autoscaling":{"enabled":false,"maxReplicas":4,"minReplicas":2,"targetCPUUtilizationPercentage":75,"targetMemoryUtilizationPercentage":""},"disableUpdateCheck":false,"extraEnv":[],"frontendOrigin":"http://localhost","livenessProbe":{"enabled":true,"failureThreshold":3,"initialDelaySeconds":10,"periodSeconds":20,"timeoutSeconds":3},"namespaceInitImage":"busybox:1.36","namespaces":[],"nodeSelector":{},"podAnnotations":{},"podLabels":{},"podSecurityContext":{"runAsNonRoot":false},"readinessProbe":{"enabled":true,"failureThreshold":3,"initialDelaySeconds":5,"periodSeconds":10,"timeoutSeconds":3},"replicaCount":1,"resources":{"limits":{"memory":"512Mi"},"requests":{"cpu":"50m","memory":"64Mi"}},"securityContext":{},"serverAlias":"","service":{"port":8080,"type":"ClusterIP"},"strategy":{"type":"Recreate"},"tolerations":[]}` | --------------------------------------------------------------------------- |
| backend.affinity | object | `{}` | Affinity rules for the backend. |
| backend.autoscaling | object | `{"enabled":false,"maxReplicas":4,"minReplicas":2,"targetCPUUtilizationPercentage":75,"targetMemoryUtilizationPercentage":""}` | Optional HorizontalPodAutoscaler (active/active only — requires RWX storage + Redis). |
| backend.disableUpdateCheck | bool | `false` | Disable the periodic GitHub release update check (`DISABLE_UPDATE_CHECK`). |
| backend.extraEnv | list | `[]` | Extra backend environment variables (list of `{name,value}` or `{name,valueFrom}`). |
| backend.frontendOrigin | string | `"http://localhost"` | Public origin the browser uses to reach mdnest (CORS + SSO redirect URL). Set to your ingress URL in production. |
| backend.livenessProbe | object | `{"enabled":true,"failureThreshold":3,"initialDelaySeconds":10,"periodSeconds":20,"timeoutSeconds":3}` | Liveness probe (hits the unauthenticated `GET /api/config`). |
| backend.namespaceInitImage | string | `"busybox:1.36"` | Image used by the namespace-provisioning init container. |
| backend.namespaces | list | `[]` | Top-level namespaces to ensure exist under `/data/notes` on startup (idempotent init container). Empty disables it. Names must not contain `/` or `\` nor start with `.`. |
| backend.nodeSelector | object | `{}` | Node selector for the backend. |
| backend.podAnnotations | object | `{}` | Extra pod annotations for the backend. |
| backend.podLabels | object | `{}` | Extra pod labels for the backend. |
| backend.podSecurityContext | object | `{"runAsNonRoot":false}` | Pod-level security context for the backend. |
| backend.readinessProbe | object | `{"enabled":true,"failureThreshold":3,"initialDelaySeconds":5,"periodSeconds":10,"timeoutSeconds":3}` | Readiness probe (hits the unauthenticated `GET /api/config`). |
| backend.replicaCount | int | `1` | Number of backend replicas. Keep at `1` unless running active/active (see top-of-file notes). |
| backend.resources | object | `{"limits":{"memory":"512Mi"},"requests":{"cpu":"50m","memory":"64Mi"}}` | Backend resource requests/limits. |
| backend.securityContext | object | `{}` | Container-level security context for the backend. |
| backend.serverAlias | string | `""` | Optional display alias shown in the UI (`SERVER_ALIAS`). |
| backend.service.port | int | `8080` | Backend Service port. |
| backend.service.type | string | `"ClusterIP"` | Backend Service type. |
| backend.strategy.type | string | `"Recreate"` | Deployment strategy. `Recreate` is required with ReadWriteOnce volumes; use `RollingUpdate` only with ReadWriteMany storage (active/active). |
| backend.tolerations | list | `[]` | Tolerations for the backend. |
| collab | object | `{"enabled":false,"redis":{"database":0,"existingSecret":"","host":"","passwordSecret":{"key":"password","name":""},"port":6379,"secretKeys":{"url":"REDIS_URL"},"tls":false,"url":"","username":"default"}}` | --------------------------------------------------------------------------- |
| collab.enabled | bool | `false` | Enable live collaboration (`ENABLE_LIVE_COLLAB`; requires `auth.mode=multi`). |
| collab.redis.database | int | `0` | Redis database index (compose mode). |
| collab.redis.existingSecret | string | `""` | Existing Secret to source `REDIS_URL` from instead of inline `url`. |
| collab.redis.host | string | `""` | Compose mode: when set, the chart BUILDS `REDIS_URL` from discrete parts and reads the password from `passwordSecret`. Takes precedence over `url`/`existingSecret`. Use with managed Redis (KubeBlocks, ElastiCache). |
| collab.redis.passwordSecret | object | `{"key":"password","name":""}` | Secret holding the Redis password in compose mode. |
| collab.redis.port | int | `6379` | Redis port (compose mode). |
| collab.redis.secretKeys | object | `{"url":"REDIS_URL"}` | Key inside `existingSecret` holding the URL. |
| collab.redis.tls | bool | `false` | Use TLS (`rediss://`) in compose mode. |
| collab.redis.url | string | `""` | Full Redis URL, e.g. `redis://:password@my-redis:6379/0` (or `rediss://` for TLS). Empty = single instance. |
| collab.redis.username | string | `"default"` | Redis username (compose mode). |
| commonAnnotations | object | `{}` | Annotations added to every resource created by the chart. |
| commonLabels | object | `{}` | Labels added to every resource created by the chart. |
| frontend | object | `{"affinity":{},"env":[],"nodeSelector":{},"podAnnotations":{},"podLabels":{},"podSecurityContext":{},"replicaCount":1,"resources":{"limits":{"memory":"128Mi"},"requests":{"cpu":"10m","memory":"16Mi"}},"securityContext":{},"service":{"port":80,"type":"ClusterIP"},"tolerations":[],"wsTimeoutSeconds":86400}` | --------------------------------------------------------------------------- |
| frontend.affinity | object | `{}` | Affinity rules for the frontend. |
| frontend.env | list | `[]` | Extra nginx env vars. Set `NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE=1` with a CPU limit to avoid nginx spawning one worker per host CPU (OOM risk). |
| frontend.nodeSelector | object | `{}` | Node selector for the frontend. |
| frontend.podAnnotations | object | `{}` | Extra pod annotations for the frontend. |
| frontend.podLabels | object | `{}` | Extra pod labels for the frontend. |
| frontend.podSecurityContext | object | `{}` | Pod-level security context for the frontend. |
| frontend.replicaCount | int | `1` | Number of frontend (nginx) replicas. |
| frontend.resources | object | `{"limits":{"memory":"128Mi"},"requests":{"cpu":"10m","memory":"16Mi"}}` | Frontend resource requests/limits. |
| frontend.securityContext | object | `{}` | Container-level security context for the frontend. |
| frontend.service.port | int | `80` | Frontend Service port. |
| frontend.service.type | string | `"ClusterIP"` | Frontend Service type. |
| frontend.tolerations | list | `[]` | Tolerations for the frontend. |
| frontend.wsTimeoutSeconds | int | `86400` | WebSocket proxy read/send timeout (seconds); keep long for live collaboration. |
| fullnameOverride | string | `""` | Fully override the generated fullname used for all resources. |
| gitSync | object | `{"affinity":{},"author":{"email":"mdnest@example.com","name":"mdnest"},"enabled":false,"image":{"pullPolicy":"IfNotPresent","repository":"alpine/git","tag":"latest"},"intervalSeconds":600,"nodeSelector":{},"resources":{"limits":{"memory":"64Mi"},"requests":{"cpu":"10m","memory":"16Mi"}},"sshSecretName":"","tolerations":[]}` | --------------------------------------------------------------------------- |
| gitSync.affinity | object | `{}` | Affinity rules for git-sync. |
| gitSync.author | object | `{"email":"mdnest@example.com","name":"mdnest"}` | Git commit author identity. |
| gitSync.enabled | bool | `false` | Enable the git-sync sidecar (mirrors the notes repo to a git remote). |
| gitSync.image | object | `{"pullPolicy":"IfNotPresent","repository":"alpine/git","tag":"latest"}` | git-sync sidecar image. |
| gitSync.intervalSeconds | int | `600` | Commit/push interval in seconds. |
| gitSync.nodeSelector | object | `{}` | Node selector for git-sync. |
| gitSync.resources | object | `{"limits":{"memory":"64Mi"},"requests":{"cpu":"10m","memory":"16Mi"}}` | git-sync resource requests/limits. |
| gitSync.sshSecretName | string | `""` | Name of a Secret with SSH deploy key(s), mounted read-only at `/keys`. Create it yourself; keys must never live in values. |
| gitSync.tolerations | list | `[]` | Tolerations for git-sync. |
| image.backend.repository | string | `"ghcr.io/mahsanamin/mdnest-backend"` | Backend image repository. |
| image.backend.tag | string | `""` | Backend image tag; defaults to `Chart.appVersion` when empty. |
| image.frontend.repository | string | `"ghcr.io/mahsanamin/mdnest-frontend"` | Frontend image repository. |
| image.frontend.tag | string | `""` | Frontend image tag; defaults to `Chart.appVersion` when empty. |
| image.mcp.repository | string | `"ghcr.io/mahsanamin/mdnest-mcp-server"` | MCP server image repository (used only when `mcp.enabled=true`). |
| image.mcp.tag | string | `""` | MCP server image tag; defaults to `Chart.appVersion` when empty. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy applied to all mdnest images. |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries (list of `{name}`). |
| ingress | object | `{"annotations":{},"className":"","enabled":false,"hosts":[{"host":"mdnest.local","paths":[{"path":"/","pathType":"Prefix"}]}],"tls":[]}` | --------------------------------------------------------------------------- |
| ingress.annotations | object | `{}` | Ingress annotations. |
| ingress.className | string | `""` | IngressClass name. |
| ingress.enabled | bool | `false` | Enable an Ingress routing all traffic to the frontend Service. |
| ingress.hosts | list | `[{"host":"mdnest.local","paths":[{"path":"/","pathType":"Prefix"}]}]` | Ingress hosts and paths. |
| ingress.tls | list | `[]` | Ingress TLS configuration. |
| mcp | object | `{"affinity":{},"auth":{"existingSecret":"","existingSecretKey":"token","token":""},"enabled":false,"extraEnv":[],"http":{"path":"/mcp","port":3000},"ingress":{"annotations":{},"className":"","enabled":false,"hosts":[],"tls":[]},"mdnestUrl":"","nodeSelector":{},"oauth":{"enabled":false,"publicUrl":"","secret":{"existingSecret":"","existingSecretKey":"oauth-secret","value":""},"ssoAuthorizeUrl":""},"podAnnotations":{},"podLabels":{},"podSecurityContext":{},"replicaCount":1,"resources":{},"securityContext":{},"service":{"port":3000,"type":"ClusterIP"},"tolerations":[]}` | --------------------------------------------------------------------------- |
| mcp.affinity | object | `{}` | Affinity rules for the MCP server. |
| mcp.auth | object | `{"existingSecret":"","existingSecretKey":"token","token":""}` | Service-token auth (used when `oauth.enabled=false`). Provide inline via `auth.token` or reference an existing Secret. |
| mcp.enabled | bool | `false` | Enable the MCP server (Model Context Protocol over streamable-HTTP). Adds a Deployment + Service (and optional Ingress). |
| mcp.extraEnv | list | `[]` | Extra environment variables appended to the MCP container. |
| mcp.http | object | `{"path":"/mcp","port":3000}` | MCP HTTP listen port and path. |
| mcp.ingress | object | `{"annotations":{},"className":"","enabled":false,"hosts":[],"tls":[]}` | Optional standard Ingress for the MCP endpoint (leave disabled if your cluster exposes it through its own ingress controller, e.g. a Traefik IngressRoute defined at the umbrella-chart level). |
| mcp.mdnestUrl | string | `""` | URL the MCP server uses to reach the backend API; defaults to the in-cluster backend Service when empty. |
| mcp.nodeSelector | object | `{}` | Node selector for the MCP server. |
| mcp.oauth | object | `{"enabled":false,"publicUrl":"","secret":{"existingSecret":"","existingSecretKey":"oauth-secret","value":""},"ssoAuthorizeUrl":""}` | Per-user OAuth 2.1 mode. When enabled the MCP server is an OAuth AS/RS and delegates login to mdnest SSO, attributing actions to the signed-in user. When disabled (default) the shared service token is used. |
| mcp.oauth.publicUrl | string | `""` | Public HTTPS base URL clients reach the MCP server on (no trailing slash). |
| mcp.oauth.secret | object | `{"existingSecret":"","existingSecretKey":"oauth-secret","value":""}` | HMAC secret signing OAuth cookies/codes. Provide inline via `secret.value` or reference an existing Secret. |
| mcp.oauth.ssoAuthorizeUrl | string | `""` | mdnest backend SSO start endpoint, e.g. `https://<host>/api/auth/sso/start`. |
| mcp.podAnnotations | object | `{}` | Extra pod annotations for the MCP server. |
| mcp.podLabels | object | `{}` | Extra pod labels for the MCP server. |
| mcp.podSecurityContext | object | `{}` | Pod-level security context for the MCP server. |
| mcp.replicaCount | int | `1` | Number of MCP server replicas. |
| mcp.resources | object | `{}` | MCP resource requests/limits. |
| mcp.securityContext | object | `{}` | Container-level security context for the MCP server. |
| mcp.service | object | `{"port":3000,"type":"ClusterIP"}` | MCP Service type/port. |
| mcp.tolerations | list | `[]` | Tolerations for the MCP server. |
| nameOverride | string | `""` | Override the chart name portion of generated resource names. |
| persistence | object | `{"notes":{"accessMode":"ReadWriteOnce","annotations":{},"enabled":true,"existingClaim":"","size":"5Gi","storageClass":""},"secrets":{"accessMode":"ReadWriteOnce","annotations":{},"enabled":true,"existingClaim":"","size":"256Mi","storageClass":""}}` | --------------------------------------------------------------------------- |
| persistence.notes.accessMode | string | `"ReadWriteOnce"` | Access mode; must be `ReadWriteMany` for active/active. |
| persistence.notes.annotations | object | `{}` | Annotations for the notes PVC. |
| persistence.notes.enabled | bool | `true` | Provision a PVC for note data (ignored when `storage.backend=s3`). |
| persistence.notes.existingClaim | string | `""` | Use an existing PVC instead of creating one. |
| persistence.notes.size | string | `"5Gi"` | Notes PVC size. |
| persistence.notes.storageClass | string | `""` | StorageClass for the notes PVC (empty = cluster default). |
| persistence.secrets.accessMode | string | `"ReadWriteOnce"` | Access mode; must be `ReadWriteMany` for active/active. |
| persistence.secrets.annotations | object | `{}` | Annotations for the secrets PVC. |
| persistence.secrets.enabled | bool | `true` | Provision a PVC for the API-token/secrets store. |
| persistence.secrets.existingClaim | string | `""` | Use an existing PVC instead of creating one. |
| persistence.secrets.size | string | `"256Mi"` | Secrets PVC size. |
| persistence.secrets.storageClass | string | `""` | StorageClass for the secrets PVC (empty = cluster default). |
| podDisruptionBudget | object | `{"enabled":false,"maxUnavailable":"","minAvailable":1}` | Optional PodDisruptionBudget (useful for active/active). |
| postgres | object | `{"database":"mdnest","existingSecret":"","host":"","password":"","port":5432,"secretKeys":{"password":"POSTGRES_PASSWORD"},"user":"mdnest"}` | --------------------------------------------------------------------------- |
| postgres.database | string | `"mdnest"` | PostgreSQL database name. |
| postgres.existingSecret | string | `""` | Existing Secret holding the Postgres password (preferred over inline). |
| postgres.host | string | `""` | PostgreSQL host (required when `auth.mode=multi`). |
| postgres.password | string | `""` | Inline Postgres password (discouraged; used only when `existingSecret` is empty). |
| postgres.port | int | `5432` | PostgreSQL port. |
| postgres.secretKeys | object | `{"password":"POSTGRES_PASSWORD"}` | Key inside `existingSecret` holding the password. |
| postgres.user | string | `"mdnest"` | PostgreSQL user. |
| serviceAccount.annotations | object | `{}` | Annotations to add to the ServiceAccount. |
| serviceAccount.create | bool | `true` | Create a ServiceAccount for the workloads. |
| serviceAccount.name | string | `""` | Name of the ServiceAccount; generated when empty and `create=true`. |
| sso | object | `{"adminEmails":"","allowedDomains":"","clientId":"","clientSecret":"","enabled":false,"existingSecret":"","issuerUrl":"","providerLabel":"SSO","redirectUrl":"","secretKeys":{"clientSecret":"SSO_CLIENT_SECRET"}}` | --------------------------------------------------------------------------- |
| sso.adminEmails | string | `""` | Comma-separated emails auto-promoted to superadmin. |
| sso.allowedDomains | string | `""` | Comma-separated list of allowed email domains. |
| sso.clientId | string | `""` | OIDC client ID. |
| sso.clientSecret | string | `""` | Inline OIDC client secret (used only when `existingSecret` is empty). |
| sso.enabled | bool | `false` | Enable SSO/OIDC login (`USER_PROVIDER=sso`; otherwise `local`). |
| sso.existingSecret | string | `""` | Existing Secret holding the OIDC client secret (preferred over inline). |
| sso.issuerUrl | string | `""` | OIDC issuer URL. |
| sso.providerLabel | string | `"SSO"` | Label shown on the SSO login button. |
| sso.redirectUrl | string | `""` | OAuth redirect URL; defaults to `<frontendOrigin>/api/auth/sso/callback`. |
| sso.secretKeys | object | `{"clientSecret":"SSO_CLIENT_SECRET"}` | Key inside `existingSecret` holding the client secret. |
| storage | object | `{"backend":"local","s3":{"accessKey":"","bucket":"","endpoint":"","existingSecret":"","pathStyle":true,"region":"us-east-1","secretKey":"","secretKeys":{"accessKey":"S3_ACCESS_KEY","secretKey":"S3_SECRET_KEY"},"useSSL":true}}` | --------------------------------------------------------------------------- |
| storage.backend | string | `"local"` | Note storage backend: `local` (notes on the `notes` PVC, byte-identical to upstream) or `s3` (S3-compatible object store, enables multi-replica sharing without RWX and self-service namespaces). |
| storage.s3.accessKey | string | `""` | Inline S3 access key (used only when `existingSecret` is empty). |
| storage.s3.bucket | string | `""` | S3 bucket name. |
| storage.s3.endpoint | string | `""` | S3 endpoint as `host[:port]` WITHOUT scheme, e.g. `s3.fr-par.scw.cloud`. |
| storage.s3.existingSecret | string | `""` | Existing Secret holding S3 credentials (e.g. synced from Vault). When set, inline keys are ignored. |
| storage.s3.pathStyle | bool | `true` | Path-style addressing (bucket in URL path). Required for MinIO / Ceph RGW; set `false` only if your endpoint requires virtual-hosted-style. |
| storage.s3.region | string | `"us-east-1"` | S3 region. |
| storage.s3.secretKey | string | `""` | Inline S3 secret key (used only when `existingSecret` is empty). |
| storage.s3.secretKeys | object | `{"accessKey":"S3_ACCESS_KEY","secretKey":"S3_SECRET_KEY"}` | Keys inside `existingSecret` holding the credentials. |
| storage.s3.useSSL | bool | `true` | Use TLS to reach the endpoint. |

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| mdnest | <https://github.com/mahsanamin/mdnest> |  |

---

_This README is generated with [helm-docs](https://github.com/norwoodj/helm-docs). Edit `README.md.gotmpl` and the annotated `values.yaml`, then regenerate — do not edit `README.md` by hand._
