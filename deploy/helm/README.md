# OnePlatform Helm Chart

Helm 3 chart for deploying OnePlatform to Kubernetes.

Chart location: `deploy/helm/oneplatform/`

---

## Prerequisites

| Tool | Minimum version | Notes |
|------|----------------|-------|
| Kubernetes | 1.26 | Requires `autoscaling/v2` (GA in 1.23) |
| Helm | 3.12 | `helm dependency update` support |
| kubectl | matches cluster | For verification steps |
| cert-manager | 1.13 (optional) | Only if using `ingress.tls.certManagerIssuer` |

The cluster must have:
- A default StorageClass (for PVC provisioning) or explicit `storageClass` set per service
- The Metrics Server installed if HPAs are enabled (`hpa.enabled=true`)
- An ingress controller installed if `ingress.enabled=true` (nginx assumed by default)

---

## Quick Start

### 1. Add Bitnami repository (for PostgreSQL/Redis/MinIO subcharts)

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

### 2. Fetch subchart dependencies

```bash
helm dependency update deploy/helm/oneplatform
```

### 3. Create a namespace

```bash
kubectl create namespace oneplatform
```

### 4. Create a production Secret (recommended)

Rather than putting credentials in values files, pre-create the Secret:

```bash
kubectl create secret generic oneplatform-credentials \
  --namespace oneplatform \
  --from-literal=jwtPrivateKey="$(cat /path/to/ed25519-private.pem | base64 -w0)" \
  --from-literal=jwtPublicKey="$(cat /path/to/ed25519-public.pem | base64 -w0)" \
  --from-literal=postgresPassword="$(openssl rand -hex 32)" \
  --from-literal=appDbPassword="$(openssl rand -hex 32)" \
  --from-literal=redisPassword="$(openssl rand -hex 32)" \
  --from-literal=minioRootUser="minioadmin" \
  --from-literal=minioRootPassword="$(openssl rand -hex 32)" \
  --from-literal=smtpHost="" \
  --from-literal=smtpPort="587" \
  --from-literal=smtpUser="" \
  --from-literal=smtpPassword="" \
  --from-literal=smtpFrom="" \
  --from-literal=smtpSecure="true"
```

### 5. Install

```bash
helm install oneplatform deploy/helm/oneplatform \
  --namespace oneplatform \
  --set existingSecret=oneplatform-credentials \
  --set baseUrl=https://oneplatform.example.com \
  --set ingress.hostname=oneplatform.example.com \
  --set ingress.tls.certManagerIssuer=letsencrypt-prod \
  --atomic \
  --timeout 10m
```

The `--atomic` flag rolls back automatically if any pod fails to become ready
within the timeout.

### 6. Verify

```bash
# All pods should be Running / Ready
kubectl get pods -n oneplatform

# Check the gateway health endpoint
kubectl port-forward -n oneplatform svc/oneplatform-gateway 3000:3000 &
curl http://localhost:3000/healthz
```

---

## Configuration Reference

All settings are documented in `values.yaml`.  Key sections:

| Section | Purpose |
|---------|---------|
| `global` | Image registry, pull secrets, namespace override |
| `baseUrl` / `allowedOrigins` | External URL and CORS policy |
| `existingSecret` | Name of pre-created Secret with all credentials |
| `secrets.*` | Credential values (used only when `existingSecret` is empty) |
| `ingress.*` | Kubernetes Ingress resource settings |
| `caddy.*` | Caddy LoadBalancer alternative to Ingress |
| `postgresql.*` | Bundled PostgreSQL subchart (bitnami) |
| `externalPostgresql.*` | External PostgreSQL coordinates |
| `redis.*` | Bundled Redis subchart (bitnami) |
| `externalRedis.*` | External Redis coordinates |
| `minio.*` | Bundled MinIO subchart (bitnami) |
| `externalMinio.*` | External S3-compatible storage |
| `jaeger.*` | Bundled Jaeger all-in-one |
| `grafana.*` | Bundled Grafana |
| `gateway.*` | Gateway service sizing + HPA |
| `auth.*` | Auth service sizing |
| `ingestion.*` | Ingestion service sizing + HPA |
| `ontology.*` | Ontology service sizing (HPA disabled by default) |
| `pipeline.*` | Pipeline service sizing + HPA |
| `execution.*` | Execution service + sandbox sidecar sizing + HPA |
| `app.*` | App service sizing + HPA |
| `logging.*` | Logging service sizing + HPA |
| `plugin.*` | Plugin service sizing + HPA |
| `frontend.*` | Frontend nginx sizing + HPA |
| `networkPolicy.*` | Enable/disable NetworkPolicy enforcement |

