{{/* Expand the name of the chart. */}}
{{- define "mdnest.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name. */}}
{{- define "mdnest.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "mdnest.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "mdnest.labels" -}}
helm.sh/chart: {{ include "mdnest.chart" . }}
{{ include "mdnest.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "mdnest.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mdnest.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Component-scoped names. */}}
{{- define "mdnest.backend.fullname" -}}{{ printf "%s-backend" (include "mdnest.fullname" .) }}{{- end -}}
{{- define "mdnest.frontend.fullname" -}}{{ printf "%s-frontend" (include "mdnest.fullname" .) }}{{- end -}}
{{- define "mdnest.gitsync.fullname" -}}{{ printf "%s-git-sync" (include "mdnest.fullname" .) }}{{- end -}}
{{- define "mdnest.mcp.fullname" -}}{{ printf "%s-mcp" (include "mdnest.fullname" .) }}{{- end -}}

{{- define "mdnest.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "mdnest.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Image references (tag falls back to appVersion). */}}
{{- define "mdnest.backend.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.backend.tag -}}
{{- printf "%s:%s" .Values.image.backend.repository $tag -}}
{{- end -}}
{{- define "mdnest.frontend.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.frontend.tag -}}
{{- printf "%s:%s" .Values.image.frontend.repository $tag -}}
{{- end -}}
{{- define "mdnest.mcp.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.mcp.tag -}}
{{- printf "%s:%s" .Values.image.mcp.repository $tag -}}
{{- end -}}
{{- define "mdnest.mcp.secretName" -}}{{ printf "%s-mcp" (include "mdnest.fullname" .) }}{{- end -}}

{{/* Names of chart-managed secrets/configmaps. */}}
{{- define "mdnest.appSecretName" -}}{{ printf "%s-app" (include "mdnest.fullname" .) }}{{- end -}}
{{- define "mdnest.envConfigName" -}}{{ printf "%s-env" (include "mdnest.fullname" .) }}{{- end -}}

{{/* PVC claim names honor existingClaim. */}}
{{- define "mdnest.notesClaimName" -}}
{{- if .Values.persistence.notes.existingClaim -}}{{ .Values.persistence.notes.existingClaim }}{{- else -}}{{ printf "%s-notes" (include "mdnest.fullname" .) }}{{- end -}}
{{- end -}}
{{- define "mdnest.secretsClaimName" -}}
{{- if .Values.persistence.secrets.existingClaim -}}{{ .Values.persistence.secrets.existingClaim }}{{- else -}}{{ printf "%s-secrets" (include "mdnest.fullname" .) }}{{- end -}}
{{- end -}}

{{/*
Validate the high-availability invariants. Any multi-replica (or autoscaled)
backend deployment MUST have Redis-backed collaboration and ReadWriteMany
storage, otherwise replicas would silently diverge (separate collab state,
separate note files). Fail fast with an actionable message.
*/}}
{{- define "mdnest.validateHA" -}}
{{- $ha := or (gt (int .Values.backend.replicaCount) 1) .Values.backend.autoscaling.enabled -}}
{{- if $ha -}}
  {{- if ne .Values.auth.mode "multi" -}}
    {{- fail "mdnest: running multiple backend replicas requires auth.mode=multi (external PostgreSQL). See values.yaml 'Deployment model'." -}}
  {{- end -}}
  {{- if not .Values.collab.enabled -}}
    {{- fail "mdnest: running multiple backend replicas requires collab.enabled=true so live collaboration is coordinated across pods." -}}
  {{- end -}}
  {{- $redisUrl := or .Values.collab.redis.url .Values.collab.redis.existingSecret .Values.collab.redis.host -}}
  {{- if not $redisUrl -}}
    {{- fail "mdnest: running multiple backend replicas requires an external Redis (collab.redis.url, collab.redis.existingSecret, or collab.redis.host) for the presence/event backplane." -}}
  {{- end -}}
  {{- if and (ne .Values.storage.backend "s3") (ne .Values.persistence.notes.accessMode "ReadWriteMany") -}}
    {{- fail "mdnest: running multiple backend replicas requires persistence.notes.accessMode=ReadWriteMany so all pods share the notes repository (or set storage.backend=s3 to share notes via an object store)." -}}
  {{- end -}}
  {{- if and .Values.persistence.secrets.enabled (ne .Values.persistence.secrets.accessMode "ReadWriteMany") -}}
    {{- fail "mdnest: running multiple backend replicas requires persistence.secrets.accessMode=ReadWriteMany so all pods share the token/secrets store." -}}
  {{- end -}}
{{- end -}}
{{- end -}}
