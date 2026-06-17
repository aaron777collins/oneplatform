---
title: "op service"
description: "Service administration (scope: admin)"
sidebar:
  order: 19
---

# `op service`

Service administration (scope: admin)

### `rotate-keys`

Rotate inter-service signing keys

**Usage:** `rotate-keys [options]`

**Options:**

- `--service <name>` — Specific service name; omit to rotate all
- `--overlap <duration>` — Overlap period for key transition (default: `5m`)


---

### `health`

Show detailed service health metrics

**Usage:** `health [options]`


---

### `restart`

Restart one or all services (scope: admin)

**Usage:** `restart [options] [service-name]`

**Arguments:**

- `[service-name]` — Service to restart; omit to restart all

**Options:**

- `--graceful` — Wait for in-flight requests to drain before restarting (default: true) (default: `true`)


---

### `scale`

Set the replica count for a service.
Requires orchestrator support (Docker Swarm or Kubernetes).
In standalone Docker Compose, use: docker compose up --scale <service>=<count>

**Usage:** `scale [options] <service-name> <replicas>`

**Arguments:**

- `<service-name>` — Service name (e.g. gateway-service)
- `<replicas>` — Desired replica count (positive integer)

