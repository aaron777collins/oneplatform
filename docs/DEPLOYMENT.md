# OnePlatform Deployment Guide

This guide covers production deployment, configuration, and operations for
OnePlatform — a self-hosted data integration and low-code application platform.

---

## Prerequisites

| Requirement | Minimum | Recommended |
|---|---|---|
| Docker | 24.x | latest stable |
| Docker Compose | v2.20+ | latest stable |
| RAM | 4 GB | 8 GB+ |
| CPU | 2 cores | 4 cores+ |
| Disk | 20 GB | 100 GB+ (depends on data volume) |
| OS | Linux (amd64 or arm64) | Ubuntu 22.04 LTS |

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/oneplatform.git
cd oneplatform

# 2. Copy the example environment file and fill in secrets
cp .env.example .env
$EDITOR .env

# 3. Start all services
docker compose -f docker/docker-compose.yml up -d

# 4. Follow the first-run wizard in your browser
open http://localhost:3000
```

The setup wizard (bootstrap) runs automatically on first launch. It guides
you through creating the first admin user and generates the master encryption
key. **Save the master key before the timer expires — it cannot be recovered.**

---

## Configuration

All configuration is done through environment variables. Copy `.env.example`
to `.env` and customise the values below.

### Core settings

| Variable | Default | Description |
|---|---|---|
| `OP_BASE_URL` | `http://localhost:3000` | Public-facing URL including protocol and port. Must match the address users type in their browser. Used in redirect URIs, email links, and CORS. |
| `OP_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated list of allowed CORS origins. In production set this to your exact frontend URL. |
| `OP_GATEWAY_PORT` | `3000` | Port the API gateway listens on. |

### Database

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | `dev_postgres_superuser` | Superuser password for the internal PostgreSQL instance. Change this in production. |

### Object storage (MinIO)

| Variable | Default | Description |
|---|---|---|
| `OP_MINIO_USER` | `minioadmin` | MinIO root username. Change in production. |
| `OP_MINIO_PASSWORD` | _(required)_ | MinIO root password. Set a strong random value. |

### Email (SMTP)

Email is optional. When unset, password reset and email verification are
disabled.

| Variable | Default | Description |
|---|---|---|
| `OP_SMTP_HOST` | _(empty)_ | SMTP server hostname (e.g. `smtp.sendgrid.net`). |
| `OP_SMTP_PORT` | _(empty)_ | SMTP port (typically `587` for STARTTLS or `465` for SSL). |
| `OP_SMTP_USER` | _(empty)_ | SMTP authentication username. |
| `OP_SMTP_PASS` | _(empty)_ | SMTP authentication password. |
| `OP_SMTP_FROM` | _(empty)_ | From address for outgoing emails (e.g. `noreply@example.com`). |
| `OP_SMTP_SECURE` | `true` | Set to `false` for STARTTLS on port 587. |
| `OP_REQUIRE_EMAIL_VERIFICATION` | `false` | Require users to verify their email before logging in. |

### Rate limiting

| Variable | Default | Description |
|---|---|---|
| `OP_GLOBAL_RATE_LIMIT` | `10000` | Maximum requests per minute across all tenants. Adjust based on expected traffic. |

### Ingestion

| Variable | Default | Description |
|---|---|---|
| `OP_INGESTION_BATCH_SIZE` | `1000` | Records processed per ingestion batch. Lower for low-memory environments. |
| `OP_LARGE_SYNC_CONCURRENCY` | `3` | Parallel connectors for large sync jobs. |

### Ontology

| Variable | Default | Description |
|---|---|---|
| `OP_MIGRATION_TIMEOUT` | `3600` | Maximum seconds for a schema migration to complete before it is marked failed. |
| `OP_ONTOLOGY_POLL_INTERVAL` | `15` | Seconds between ontology schema cache refresh. |

### Execution / Plugin sandbox

| Variable | Default | Description |
|---|---|---|
| `OP_SANDBOX_POOL_SIZE` | `5` | Number of pre-warmed plugin sandbox processes. Increase for high plugin throughput. |
| `OP_CONNECTOR_TIMEOUT_SECONDS` | `300` | Maximum execution time for a connector sync before it is killed. |

### Security

| Variable | Default | Description |
|---|---|---|
| `OP_WEBHOOK_ALLOW_HTTP` | `false` | Set to `true` to allow webhooks to plain HTTP URLs. **Never enable in production.** |
| `OP_SERVICE_TOKEN_SECRET` | _(required)_ | Shared secret for inter-service authentication. Generate with `openssl rand -hex 32`. |

---

## Production Checklist

Work through this list before going live.

### TLS

- [ ] Put a TLS-terminating reverse proxy (Nginx, Caddy, or a cloud load balancer) in front of the gateway.
- [ ] Set `OP_BASE_URL` to `https://your-domain.com`.
- [ ] Set `OP_ALLOWED_ORIGINS` to `https://your-domain.com`.
- [ ] Redirect all HTTP to HTTPS at the proxy level.
- [ ] Set `OP_WEBHOOK_ALLOW_HTTP=false` (default).

### Secrets

