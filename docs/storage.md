# Storage backends

mdnest persists notes through a pluggable storage layer. Two backends ship
today, selected with the `STORAGE_BACKEND` environment variable:

| Backend | `STORAGE_BACKEND` | Where notes live | Multiple replicas | Git history / sync |
|---|---|---|---|---|
| **local** (default) | `local` (or unset) | Host directories mounted into the container (`MOUNT_*`) | Needs a shared ReadWriteMany volume | Available |
| **S3** | `s3` | A single bucket in any S3-compatible object store | Yes — no shared volume needed | Unavailable |

The default is **local** and changes nothing about an existing install. This
document covers the **S3** backend.

---

## Why S3?

- **Horizontal scaling.** Object storage is shared by design, so the backend
  can run with several replicas without a ReadWriteMany PVC (which many
  clusters don't offer).
- **Durability & backups.** Notes live in a managed, replicated object store
  instead of a single pod/host filesystem.
- **Decoupled data.** The bucket outlives any individual container.

### Trade-offs

- **No git history / git-sync.** Those features need a real `.git` working
  tree on a POSIX filesystem. In S3 mode they degrade gracefully (the sync
  button and history simply have nothing to operate on). Use object-store
  versioning/backups for point-in-time recovery instead.
- **No automatic migration.** Switching an existing install to S3 starts from
  an **empty bucket** — your existing notes stay on the old filesystem and are
  not copied. Migrate them yourself (see below) before cutting over.

---

## How it maps to objects

- A **namespace** is a top-level key prefix: `"<namespace>/"`.
- A **note** is an object: `"<namespace>/<relative-path>"`.
- Because object stores have no real directories, **empty namespaces and
  folders** are represented by a zero-byte *directory marker* object whose key
  ends in `/`.
- On startup the backend connects to the endpoint and **ensures the bucket
  exists** (creating it if missing), so a misconfigured endpoint or bad
  credentials fail fast at boot.

---

## Configuration

All settings are environment variables read at startup
([`backend/storage/factory.go`](../backend/storage/factory.go)):

| Variable | Required | Default | Description |
|---|---|---|---|
| `STORAGE_BACKEND` | — | `local` | `local` or `s3`. |
| `S3_ENDPOINT` | ✅ (s3) | — | Host/`host:port` of the S3 API, **no scheme** (e.g. `s3.example.com`, `minio:9000`). |
| `S3_BUCKET` | ✅ (s3) | — | Bucket name notes are stored in. |
| `S3_ACCESS_KEY` | ✅ (s3) | — | Access key ID. |
| `S3_SECRET_KEY` | ✅ (s3) | — | Secret access key. |
| `S3_REGION` | — | `us-east-1` | Region. |
| `S3_USE_SSL` | — | `true` | Use HTTPS to reach the endpoint. |
| `S3_PATH_STYLE` | — | `true` | Force path-style addressing (`endpoint/bucket/key`). Required for MinIO / Ceph RGW; leave on unless your provider needs virtual-host style. |

If `STORAGE_BACKEND=s3` and any of the four required values is missing, the
backend refuses to start with a clear error.

---

## Usage — Docker Compose

Set the values in `mdnest.conf`, then rebuild. `setup.sh` writes them into
`.env`, which the backend container reads via `env_file`:

```ini
# mdnest.conf
STORAGE_BACKEND=s3
S3_ENDPOINT=s3.example.com
S3_BUCKET=mdnest
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
# Optional:
# S3_REGION=us-east-1
# S3_USE_SSL=true
# S3_PATH_STYLE=true
```

```bash
./mdnest-server rebuild
```

The backend boots, verifies the bucket, and serves notes from S3. The
`MOUNT_*` host directories are ignored for note storage in this mode.

### Local MinIO for testing

```bash
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

```ini
# mdnest.conf
STORAGE_BACKEND=s3
S3_ENDPOINT=localhost:9000
S3_BUCKET=mdnest
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_USE_SSL=false
S3_PATH_STYLE=true
```

---

## Usage — Kubernetes / Helm

The Helm chart exposes the same settings under `storage.*` (e.g.
`storage.backend=s3`, `storage.s3.endpoint`, `storage.s3.bucket`), with the
access/secret keys sourced from a Kubernetes Secret. See the chart README for
the exact values. Under the hood the chart injects the identical
`STORAGE_BACKEND` / `S3_*` environment variables documented above.

---

## Migrating existing notes to S3

The cutover starts from an empty bucket. To move existing filesystem notes,
copy them into the bucket with the same `<namespace>/<path>` layout **before**
switching `STORAGE_BACKEND`, for example with the MinIO client:

```bash
# notesdir/ contains one folder per namespace
mc alias set dst https://s3.example.com ACCESS_KEY SECRET_KEY
mc mirror ./notesdir/ dst/mdnest/
```

Then set `STORAGE_BACKEND=s3` and rebuild. Verify a namespace lists correctly
before decommissioning the old filesystem copy.
