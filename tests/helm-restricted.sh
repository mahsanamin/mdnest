#!/usr/bin/env bash
# Render the chart with the Pod Security "restricted" values documented in
# docs/kubernetes.md, and prove the new knobs change nothing when left empty.
# Docker provides a pinned Helm when it is not on PATH; no cluster is needed.
#   MDNEST_HELM_RENDER_OUT=<file>  keep the restricted render (CI validates it)
#   MDNEST_HELM_BASE_REF=<git ref> also require the default renders to be
#                                  byte-identical to that ref's chart
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CHART="$ROOT/deploy/helm/mdnest"
VALUES="$WORK/restricted.yaml"
HELM=(helm)
if ! command -v helm >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 || { printf 'Helm or Docker is required.\n' >&2; exit 2; }
  CHART=/chart
  VALUES=/work/restricted.yaml
  HELM=(docker run --rm -v "$ROOT/deploy/helm/mdnest:/chart:ro" -v "$WORK:/work:ro" alpine/helm:3.17.3)
fi
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
# doc <render> <template file>: the manifest rendered from that template.
doc() { awk -v src="# Source: mdnest/templates/$2" '/^---/{p=0} $0==src{p=1} p' "$1"; }
has() { grep -qF -- "$3" <(doc "$1" "$2") || fail "$2 lacks: $3"; }
lacks() { if grep -qF -- "$3" <(doc "$1" "$2"); then fail "$2 has: $3"; fi; }

# Fixed secrets: otherwise every render generates new ones.
FIXED=(--set auth.password=fixed --set auth.jwtSecret=fixed-jwt-secret-for-render-checks)
HA=(--set auth.mode=multi --set postgres.host=pg.example --set postgres.password=x
  --set collab.enabled=true --set collab.redis.url=redis://redis.example:6379/0
  --set storage.backend=git --set backend.replicaCount=3 --set persistence.secrets.enabled=false
  --set 'backend.namespaces={team}' --set mcp.enabled=true)
EMPTY=(--set-json 'backend.extraVolumes=[]' --set-json 'backend.extraVolumeMounts=[]'
  --set-json 'writer.extraVolumes=[]' --set-json 'writer.extraVolumeMounts=[]'
  --set-json 'writer.podSecurityContext={}' --set-json 'writer.securityContext={}'
  --set-json 'frontend.extraVolumes=[]' --set-json 'frontend.extraVolumeMounts=[]'
  --set-json 'mcp.extraVolumes=[]' --set-json 'mcp.extraVolumeMounts=[]' --set frontend.containerPort=80)

# Same as the example in docs/kubernetes.md; keep the two in step.
cat > "$WORK/restricted.yaml" <<'EOF'
backend:
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    fsGroup: 65532
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: [ALL]
  extraEnv:
    - name: HOME
      value: /tmp
  extraVolumes:
    - name: tmp
      emptyDir: {}
  extraVolumeMounts:
    - name: tmp
      mountPath: /tmp
writer:
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    fsGroup: 65532
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: [ALL]
  extraVolumes:
    - name: tmp
      emptyDir: {}
  extraVolumeMounts:
    - name: tmp
      mountPath: /tmp
frontend:
  containerPort: 8080
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 101
    runAsGroup: 101
    seccompProfile:
      type: RuntimeDefault
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: [ALL]
  extraVolumes:
    - name: nginx-cache
      emptyDir: {}
    - name: nginx-run
      emptyDir: {}
    - name: tmp
      emptyDir: {}
    - name: nginx-main
      configMap:
        name: mdnest-nginx-main
  extraVolumeMounts:
    - name: nginx-cache
      mountPath: /var/cache/nginx
    - name: nginx-run
      mountPath: /run
    - name: tmp
      mountPath: /tmp
    - name: nginx-main
      mountPath: /etc/nginx/nginx.conf
      subPath: nginx.conf
      readOnly: true
mcp:
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: [ALL]
EOF

"${HELM[@]}" lint "$CHART" -f "$VALUES" >/dev/null

# 1. Empty knobs render nothing: defaults equal explicit empty values.
for topo in single ha; do
  args=("${FIXED[@]}"); [ "$topo" = ha ] && args+=("${HA[@]}")
  "${HELM[@]}" template ci "$CHART" "${args[@]}" > "$WORK/$topo.yaml"
  "${HELM[@]}" template ci "$CHART" "${args[@]}" "${EMPTY[@]}" > "$WORK/$topo-empty.yaml"
  cmp -s "$WORK/$topo.yaml" "$WORK/$topo-empty.yaml" || fail "$topo: empty values change the render"
  if [ -n "${MDNEST_HELM_BASE_REF:-}" ]; then
    mkdir -p "$WORK/base"
    git -C "$ROOT" archive "$MDNEST_HELM_BASE_REF" deploy/helm/mdnest | tar -x -C "$WORK/base"
    base_chart="$WORK/base/deploy/helm/mdnest"
    [ "$CHART" = /chart ] && base_chart=/work/base/deploy/helm/mdnest
    "${HELM[@]}" template ci "$base_chart" "${args[@]}" > "$WORK/$topo-base.yaml"
    cmp -s "$WORK/$topo.yaml" "$WORK/$topo-base.yaml" || fail "$topo: default render differs from $MDNEST_HELM_BASE_REF"
  fi
