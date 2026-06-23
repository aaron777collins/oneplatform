# Docker Fleet Manager — OnePlatform App Design

**Date:** 2026-06-22
**Status:** DRAFT
**Author:** Principal Architect

**Reference hierarchy:**
- L0: `docs/decisions/001-architecture-decisions.md` (ADR-25, ADR-26, ADR-27)
- L2: `docs/designs/app-service.md` — App Service hosting model
- L2: `docs/designs/app-sdk-package.md` — BFF and hook API surface
- **L3: This document** — Docker Fleet Manager app design
- L4: `examples/docker-fleet-manager/` — implementation

---

## Table of Contents

1. [Problem and Constraints](#1-problem-and-constraints)
2. [Architecture Overview](#2-architecture-overview)
3. [Backend: Docker BFF Sidecar](#3-backend-docker-bff-sidecar)
4. [Frontend Component Hierarchy](#4-frontend-component-hierarchy)
5. [API Endpoint Specification](#5-api-endpoint-specification)
6. [Data Models](#6-data-models)
7. [Real-Time Updates](#7-real-time-updates)
8. [Security Design](#8-security-design)
9. [File Structure](#9-file-structure)
10. [Implementation Priority](#10-implementation-priority)
11. [Technology Choices and Rationale](#11-technology-choices-and-rationale)
12. [Testing Strategy](#12-testing-strategy)

---

## 1. Problem and Constraints

### What we are building

A OnePlatform-native app that lets platform admins and DevOps engineers inspect and control Docker containers running on the same host (or a designated Docker host) from within the OnePlatform UI — without leaving the platform or reaching for a terminal.

### What "OnePlatform-native" means for this app

OnePlatform apps are React bundles served by the App Service, constrained to call only `@oneplatform/app-sdk` hooks that proxy through the BFF layer. They cannot make arbitrary HTTP calls to external services — the CSP enforces `connect-src 'self'` and `fetch` is same-origin only.

This creates the central architectural challenge: Docker's HTTP API is not on the same origin as the platform. We cannot call `unix:///var/run/docker.sock` or `tcp://docker-host:2375` directly from the browser. We need a backend component that bridges the browser (via BFF) to the Docker daemon.

### Constraints

| Constraint | Source |
|-----------|--------|
| No direct cross-origin `fetch` from the browser | CSP `connect-src 'self'` — ADR-26 |
| All SDK calls go through `/bff/*` endpoints | App Service BFF design — ADR-26 |
| Access to Docker socket requires a privileged process — not appropriate inside the esbuild sandbox | Docker security model |
| The app must use `AppProvider` and `@oneplatform/app-sdk` hooks | ADR-25 |
| Only `platform-user` access mode — this is not a public app | Docker control plane must be admin-only |
| No BFF extension mechanism exists to add custom endpoints for a hosted app | App Service design — BFF routes are fixed to `/bff/data/*`, `/bff/storage/*`, `/bff/me`, `/bff/permissions` |

### The BFF Limitation

The standard BFF layer can only proxy requests to the Ontology Service for entity CRUD. Docker containers are not OnePlatform ontology entities — they live entirely outside the platform's data model. We cannot route Docker API calls through `/bff/data/container` because there is no ontology entity called `container`.

**Decision:** introduce a lightweight Docker BFF Sidecar microservice that the App Service can reach internally. The frontend calls the sidecar through a custom proxy route registered on the App Service (using the BFF extension point described in the appendix below). This keeps the architecture clean and within the platform model.

---

## 2. Architecture Overview

### System Context Diagram (ASCII)

```
                        BROWSER
                           │
          ┌────────────────┼────────────────┐
          │   Docker Fleet Manager App      │
          │   (React bundle, same origin)   │
          │                                 │
          │  @oneplatform/app-sdk hooks     │
          │  + custom dockerApiClient       │
          └──────────┬──────────────────────┘
                     │ fetch("/bff/docker/...")
                     │ credentials: include
                     ▼
         ┌───────────────────────┐
         │   App Service (3006)  │
         │   BFF Docker Proxy    │◄── session validation
         │   /bff/docker/*       │◄── RBAC: admin role required
         └──────────┬────────────┘
                    │ HTTP  (oneplatform-internal network)
                    │ X-Service-Token
                    ▼
         ┌───────────────────────┐
         │  Docker BFF Sidecar   │
         │  (Hono, port 3010)    │
         └──────────┬────────────┘
                    │ HTTP / Unix socket
                    ▼
         ┌───────────────────────┐
         │  Docker Daemon        │
         │  /var/run/docker.sock │
         └───────────────────────┘
```

### Component Summary

| Component | Where it lives | Role |
|-----------|---------------|------|
| Docker Fleet Manager App | `examples/docker-fleet-manager/` | React frontend bundled by App Service |
| App Service BFF Docker Proxy | `services/app/src/routes/bff-docker.ts` | Validates session + RBAC, proxies to sidecar |
| Docker BFF Sidecar | `services/docker-bff/` | Translates HTTP API calls to Docker daemon |
| Docker daemon | Host OS | Source of truth for container/image/network data |

### Data Flow (read path)

```
1. Browser calls GET /bff/docker/containers (App SDK dockerApiClient)
2. App Service BFF Docker Proxy:
   a. Validates op_session cookie (same LRU cache as standard BFF, 15s TTL)
   b. Checks RBAC: user must have platform role 'admin' or 'devops'
   c. If authorized: forwards to Docker BFF Sidecar with X-Service-Token
3. Docker BFF Sidecar calls Docker daemon HTTP API:
   GET http://localhost/containers/json (via unix socket)
4. Sidecar transforms raw Docker JSON into typed DockerContainer[] response
5. Response flows back: Sidecar → App Service BFF Proxy → Browser
```

### Data Flow (action path: stop container)

```
1. Browser calls POST /bff/docker/containers/{id}/stop
2. App Service BFF Docker Proxy:
   a. Session validation
   b. RBAC: user must have role 'admin' (stricter than read)
   c. Audit log entry written via Logging Service
   d. Forward to Docker BFF Sidecar
3. Sidecar calls POST /containers/{id}/stop on Docker daemon
4. 204 propagated back to browser
5. Frontend invalidates container cache and triggers refresh
```

---

## 3. Backend: Docker BFF Sidecar

### Why a separate service and not inline in App Service

The App Service has no access to the Docker socket — it runs in a container on the `oneplatform-internal` network with no mounts to the host Docker socket. Adding Docker socket access to the App Service would:
- Grant Docker daemon access to a service that handles all platform app traffic (blast radius)
- Violate the principle of least privilege (ADR-19)
- Couple app build/serve infrastructure with container management

A dedicated sidecar service can be given exactly one capability: read/write access to the Docker socket.

### Sidecar Design

**Language/framework:** Hono (TypeScript, Node.js) — matches every other OnePlatform service.

**Port:** 3010 (internal network only).

**Docker connectivity:** via `dockerode` npm package (communicates over Unix socket `/var/run/docker.sock` mounted at container start).

**Auth:** Every inbound request must carry a valid `X-Service-Token` (Ed25519 JWT) signed by the App Service. Requests without a valid token return `403 FORBIDDEN`. The sidecar validates the token using `@oneplatform/core`'s `serviceAuth` middleware, identical to every other internal service.

**Scope:** The sidecar implements only the endpoints the frontend needs. It is not a general Docker API proxy.

### Sidecar Endpoints

See Section 5 for full specs. At a high level:

```
GET    /containers              — list all containers
GET    /containers/{id}         — container details
GET    /containers/{id}/logs    — streaming log tail (SSE)
GET    /containers/{id}/stats   — live CPU/mem stats (SSE)
POST   /containers/{id}/start   — start stopped container
POST   /containers/{id}/stop    — stop running container
POST   /containers/{id}/restart — restart container
DELETE /containers/{id}         — remove container (stopped only)

GET    /images                  — list images
DELETE /images/{id}             — remove image (untagged, no containers)

GET    /networks                — list networks
GET    /volumes                 — list volumes
```

### Network placement

The Docker BFF Sidecar joins `oneplatform-internal` so the App Service can reach it. It also requires a Docker socket mount:

```yaml
# docker-compose.yml addition
docker-bff:
  build: ./services/docker-bff
  networks:
    - oneplatform-internal
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro   # read-only for list/inspect
  ports: []   # no external port — internal only
  environment:
    - SERVICE_TOKEN_PUBLIC_KEY=${SERVICE_TOKEN_PUBLIC_KEY}
    - DOCKER_SOCKET=/var/run/docker.sock
  read_only: true
  security_opt:
    - no-new-privileges:true
```

The Docker socket is mounted read-only for listing and inspection. For destructive actions (stop, restart, remove), the sidecar calls the Docker daemon via a separate socket path that is writable — or we mount read-write but the sidecar enforces via internal RBAC which operations are permitted (see Section 8).

### App Service BFF Docker Proxy

Add a Hono route group at `/bff/docker/*` in `services/app/src/routes/bff-docker.ts`:

```typescript
// Middleware stack:
// 1. sessionAuth     — validates op_session cookie (reuses existing BffSessionMiddleware)
// 2. dockerRbac      — checks user has 'admin' or 'devops' role
// 3. auditLog        — logs destructive operations
// 4. proxyToSidecar  — forwards to docker-bff:3010 with X-Service-Token

bffDockerRouter.use("*", sessionAuth);
bffDockerRouter.use("*", dockerRbac);
bffDockerRouter.on(["POST", "DELETE"], "*", auditLog);
bffDockerRouter.all("*", proxyToSidecar("http://docker-bff:3010"));
```

The proxy strips the `/bff/docker` prefix and forwards the remainder of the path plus query string to the sidecar. The `X-User-Context` header is attached (same pattern as the standard BFF). The sidecar logs the `X-User-Context` for audit.

---

## 4. Frontend Component Hierarchy

```
DockerFleetManagerApp              (root — wraps AppProvider)
├── AppProvider                    (from @oneplatform/app-sdk)
└── FleetLayout
    ├── FleetSidebar               (tab nav: Containers, Images, Networks, Volumes)
    └── FleetContent
        ├── ContainerListView      (default view)
        │   ├── ContainerToolbar   (search input, filter by status, refresh button)
        │   ├── ContainerTable     (shadcn Table with sortable columns)
        │   │   └── ContainerRow   (one row per container)
        │   │       ├── StatusBadge
        │   │       └── ActionMenu (start/stop/restart/remove via DropdownMenu)
        │   └── ContainerDetailPanel (right sheet, opens on row click)
        │       ├── ContainerDetailTabs  (Tabs: Overview, Logs, Stats)
        │       │   ├── OverviewTab     (inspect data: env, mounts, networks, ports)
        │       │   ├── LogsTab         (LogViewer with search/filter, SSE stream)
        │       │   └── StatsTab        (StatsSparklines: CPU %, memory bar)
        │       └── ContainerActionBar  (start/stop/restart/remove buttons)
        ├── ImageListView
        │   └── ImageTable
        ├── NetworkListView
        │   └── NetworkTable
        └── VolumeListView
            └── VolumeTable
```

### State management

All server state is fetched via a custom `dockerApiClient` (a thin wrapper around the platform's BFF client that prefixes paths with `/bff/docker`). This is NOT an `@oneplatform/app-sdk` hook because Docker entities are not in the ontology. Instead, we implement lightweight React hooks using `useState` + `useEffect` + `AbortController`, following the same patterns the SDK uses internally.

Custom hooks the app defines:

| Hook | What it does |
|------|-------------|
| `useContainers(filter?)` | Polls `GET /bff/docker/containers` every 5s |
| `useContainer(id)` | Fetches single container detail |
| `useContainerLogs(id, tail)` | Streams `GET /bff/docker/containers/{id}/logs` via EventSource |
| `useContainerStats(id)` | Streams `GET /bff/docker/containers/{id}/stats` via EventSource |
| `useImages()` | Polls `GET /bff/docker/images` every 30s |
| `useNetworks()` | Polls `GET /bff/docker/networks` every 30s |
| `useVolumes()` | Polls `GET /bff/docker/volumes` every 30s |

### UI Components used from platform

From `@oneplatform/frontend` (shadcn/ui wrappers):

- `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableCell` — container/image lists
- `Badge` — status indicator (running/exited/paused/created)
- `Button` — action buttons
- `Dialog` — confirmation dialogs for destructive actions
- `Sheet` — right-side detail panel
- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` — detail view tabs
- `Input` — search filter
- `Skeleton` — loading states
- `DropdownMenu` — per-row action menus
- `Tooltip` — icon button labels

### Status badge colour mapping

| Docker status | Badge variant | Display text |
|--------------|---------------|-------------|
| `running` | `success` (green) | Running |
| `exited` | `destructive` (red) | Exited |
| `paused` | `warning` (yellow) | Paused |
| `created` | `secondary` (gray) | Created |
| `restarting` | `warning` (yellow) | Restarting |
| `dead` | `destructive` (red) | Dead |

---

## 5. API Endpoint Specification

All endpoints are exposed by the Docker BFF Sidecar at `http://docker-bff:3010`. The App Service BFF Proxy adds the `/bff/docker` prefix when called from the browser. Internal callers hit the sidecar directly at `/containers`, `/images`, etc.

All responses follow the OnePlatform envelope: `{ data: T }` or `{ error: { code, message } }`.

### 5.1 Containers

#### `GET /containers`

Lists all containers (running and stopped).

**Query params:**
- `status` — filter: `running`, `exited`, `paused`, `created`, `all` (default: `all`)
- `name` — substring filter on container name

**Response `200`:**
```typescript
{ data: DockerContainer[] }
```

**Sidecar implementation:** calls Docker API `GET /containers/json?all=true` and maps response to `DockerContainer`.

---

#### `GET /containers/{id}`

Full container inspect.

**Response `200`:**
```typescript
{ data: DockerContainerDetail }
```

**Sidecar implementation:** calls Docker API `GET /containers/{id}/json`.

**Errors:** `404 CONTAINER_NOT_FOUND`

---

#### `GET /containers/{id}/logs`

SSE stream of container log output.

**Query params:**
- `tail` — number of lines to return from history (default: `100`)
- `timestamps` — include Docker timestamps (default: `false`)

**Response:** SSE stream.

```
event: log
data: {"stream":"stdout","line":"2026-06-22T10:00:00.000Z server listening on :8080","ts":"2026-06-22T10:00:00.000Z"}

event: log
data: {"stream":"stderr","line":"WARN: connection reset by peer","ts":"..."}

event: done
data: {"reason":"container_stopped"}
```

Stream closes when:
- The container stops (`done` event with `reason: container_stopped`)
- The client disconnects
- The sidecar reconnect timeout fires (30s of no output from Docker daemon)

**Sidecar implementation:** calls Docker API `GET /containers/{id}/logs?follow=true&stdout=true&stderr=true&tail={tail}&timestamps={timestamps}` as a streaming HTTP response, converts the Docker log multiplexing format (8-byte header prefix) into clean SSE events.

---

#### `GET /containers/{id}/stats`

SSE stream of live CPU and memory statistics.

**Response:** SSE stream, one event per second.

```
event: stats
data: {"cpuPercent":12.4,"memoryUsageBytes":134217728,"memoryLimitBytes":536870912,"memoryPercent":25.0,"blockRead":0,"blockWrite":4096,"netRx":1024,"netTx":512,"ts":"2026-06-22T10:00:01.000Z"}
```

Stream closes when the container stops or the client disconnects.

**Sidecar implementation:** calls Docker API `GET /containers/{id}/stats?stream=true`, parses the CPU delta calculation (Docker reports cumulative CPU ticks, not percentage), emits one SSE event per Docker stats object.

**CPU percentage calculation:**
```
cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage
systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage
cpuPercent = (cpuDelta / systemDelta) * numCpus * 100.0
```

---

#### `POST /containers/{id}/start`

Starts a stopped container.

**Response `204`** (no body on success).

**Errors:** `404 CONTAINER_NOT_FOUND`, `409 CONTAINER_ALREADY_RUNNING`

---

#### `POST /containers/{id}/stop`

**Request body (optional):**
```typescript
{ timeoutSeconds?: number }  // default: 10
```

**Response `204`**

**Errors:** `404 CONTAINER_NOT_FOUND`, `409 CONTAINER_NOT_RUNNING`

---

#### `POST /containers/{id}/restart`

**Request body (optional):**
```typescript
{ timeoutSeconds?: number }  // default: 10
```

**Response `204`**

**Errors:** `404 CONTAINER_NOT_FOUND`

---

#### `DELETE /containers/{id}`

Removes a stopped container. The sidecar returns `422 CONTAINER_RUNNING` if the container is still running (preventing accidental data loss — the user must stop it first).

**Response `204`**

**Errors:** `404 CONTAINER_NOT_FOUND`, `422 CONTAINER_RUNNING`

---

### 5.2 Images

#### `GET /images`

**Response `200`:** `{ data: DockerImage[] }`

**Sidecar implementation:** calls `GET /images/json` on Docker daemon.

---

#### `DELETE /images/{id}`

Removes an untagged image that is not used by any container.

**Response `204`**

**Errors:** `404 IMAGE_NOT_FOUND`, `409 IMAGE_IN_USE`, `422 IMAGE_HAS_TAGS`

---

### 5.3 Networks

#### `GET /networks`

**Response `200`:** `{ data: DockerNetwork[] }`

---

### 5.4 Volumes

#### `GET /volumes`

**Response `200`:** `{ data: DockerVolume[] }`

---

## 6. Data Models

TypeScript interfaces defined in `examples/docker-fleet-manager/src/types/docker.ts`:

```typescript
// Returned by GET /containers — summary view
export interface DockerContainer {
  id: string;                          // full 64-char container ID
  shortId: string;                     // first 12 chars
  name: string;                        // human name without leading /
  image: string;                       // image name:tag
  imageId: string;
  status: ContainerStatus;
  statusText: string;                  // Docker's raw status string e.g. "Up 3 hours"
  ports: ContainerPort[];
  createdAt: string;                   // ISO 8601
  startedAt: string | null;
  labels: Record<string, string>;
  networks: string[];                  // network names
}

export type ContainerStatus =
  | "running"
  | "exited"
  | "paused"
  | "created"
  | "restarting"
  | "dead";

export interface ContainerPort {
  privatePort: number;
  publicPort: number | null;
  type: "tcp" | "udp" | "sctp";
  ip: string | null;
}

// Returned by GET /containers/{id} — full inspect
export interface DockerContainerDetail extends DockerContainer {
  hostname: string;
  entrypoint: string[];
  command: string[];
  envVars: Record<string, string>;     // parsed from KEY=VALUE pairs
  mounts: ContainerMount[];
  restartPolicy: string;
  networkSettings: ContainerNetworkSettings;
  platform: string;
  sizeRootFs: number | null;           // bytes; null if not computed
}

export interface ContainerMount {
  type: "bind" | "volume" | "tmpfs";
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

export interface ContainerNetworkSettings {
  networks: Record<string, {
    networkId: string;
    ipAddress: string;
    gateway: string;
    macAddress: string;
  }>;
}

// Returned by stats SSE
export interface ContainerStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  ts: string;
}

// Image models
export interface DockerImage {
  id: string;                          // full image ID
  shortId: string;
  repoTags: string[];                  // ["nginx:latest", "nginx:1.25"]
  repoDigests: string[];
  sizeBytes: number;
  virtualSizeBytes: number;
  createdAt: string;
  labels: Record<string, string>;
}

// Network models
export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;                      // "bridge", "overlay", "host", "none"
  scope: string;                       // "local", "swarm"
  ipam: {
    driver: string;
    config: { subnet: string; gateway: string }[];
  };
  internal: boolean;
  attachable: boolean;
  containers: Record<string, { name: string; ipAddress: string }>;
  createdAt: string;
}

// Volume models
export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  labels: Record<string, string>;
  options: Record<string, string>;
  usageData: { size: number; refCount: number } | null;
  createdAt: string;
}
```

---

## 7. Real-Time Updates

Docker does not emit webhook-style push events that integrate with the OnePlatform Redis pub/sub channel. Instead we use two mechanisms:

### Polling

All list views poll on an interval:

| View | Interval | Rationale |
|------|----------|-----------|
| Container list | 5 seconds | Status changes are user-visible and expected to be near-real-time |
| Image list | 30 seconds | Images change infrequently |
| Network list | 30 seconds | Networks change infrequently |
| Volume list | 30 seconds | Volumes change infrequently |

Polling is implemented as a `setInterval` inside the custom hooks. Intervals are cleared on component unmount and when the browser tab is hidden (`document.visibilityState === 'hidden'`), resumed when the tab returns to focus. This mirrors the pattern in `AppProvider`'s permission cache refresh.

### SSE Streams

Logs and stats are pushed from the Docker daemon via SSE streams (not polling). The `useContainerLogs` and `useContainerStats` hooks use `EventSource` pointed at `/bff/docker/containers/{id}/logs` and `/bff/docker/containers/{id}/stats` respectively.

The App Service BFF Docker Proxy handles SSE passthrough: it pipes the chunked streaming response from the sidecar directly to the browser using Hono's streaming response API. No buffering occurs at the proxy layer.

### No WebSocket for Docker events

Docker provides an event stream via `GET /events` on its API. We deliberately do not expose this:
- The event stream can be high volume and expensive to proxy for multiple browser clients
- The frontend does not need atomic event ordering — periodic polling is sufficient for the UI
- SSE is simpler to implement and debug

If a future version requires sub-second container status updates, we can add a Docker events listener in the sidecar that fans out to a Redis pub/sub channel, which the App Service then delivers to browsers via the existing WebSocket infrastructure.

---

## 8. Security Design

### Threat model

The Docker socket grants root-equivalent access to the host OS. Any code that can call arbitrary Docker API methods can escape container isolation. This is the primary risk we mitigate.

### Mitigations

**1. Least-privilege role requirement**

The App Service BFF Docker Proxy requires the user to have either the `admin` or `devops` platform role before any Docker API call reaches the sidecar. Regular platform users (`platform-user` role) receive `403 PERMISSION_DENIED` even before the request leaves the App Service.

```typescript
// services/app/src/routes/bff-docker.ts
function dockerRbac(): MiddlewareHandler {
  return async (c, next) => {
    const session = c.get("session");  // set by sessionAuth middleware
    const allowed = session.roles.some(r => r === "admin" || r === "devops");
    if (!allowed) {
      return c.json({ error: { code: "PERMISSION_DENIED", message: "Docker Fleet Manager requires admin or devops role." } }, 403);
    }
    await next();
  };
}
```

**2. Sidecar validates service token**

The sidecar accepts requests only from the App Service. It validates `X-Service-Token` using `@oneplatform/core`'s `serviceAuth` middleware. This prevents any other service or a direct HTTP call from reaching the Docker socket.

**3. Read-only mount for read operations**

The Docker socket is mounted `read-only` to the sidecar container. Destructive sidecar operations (stop, restart, remove) call the Docker daemon over the same socket because the Unix socket itself does not enforce read-only — however, the sidecar enforces operation whitelisting: only the endpoints defined in Section 5 are implemented. Any unknown path returns `404`. No generic proxy to the full Docker API.

**4. No exec or shell access**

The sidecar does not implement `POST /containers/{id}/exec` or any shell-related endpoints. There is no mechanism to run arbitrary commands in containers from the UI.

**5. Container remove guard**

`DELETE /containers/{id}` returns `422 CONTAINER_RUNNING` if the container is still running. The user must explicitly stop it before removal. This prevents one-click deletion of running services.

**6. Audit logging for destructive actions**

The App Service BFF Docker Proxy logs every `POST` and `DELETE` request to the Logging Service before forwarding to the sidecar. The audit record includes: `userId`, `tenantId`, `action` (start/stop/restart/remove), `containerId`, `containerName`, `timestamp`. Read operations (`GET`) are not audited.

**7. Rate limiting**

The Gateway applies the standard platform rate limit tier to all authenticated users. Additionally, the App Service BFF Docker Proxy applies a per-user rate limit of 20 action requests per minute for the `/bff/docker` prefix (using the same Redis-backed rate limiter pattern as guest session issuance). This prevents a compromised session from issuing a flood of container stop commands.

**8. Scope: this app is access_mode = platform-user only**

The Docker Fleet Manager app is registered with `accessMode: "platform-user"`. Guest sessions are never granted access. The App Service enforces this at the serving layer before the bundle even loads.

**9. Docker socket on the sidecar only**

No other service receives the Docker socket mount. The App Service, Gateway, and all other services do not have it. The blast radius of a compromise is limited to the sidecar process.

---

## 9. File Structure

```
examples/docker-fleet-manager/
├── README.md
├── package.json                        # name: docker-fleet-manager, version: 0.1.0
├── tsconfig.json                       # strict, target ES2020, jsx react-jsx
├── manifest.json                       # OnePlatform app manifest (see below)
└── src/
    ├── index.tsx                       # AppProvider root mount
    ├── App.tsx                         # FleetLayout + router
    ├── types/
    │   └── docker.ts                   # DockerContainer, DockerImage, etc.
    ├── client/
    │   └── dockerApiClient.ts          # thin fetch wrapper for /bff/docker/*
    ├── hooks/
    │   ├── useContainers.ts
    │   ├── useContainer.ts
    │   ├── useContainerLogs.ts
    │   ├── useContainerStats.ts
    │   ├── useImages.ts
    │   ├── useNetworks.ts
    │   └── useVolumes.ts
    ├── components/
    │   ├── layout/
    │   │   ├── FleetLayout.tsx
    │   │   └── FleetSidebar.tsx
    │   ├── containers/
    │   │   ├── ContainerListView.tsx
    │   │   ├── ContainerToolbar.tsx
    │   │   ├── ContainerTable.tsx
    │   │   ├── ContainerRow.tsx
    │   │   ├── ContainerDetailPanel.tsx
    │   │   ├── ContainerDetailTabs.tsx
    │   │   ├── OverviewTab.tsx
    │   │   ├── LogsTab.tsx
    │   │   ├── LogViewer.tsx
    │   │   ├── StatsTab.tsx
    │   │   ├── StatsSparklines.tsx
    │   │   ├── ContainerActionBar.tsx
    │   │   └── ActionConfirmDialog.tsx
    │   ├── images/
    │   │   ├── ImageListView.tsx
    │   │   └── ImageTable.tsx
    │   ├── networks/
    │   │   ├── NetworkListView.tsx
    │   │   └── NetworkTable.tsx
    │   ├── volumes/
    │   │   ├── VolumeListView.tsx
    │   │   └── VolumeTable.tsx
    │   └── shared/
    │       ├── StatusBadge.tsx         # container status → Badge variant
    │       ├── ByteSize.tsx            # format bytes to human-readable
    │       ├── PortList.tsx            # render port mappings
    │       └── RefreshButton.tsx       # manual refresh with loading state

services/docker-bff/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                        # Hono server, port 3010
    ├── middleware/
    │   └── serviceAuth.ts              # validates X-Service-Token
    ├── docker/
    │   └── dockerClient.ts             # dockerode wrapper
    ├── routes/
    │   ├── containers.ts               # container CRUD + start/stop/restart
    │   ├── images.ts
    │   ├── networks.ts
    │   └── volumes.ts
    ├── transforms/
    │   ├── containerTransform.ts       # Docker API → DockerContainer
    │   ├── imageTransform.ts
    │   ├── networkTransform.ts
    │   └── volumeTransform.ts
    └── __tests__/
        ├── containers.test.ts
        └── transforms.test.ts

services/app/src/routes/
└── bff-docker.ts                       # new file: BFF proxy for /bff/docker/*
```

### manifest.json

```json
{
  "name": "Docker Fleet Manager",
  "slug": "docker-fleet-manager",
  "description": "View and manage Docker containers, images, volumes, and networks.",
  "version": "0.1.0",
  "accessMode": "platform-user",
  "requiredRoles": ["admin", "devops"],
  "allowedModules": [
    "react",
    "react-dom",
    "@oneplatform/app-sdk"
  ],
  "entrypoint": "/src/index.tsx"
}
```

---

## 10. Implementation Priority

### Phase A — Backend foundation (implement first; no frontend dependency)

1. `services/docker-bff/` skeleton: Hono server, `serviceAuth` middleware, dockerode connection
2. `GET /containers` and `GET /containers/{id}` endpoints with transforms
3. `POST /containers/{id}/start|stop|restart` and `DELETE /containers/{id}`
4. `GET /images`, `GET /networks`, `GET /volumes`
5. `GET /containers/{id}/logs` SSE stream
6. `GET /containers/{id}/stats` SSE stream with CPU% calculation
7. Unit tests for transforms and routes (mock dockerode)
8. `services/app/src/routes/bff-docker.ts`: session validation, RBAC, audit log, proxy
9. Register bff-docker route in App Service router

### Phase B — Frontend core (can start after Phase A items 1-3 are done)

10. `dockerApiClient.ts` and all custom hooks (polling + SSE)
11. `ContainerListView` with `ContainerTable` and `StatusBadge`
12. `ContainerDetailPanel` with `OverviewTab`
13. `ActionConfirmDialog` and `ContainerActionBar` wired to start/stop/restart/remove
14. `LogsTab` with `LogViewer` (SSE-based)

### Phase C — Completeness

15. `StatsTab` with `StatsSparklines` (SSE-based)
16. `ImageListView` and `ImageTable` with remove action
17. `NetworkListView` and `NetworkTable`
18. `VolumeListView` and `VolumeTable`
19. Search/filter in `ContainerToolbar`
20. Dark/light theme validation (follows platform CSS variables — no extra work if shadcn components are used directly)

### Phase D — Hardening

21. Integration test: Docker BFF Sidecar against a real Docker socket (using testcontainers or a Docker-in-Docker compose service)
22. Rate limit integration test
23. Audit log integration test
24. Load test: 10 concurrent SSE log streams

---

## 11. Technology Choices and Rationale

### dockerode (npm package)

The only mature, typed Node.js client for the Docker Engine API. Handles Unix socket communication, multiplexed log stream parsing, and streaming responses. The alternative (raw HTTP calls with `node-fetch` to the Unix socket via `socketPath` option) requires manually implementing the Docker log multiplexing protocol — `dockerode` already does this correctly.

### SSE over WebSocket for logs/stats

SSE is server-push only (one direction), which is all we need for logs and stats — the browser never sends data back. SSE reconnects automatically via the `EventSource` API. SSE works through HTTP/1.1 and HTTP/2 without the upgrade handshake overhead WebSocket requires. The existing App Service SSE infrastructure (build log stream, preview reload stream) already validates this pattern.

### Polling over WebSocket for list views

Container list changes (a container stopping, a new container starting) happen on human timescales — seconds. A 5-second poll interval provides adequate freshness without the complexity of subscribing to Docker's `/events` stream. The tradeoff is up to 5 seconds of latency on status changes, which is acceptable for an ops dashboard.

### Hono for the sidecar

Matches every other OnePlatform service. `@oneplatform/core` middleware (service auth, error handling, request ID) works with Hono without modification. The team already knows Hono. No reason to introduce a different framework.

---

## 12. Testing Strategy

### Unit tests — Docker BFF Sidecar

- **Transform functions** (`containerTransform.ts` etc.): pure input/output — test with realistic Docker API response fixtures captured from a live daemon. One test per Docker API quirk (e.g., null `PortBindings`, missing `NetworkSettings`).
- **Route handlers**: mock `dockerode` with Jest/Vitest mocks. Test: 200 happy path, 404 when container not found, 422 when trying to remove a running container, 403 when `X-Service-Token` absent.
- **CPU% calculation**: test against known Docker stats output with expected output.
- **SSE log stream**: test that the multiplexed Docker log format (8-byte header) is parsed correctly into `{stream, line}` objects.

### Unit tests — App Service BFF Docker Proxy

- RBAC middleware: user with `admin` role allowed, user with `viewer` role denied.
- Audit log: destructive actions (POST, DELETE) produce an audit record; GET does not.
- Proxy: forwards path + query string correctly, attaches `X-Service-Token`.

### Unit tests — Frontend hooks

- `useContainers`: polling sets up interval, clears on unmount, pauses when tab hidden.
- `useContainerLogs`: opens `EventSource`, appends log lines to state, closes on unmount.
- `useContainerStats`: accumulates stats window for sparkline rendering.

### Integration tests

- **Docker BFF Sidecar vs real Docker socket** (compose test service: `docker:dind`): create a test container, call `GET /containers`, verify it appears. Call `POST /containers/{id}/stop`, verify status changes to `exited`. Call `DELETE /containers/{id}`, verify 204.
- **End-to-end through App Service BFF**: simulate browser fetch to `/bff/docker/containers` with a valid session cookie through the App Service. Verify RBAC blocks non-admin users and allows admin users.

### Manual UI testing checklist (Phase D)

- Container list loads with correct status badges
- Clicking a container opens the detail panel with correct inspect data
- Log stream shows live output and auto-scrolls
- Stats tab shows CPU/memory updating every second
- Stop → container status changes to Exited within 10 seconds (next poll)
- Remove of running container shows error (422 message surfaced in UI)
- Remove of stopped container succeeds and row disappears from table
- Image list shows all local images with sizes formatted correctly
- Network list shows all networks with subnet info
- Theme follows platform theme (test in both dark and light)
- Admin user can see all views; non-admin sees 403 error state on app load

---

## Appendix A: BFF Extension Point Details

The App Service does not currently have a documented mechanism for apps to register custom BFF routes. This design requires adding one. The recommended approach is to add a static `/bff/docker/*` route to the App Service router (not a dynamic per-app extension), gated behind the service configuration flag `OP_ENABLE_DOCKER_BFF=true` (default: `false`). This keeps the feature opt-in and prevents unexpected Docker socket exposure on deployments where the sidecar is not running.

The `bff-docker.ts` route module is imported conditionally:

```typescript
// services/app/src/index.ts
if (process.env.OP_ENABLE_DOCKER_BFF === "true") {
  const { bffDockerRouter } = await import("./routes/bff-docker.js");
  app.route("/bff/docker", bffDockerRouter);
}
```

The Docker BFF Sidecar URL is configured via `DOCKER_BFF_URL` environment variable (default: `http://docker-bff:3010`).

---

## Appendix B: Future Enhancements (not in scope for MVP)

- **`GET /containers/{id}/exec`** — terminal-in-browser (would require xterm.js and WebSocket piping; significant security review needed)
- **`GET /events` stream** — push-based container status updates instead of polling
- **Multi-host support** — configure multiple Docker hosts; sidecar becomes a router that dispatches to the right host
- **Compose stack view** — group containers by `com.docker.compose.project` label, show stack-level start/stop
- **Image pull** — `POST /images/pull` with progress SSE
- **Volume browser** — list files within a volume (requires `docker cp` equivalent)
