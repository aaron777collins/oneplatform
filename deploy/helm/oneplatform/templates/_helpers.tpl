{{/*
_helpers.tpl — Named template library for the OnePlatform Helm chart.

Conventions:
  - All helpers are prefixed with "oneplatform." to avoid collisions in
    umbrella charts.
  - Helpers that take a service-specific dict receive it as the top-level "."
    context; callers must pass the merged dict using "dict" and "merge":
      {{ include "oneplatform.serviceLabels" (dict "name" "gateway" "root" .) }}
*/}}

{{/*
Expand the release name, truncated to 63 chars.
Kubernetes label values may not exceed 63 chars.
*/}}
{{- define "oneplatform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Full name: <release>-<chart>, or just <release> if the release already
contains the chart name to avoid duplicates like "oneplatform-oneplatform".
*/}}
{{- define "oneplatform.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label: <chart>-<version>.
*/}}
{{- define "oneplatform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Standard Kubernetes recommended labels applied to every resource.
These are stable and should NOT be used as selectors (use selectorLabels instead).
*/}}
{{- define "oneplatform.labels" -}}
helm.sh/chart: {{ include "oneplatform.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: oneplatform
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end }}

{{/*
Selector labels used in matchLabels and Service selectors.
These MUST remain stable across upgrades — changing them requires
deleting and re-creating Deployments.
*/}}
{{- define "oneplatform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "oneplatform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Per-service selector labels.
Usage: {{ include "oneplatform.serviceSelectorLabels" (dict "service" "gateway" "root" .) }}
*/}}
{{- define "oneplatform.serviceSelectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-%s" (include "oneplatform.name" .root) .service | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .service }}
{{- end }}

{{/*
Per-service full set of labels (stable + selector).
Usage: {{ include "oneplatform.serviceLabels" (dict "service" "gateway" "root" .) }}
*/}}
{{- define "oneplatform.serviceLabels" -}}
{{ include "oneplatform.labels" .root }}
{{ include "oneplatform.serviceSelectorLabels" (dict "service" .service "root" .root) }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "oneplatform.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "oneplatform.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Image tag: per-service tag → global.imageTag → .Chart.AppVersion.
Usage: {{ include "oneplatform.imageTag" (dict "svc" .Values.gateway "root" .) }}
*/}}
{{- define "oneplatform.imageTag" -}}
{{- coalesce .svc.image.tag .root.Values.global.imageTag .root.Chart.AppVersion | default "latest" }}
{{- end }}

{{/*
Full image reference for a service.
Usage: {{ include "oneplatform.image" (dict "svc" .Values.gateway "root" .) }}
*/}}
{{- define "oneplatform.image" -}}
{{- $registry := coalesce .root.Values.global.imageRegistry "" }}
{{- $repo := .svc.image.repository }}
{{- $tag := include "oneplatform.imageTag" (dict "svc" .svc "root" .root) }}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry $repo $tag }}
{{- else }}
{{- printf "%s:%s" $repo $tag }}
{{- end }}
{{- end }}

