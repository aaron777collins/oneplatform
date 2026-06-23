# Docker Fleet Manager

A OnePlatform-native app for inspecting and controlling Docker containers,
images, networks, and volumes from inside the platform UI — without a terminal.

> Design: [`docs/designs/docker-fleet-manager-app.md`](../../docs/designs/docker-fleet-manager-app.md)

## Architecture

```
Browser (this app)
  │  fetch("/bff/docker/…")  (same-origin, credentials: include)
  ▼
App Service  /bff/docker/*   — session validation + admin/devops RBAC + audit
  │  HTTP + X-Service-Token
  ▼
Docker BFF Sidecar (services/docker-bff, port 3010)
  │  Unix socket / TCP
  ▼
Docker daemon
```

The app uses `@oneplatform/app-sdk`'s `AppProvider` for the platform session and
permission model, but Docker data flows through a custom `dockerApiClient`
(Docker entities are not ontology entities, so the SDK data hooks don't apply).

## Features

- **Containers** — sortable table, status badges, port mappings, search + status
  filter, slide-over detail panel with Overview / Logs (SSE) / Stats (SSE) tabs,
  and Start / Stop / Restart / Remove actions with confirmation dialogs.
- **Images** — tags, short ID, human-readable size, created time.
- **Networks** — driver, scope, subnet, connected container count.
- **Volumes** — driver, mountpoint, size.

## Access control

Registered with `accessMode: platform-user` and `requiredRoles: [admin, devops]`.
The App Service rejects non-admin/devops users with `403` before any Docker call
is forwarded.

## Running

This is an example app. To enable the backend:

1. Run the `docker-bff` sidecar with the Docker socket mounted and
   `OP_SERVICE_TOKEN_SECRET` set.
2. Start the App Service with `OP_ENABLE_DOCKER_BFF=true`, the same
   `OP_SERVICE_TOKEN_SECRET`, and `DOCKER_BFF_URL=http://docker-bff:3010`.

Local dev of this frontend:

```bash
pnpm install
pnpm dev      # vite dev server
pnpm build    # production bundle
```