### Example: use external PostgreSQL and Redis (Medium/Large tier)

```yaml
# values-prod.yaml
postgresql:
  enabled: false

externalPostgresql:
  host: "mydb.us-east-1.rds.amazonaws.com"
  port: 5432
  database: oneplatform
  username: postgres

redis:
  enabled: false

externalRedis:
  host: "mycluster.cache.amazonaws.com"
  port: 6379
```

### Example: Medium-tier resource overrides

See `docs/CAPACITY-PLANNING.md` for the full tuning checklist.

```yaml
# values-medium.yaml
ingestion:
  resources:
    limits:
      cpu: "2"
      memory: "2Gi"
  env:
    OP_LARGE_SYNC_CONCURRENCY: "6"

execution:
  resources:
    limits:
      cpu: "2"
      memory: "4Gi"
  env:
    OP_SANDBOX_POOL_SIZE: "10"

redis:
  master:
    resources:
      limits:
        memory: "1Gi"
```

---

## Upgrade Procedure

1. Fetch updated subchart dependencies if Chart.yaml changed:

   ```bash
   helm dependency update deploy/helm/oneplatform
   ```

2. Review the diff before applying:

   ```bash
   helm diff upgrade oneplatform deploy/helm/oneplatform \
     --namespace oneplatform \
     -f your-values.yaml
   ```

   (`helm-diff` plugin: `helm plugin install https://github.com/databus23/helm-diff`)

3. Apply the upgrade:

   ```bash
   helm upgrade oneplatform deploy/helm/oneplatform \
     --namespace oneplatform \
     -f your-values.yaml \
     --atomic \
     --timeout 10m
   ```

4. Verify:

   ```bash
   kubectl rollout status deployment -n oneplatform -l app.kubernetes.io/instance=oneplatform
   ```

### Ontology service migrations during upgrades

The ontology service uses advisory locks to serialize schema migrations.
If you are upgrading with a migration included, scale the ontology Deployment
to 1 replica before upgrading to avoid two pods racing the migration:

```bash
kubectl scale deployment oneplatform-ontology -n oneplatform --replicas=1
helm upgrade ...
# Scale back up after migrations complete
kubectl scale deployment oneplatform-ontology -n oneplatform --replicas=2
```

---

## Rollback

```bash
# List release history
helm history oneplatform -n oneplatform

# Roll back to the previous release
helm rollback oneplatform -n oneplatform

# Roll back to a specific revision
helm rollback oneplatform 3 -n oneplatform
```

---

## Uninstall

```bash
helm uninstall oneplatform -n oneplatform

# Remove PVCs (DESTRUCTIVE — this deletes all persistent data)
kubectl delete pvc -n oneplatform -l app.kubernetes.io/instance=oneplatform
```

---

## Architecture Notes

### Sandbox sidecar

In Docker Compose the sandbox VM (`op-sandbox-vm`) runs as a separate container
communicating with the execution service via a Unix socket on a shared named volume.

In Kubernetes the sandbox runs as a sidecar container in the same execution Pod,
sharing an `emptyDir` (memory-backed) volume at `/run/sandbox`.  This preserves
the process isolation boundary while avoiding the need for a separate Docker
daemon inside the cluster.

The sandbox container has no capabilities, a read-only root filesystem, and the
network NetworkPolicy allows no egress — it can only be reached by the execution
container in the same Pod via the Unix socket.

### Secret management

The chart supports two modes:

1. **Chart-managed Secret** (development only): set `secrets.*` values and leave
   `existingSecret` empty.  The chart creates a Secret named
   `<release>-oneplatform-secrets`.  Do not use this in production.

2. **Pre-existing Secret** (production): create the Secret out-of-band (Vault
   injection, External Secrets Operator, `kubectl create secret`, etc.) and set
   `existingSecret=<name>`.  The chart will reference that Secret without
   creating or modifying it.

### NetworkPolicy

When `networkPolicy.enabled=true` the chart creates policies that mirror the
Docker Compose `internal: true` network model:

- Default-deny all ingress within the namespace
- Allow ingress controller to reach gateway and frontend only
- Allow all OnePlatform pods to communicate with each other
- Deny all ingress/egress to the sandbox sidecar (IPC via socket only)