{{/*
Secret name: existingSecret if provided, otherwise the chart-managed secret.
*/}}
{{- define "oneplatform.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- printf "%s-secrets" (include "oneplatform.fullname" .) }}
{{- end }}
{{- end }}

{{/*
ConfigMap name for shared application configuration.
*/}}
{{- define "oneplatform.configMapName" -}}
{{- printf "%s-config" (include "oneplatform.fullname" .) }}
{{- end }}

{{/*
In-cluster service URL for a named OnePlatform service.
Usage: {{ include "oneplatform.serviceURL" (dict "service" "gateway" "root" .) }}
Returns: http://<release>-oneplatform-<service>:3000
*/}}
{{- define "oneplatform.serviceURL" -}}
{{- $svcName := printf "%s-%s" (include "oneplatform.fullname" .root) .service }}
{{- printf "http://%s:%d" $svcName 3000 }}
{{- end }}

{{/*
PostgreSQL DSN-style host:port.
Switches between bundled subchart and external host.
*/}}
{{- define "oneplatform.postgresqlHost" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "%s-postgresql" (include "oneplatform.fullname" .) }}
{{- else }}
{{- .Values.externalPostgresql.host | required "externalPostgresql.host is required when postgresql.enabled=false" }}
{{- end }}
{{- end }}

{{- define "oneplatform.postgresqlPort" -}}
{{- if .Values.postgresql.enabled }}5432{{- else }}{{- .Values.externalPostgresql.port }}{{- end }}
{{- end }}

{{/*
Redis host.
*/}}
{{- define "oneplatform.redisHost" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s-redis-master" (include "oneplatform.fullname" .) }}
{{- else }}
{{- .Values.externalRedis.host | required "externalRedis.host is required when redis.enabled=false" }}
{{- end }}
{{- end }}

{{- define "oneplatform.redisPort" -}}
{{- if .Values.redis.enabled }}6379{{- else }}{{- .Values.externalRedis.port }}{{- end }}
{{- end }}

{{/*
MinIO / S3 endpoint.
*/}}
{{- define "oneplatform.minioEndpoint" -}}
{{- if .Values.minio.enabled }}
{{- printf "http://%s-minio:9000" (include "oneplatform.fullname" .) }}
{{- else }}
{{- .Values.externalMinio.endpoint | required "externalMinio.endpoint is required when minio.enabled=false" }}
{{- end }}
{{- end }}

{{/*
Common environment variable block shared by all application services.
Renders a YAML list of env entries; embed with toYaml in Deployment templates.
*/}}
{{- define "oneplatform.commonEnv" -}}
- name: NODE_ENV
  value: "production"
- name: PORT
  value: "3000"
- name: OP_BASE_URL
  value: {{ .Values.baseUrl | quote }}
- name: OP_ALLOWED_ORIGINS
  value: {{ .Values.allowedOrigins | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ coalesce .Values.otelExporterOtlpEndpoint (printf "http://%s-jaeger:4318" (include "oneplatform.fullname" .)) | quote }}
- name: DATABASE_HOST
  value: {{ include "oneplatform.postgresqlHost" . | quote }}
- name: DATABASE_PORT
  value: {{ include "oneplatform.postgresqlPort" . | quote }}
- name: REDIS_HOST
  value: {{ include "oneplatform.redisHost" . | quote }}
- name: REDIS_PORT
  value: {{ include "oneplatform.redisPort" . | quote }}
- name: OP_MINIO_ENDPOINT
  value: {{ include "oneplatform.minioEndpoint" . | quote }}
- name: OP_MINIO_USER
  valueFrom:
    secretKeyRef:
      name: {{ include "oneplatform.secretName" . }}
      key: minioRootUser
- name: OP_MINIO_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "oneplatform.secretName" . }}
      key: minioRootPassword
- name: DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "oneplatform.secretName" . }}
      key: appDbPassword
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "oneplatform.secretName" . }}
      key: redisPassword
- name: JWT_PRIVATE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "oneplatform.secretName" . }}
      key: jwtPrivateKey
- name: JWT_PUBLIC_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "oneplatform.secretName" . }}
      key: jwtPublicKey
{{- end }}

{{/*
Standard liveness probe for HTTP services using /healthz.
Mirrors the healthcheck in docker-compose.yml.
*/}}
{{- define "oneplatform.livenessProbe" -}}
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 20
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 5
{{- end }}

{{/*
Standard readiness probe — stricter than liveness to gate traffic.
*/}}
{{- define "oneplatform.readinessProbe" -}}
readinessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
{{- end }}

{{/*
Render an HorizontalPodAutoscaler if hpa.enabled=true for the given service.
Usage: {{ include "oneplatform.hpa" (dict "service" "gateway" "cfg" .Values.gateway "root" .) }}
*/}}
{{- define "oneplatform.hpa" -}}
{{- if .cfg.hpa.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ printf "%s-%s" (include "oneplatform.fullname" .root) .service }}
  namespace: {{ .root.Release.Namespace }}
  labels:
    {{- include "oneplatform.serviceLabels" (dict "service" .service "root" .root) | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ printf "%s-%s" (include "oneplatform.fullname" .root) .service }}
  minReplicas: {{ .cfg.hpa.minReplicas }}
  maxReplicas: {{ .cfg.hpa.maxReplicas }}
  metrics:
    {{- if .cfg.hpa.targetCPUUtilizationPercentage }}
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .cfg.hpa.targetCPUUtilizationPercentage }}
    {{- end }}
    {{- if .cfg.hpa.targetMemoryUtilizationPercentage }}
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: {{ .cfg.hpa.targetMemoryUtilizationPercentage }}
    {{- end }}
{{- end }}
{{- end }}