done
has "$WORK/single.yaml" frontend-configmap.yaml 'listen 80;'
has "$WORK/single.yaml" frontend-deployment.yaml 'containerPort: 80'
lacks "$WORK/ha.yaml" mcp-deployment.yaml 'volumes:'
lacks "$WORK/ha.yaml" mcp-deployment.yaml 'volumeMounts:'
printf 'PASS: empty knobs leave the default renders unchanged%s.\n' \
  "${MDNEST_HELM_BASE_REF:+ and equal to $MDNEST_HELM_BASE_REF}"

# 2. Without writer.* contexts the writer keeps the backend ones.
"${HELM[@]}" template ci "$CHART" "${FIXED[@]}" "${HA[@]}" \
  --set backend.podSecurityContext.runAsUser=4242 \
  --set backend.securityContext.readOnlyRootFilesystem=true > "$WORK/fallback.yaml"
has "$WORK/fallback.yaml" writer-statefulset.yaml 'runAsUser: 4242'
[ "$(doc "$WORK/fallback.yaml" writer-statefulset.yaml | grep -c 'readOnlyRootFilesystem: true')" = 2 ] \
  || fail "writer and its init container do not inherit backend.securityContext"
printf 'PASS: the writer falls back to the backend security contexts.\n'

# 3. The restricted example, git-native HA (app Deployment + writer) and single instance.
"${HELM[@]}" template ci "$CHART" "${FIXED[@]}" "${HA[@]}" -f "$VALUES" \
  --set writer.podSecurityContext.runAsUser=70000 > "$WORK/restricted-ha.yaml"
"${HELM[@]}" template ci "$CHART" "${FIXED[@]}" --set mcp.enabled=true -f "$VALUES" > "$WORK/restricted-single.yaml"
for f in app-deployment.yaml writer-statefulset.yaml; do
  has "$WORK/restricted-ha.yaml" "$f" 'mountPath: /tmp'
  has "$WORK/restricted-ha.yaml" "$f" 'name: tmp'
  has "$WORK/restricted-ha.yaml" "$f" 'seccompProfile:'
done
has "$WORK/restricted-ha.yaml" writer-statefulset.yaml 'runAsUser: 70000'
lacks "$WORK/restricted-ha.yaml" app-deployment.yaml 'runAsUser: 70000'
[ "$(doc "$WORK/restricted-ha.yaml" writer-statefulset.yaml | grep -c 'readOnlyRootFilesystem: true')" = 2 ] \
  || fail "writer.securityContext is not on the writer and its init container"
has "$WORK/restricted-single.yaml" backend-statefulset.yaml 'mountPath: /tmp'
has "$WORK/restricted-single.yaml" backend-statefulset.yaml 'value: /tmp'
has "$WORK/restricted-single.yaml" backend-statefulset.yaml 'readOnlyRootFilesystem: true'
has "$WORK/restricted-single.yaml" frontend-configmap.yaml 'listen 8080;'
lacks "$WORK/restricted-single.yaml" frontend-configmap.yaml 'listen 80;'
has "$WORK/restricted-single.yaml" frontend-deployment.yaml 'containerPort: 8080'
for m in /var/cache/nginx /run /tmp /etc/nginx/nginx.conf; do
  has "$WORK/restricted-single.yaml" frontend-deployment.yaml "mountPath: $m"
done
has "$WORK/restricted-single.yaml" frontend-deployment.yaml 'subPath: nginx.conf'
has "$WORK/restricted-single.yaml" frontend-service.yaml 'port: 80'
has "$WORK/restricted-single.yaml" mcp-deployment.yaml 'runAsUser: 1000'
printf 'PASS: the restricted example renders its volumes, mounts, contexts and port.\n'

# 4. MCP extra volumes: rendered only when set.
"${HELM[@]}" template ci "$CHART" "${FIXED[@]}" --set mcp.enabled=true \
  --set-json 'mcp.extraVolumes=[{"name":"cache","emptyDir":{}}]' \
  --set-json 'mcp.extraVolumeMounts=[{"name":"cache","mountPath":"/home/node/.cache"}]' > "$WORK/mcp.yaml"
has "$WORK/mcp.yaml" mcp-deployment.yaml 'mountPath: /home/node/.cache'
has "$WORK/mcp.yaml" mcp-deployment.yaml 'name: cache'
printf 'PASS: mcp extra volumes render when set.\n'

if [ -n "${MDNEST_HELM_RENDER_OUT:-}" ]; then
  cat "$WORK/restricted-ha.yaml" "$WORK/restricted-single.yaml" "$WORK/mcp.yaml" > "$MDNEST_HELM_RENDER_OUT"
fi