- [ ] Replace ALL default passwords: `POSTGRES_PASSWORD`, `OP_MINIO_PASSWORD`.
- [ ] Generate a strong `OP_SERVICE_TOKEN_SECRET` (`openssl rand -hex 32`).
- [ ] Store the master encryption key (shown during first-run wizard) in a password manager or secrets vault. It cannot be recovered if lost.
- [ ] Rotate secrets annually or immediately after a suspected breach.

### Backups

- [ ] Enable PostgreSQL continuous archiving (WAL) or automated snapshots.
- [ ] Configure MinIO bucket replication or scheduled backups for object storage.
- [ ] Test restore procedures before going live.
- [ ] Store backups in a separate region/account from the primary deployment.

### Monitoring

- [ ] Export container metrics to a monitoring system (Prometheus/Grafana or cloud-native).
- [ ] Set up alerts on: high error rate, disk > 80%, memory > 85%, failed sync jobs.
- [ ] Subscribe to the `/v1/health` endpoint for uptime monitoring.
- [ ] Enable log shipping to a log aggregation system (Loki, Datadog, CloudWatch, etc.).

### Access control

- [ ] Create dedicated admin accounts (do not use the bootstrap admin in day-to-day operations).
- [ ] Assign least-privilege roles to each team member.
- [ ] Enable email verification (`OP_REQUIRE_EMAIL_VERIFICATION=true`) if open sign-up is allowed.

---

## Scaling Guide

OnePlatform's services are stateless (except PostgreSQL and Redis) and can
be scaled horizontally.

### Stateless services (scale out freely)

| Service | Notes |
|---|---|
| `gateway` | Scale to handle inbound request volume. Use a load balancer upstream. |
| `auth` | Scale for login throughput. Sessions are stored in PostgreSQL. |
| `ingestion` | Scale for connector sync throughput. Each instance takes jobs from BullMQ. |
| `ontology` | Scale for schema read throughput. Ontology is read-heavy. |
| `pipeline` | Scale for pipeline execution throughput. |
| `app` | Scale for app serve throughput. |
| `plugin` | Scale for plugin execution throughput. |
| `logging` | Scale for log write throughput. |

```bash
# Example: scale gateway to 3 replicas
docker compose -f docker/docker-compose.yml up -d --scale gateway=3
```

### Stateful services (do not scale without care)

| Service | Scaling approach |
|---|---|
| `postgres` | Use a managed PostgreSQL service (RDS, Cloud SQL, Neon) or set up streaming replication with a connection pooler. |
| `redis` | Use Redis Cluster or a managed Redis service (ElastiCache, Upstash). |
| `minio` | Use MinIO distributed mode or replace with S3-compatible cloud storage. |

### Minimum production topology

```
                         [Load Balancer / TLS terminator]
                                    |
                   ┌────────────────┼────────────────┐
                   |                |                |
              [gateway]        [gateway]        [gateway]
                   |                |                |
          ┌────────┴────────────────┴────────────────┘
          |        |         |         |        |      |      |     |
       [auth] [ingestion] [ontology] [pipeline] [app] [plugin] [logging] [execution]
          |                                                               |
          └──────────────────────[postgres] [redis] [minio]──────────────┘
```

---

## Troubleshooting

### "Could not connect to OnePlatform" on the setup page

The browser cannot reach the API gateway.

1. Check that Docker is running: `docker ps`
2. Check all containers are up: `docker compose -f docker/docker-compose.yml ps`
3. Check the gateway port: `curl http://localhost:3000/health`
4. Check gateway logs: `docker compose -f docker/docker-compose.yml logs gateway`

### Services fail to start

Common causes:

- **Missing `.env` file**: `cp .env.example .env` and fill in required values.
- **Port conflict**: Another service is using port 3000. Set `OP_GATEWAY_PORT` to a free port.
- **Database connection error**: Check `POSTGRES_PASSWORD` matches in all services.
- **Insufficient memory**: Increase Docker's memory limit to at least 4 GB.

### Plugin sandbox errors

- Check `OP_SANDBOX_POOL_SIZE` is not 0.
- Check container has sufficient CPU (sandbox processes are CPU-bound).
- Review plugin logs: `docker compose -f docker/docker-compose.yml logs plugin`.

### Sync jobs stuck in "running"

- Check the ingestion service is running: `docker compose -f docker/docker-compose.yml ps ingestion`.
- Check Redis is reachable (BullMQ queue): `docker compose -f docker/docker-compose.yml logs redis`.
- Manually cancel stuck jobs via `op connector trigger <id>` or the connector detail page.

### Migrations failing

- Check `OP_MIGRATION_TIMEOUT` is long enough for your data volume.
- Review ontology logs: `docker compose -f docker/docker-compose.yml logs ontology`.
- Migrations can be rolled back from the Ontology > Migrations page.

---

## Updating OnePlatform

```bash
# 1. Pull the latest images
docker compose -f docker/docker-compose.yml pull

# 2. Restart services with zero-downtime rolling update (requires a load balancer)
docker compose -f docker/docker-compose.yml up -d --no-deps --build

# 3. Run database migrations (auto-applied on service startup)
# Watch the logs to confirm migration success
docker compose -f docker/docker-compose.yml logs --follow ontology ingestion
```

> Always take a database snapshot before updating.
