# OnePlatform Session Handoff — 2026-07-11 (Stale Container Investigation)

## IMPORTANT: Read These Docs After Every Compaction
1. `DEVELOPMENT-PROCESS.md` — Full dev pipeline
2. `docs/WORKING-STATE.md` — Current development state
3. This file (`.claude/handoff.md`) — Session continuity

## Latest Session — Stale Container Investigation (2026-07-11)

### What Was Done
Investigated three user-reported runtime blockers and traced all of them to stale Docker containers, not missing code fixes.

**Root cause:** The running dev-test containers were built on 2026-07-08. Commit bd38e0e (2026-07-10) had already fixed all three issues in source, but the containers never received those changes.

**Three bugs (all fixed in bd38e0e):**
1. **Connector marketplace empty** — envelope unwrap `g.data?.data??g.data` was the fix; connector list API returns `{data: {data: [...], total: N}}` double-wrapped.
2. **App builder crash on stat editing** — builder store was capturing `layout` from outer closure (stale snapshot); fix reads `s.layout` inside the `set()` callback.
3. **Code editor not showing files** — file API was returning `isDirectory: true` for files; fix sets `isDirectory: false` and the FileTree component filters `isDirectory === true` for folder icons.

**Actions taken:**
- Identified stale container timestamps via `docker inspect`
- Verified fixes present in JS source with `grep`
- Reverted any agent re-fix attempts (would have doubled the logic)
- Rebuilt `op-dev-test-frontend`, `op-dev-test-gateway`, `op-dev-test-ingestion` containers
- Resolved Docker build cache issue: `--no-cache` did not produce the correct frontend bundle (likely Vite/turborepo artifact); correct dist was copied from the host `packages/frontend/dist/` into the container
- Verified fix signatures in the served JavaScript bundle
- Fixed sandbox-vm Unix socket protocol mismatch (commit `1990001`):
  - Root cause: sandbox server (`docker/sandbox/src/server.js`) was sending raw JSON without length prefix, while the execution service's `UnixSocketClient` expected 4-byte big-endian uint32 length-prefixed frames
  - The first 4 bytes of raw JSON were read as a ~2GB length, exceeding the 12MB max, causing socket destruction every 10 seconds
  - Fix: rewrote sandbox server to use matching length-prefixed protocol AND added proper ping/drain method handlers
  - Result: eliminated 840 errors/hour crash loop — zero errors since fix
  - Rebuilt sandbox-vm container and restarted execution service

### Current Container State
- `op-dev-test-frontend`: rebuilt 2026-07-11 05:58, dist copied from host
- `op-dev-test-gateway`: rebuilt 2026-07-11 05:58
- `op-dev-test-ingestion`: rebuilt 2026-07-11 05:58
- `op-dev-test-sandbox-vm`: rebuilt 2026-07-11 07:09, socket protocol fixed
- `op-dev-test-execution`: restarted 2026-07-11 07:12
- All other 14 containers: unchanged, healthy
- **Total: all 19 containers healthy**

### Outstanding / User Action Required
All services are error-free. The user should verify the browser experience:
1. **Connector marketplace** — navigate to Connectors → Marketplace; expect 5 built-in connectors listed
2. **App builder stat editing** — open an app, edit a stat component's value; should not crash
3. **Code editor file tree** — open code editor for an app; file tree should list files (not blank)
4. **Sandbox execution** — run a code execution in an app; should complete without socket errors

### Docker Build Cache Warning
After rebuilding with `docker build --no-cache`, the frontend bundle was still stale. Root cause not fully diagnosed — Vite or Turborepo may cache outputs outside the Docker layer context. If this recurs:
```bash
# Clean host build artifacts before Docker build
rm -rf packages/frontend/dist packages/frontend/.turbo
pnpm --filter @oneplatform/frontend build
docker build -f docker/Dockerfile.frontend -t op-frontend .
```

### Key Files
- `packages/frontend/src/pages/ConnectorsPage.tsx` — marketplace envelope unwrap
- `packages/frontend/src/stores/builder-store.ts` — layout read inside `set()` callback
- `packages/frontend/src/components/editor/FileTree.tsx` — `isDirectory === true` check
- `docker/docker-compose.dev-test.yml` — dev-test stack definition

---

# Prior Session — 2026-06-24 (Bootstrap Setup Wizard Fix)

## What Was Done
Fixed the bootstrap setup wizard failure (two root causes):
1. **Redis ACL** — `op_auth` user was missing the `&events:*` channel permission in `docker/redis/users.acl.template`, causing a `NOPERM` error when publishing `bootstrap.completed` events.
2. **Error resilience** — In `services/auth/src/services/bootstrap-service.ts`, moved `clearInMemoryToken()` to run after `events.publish()` and wrapped the event publish in a try/catch so a publish failure no longer aborts bootstrap completion.

### Key Files Changed
- `docker/redis/users.acl.template`
- `services/auth/src/services/bootstrap-service.ts`
- Commit: da0b76b

---

# Prior Session — 2026-06-23 (Phase 19 COMPLETE)

## Current State
**Phase 19 — ALL sub-phases COMPLETE**

### Key Directives (from user)
- Agents and sub-agents for EVERYTHING
- Full dev flow with detailed plans and todos
- Commit often, push often
- No compromise on quality
- Low-code/no-code first — usable by non-coders
- Autonomous operation

### Phase 19 Summary
| Task | Status | Description |
|------|--------|-------------|
| 19.1 | COMPLETE | Isolated dev-test Docker Compose stack (22 services) |
| 19.2 | COMPLETE | All Docker images built and validated |
| 19.3 | COMPLETE | Docker Fleet Manager app design (924 lines) |
| 19.4 | COMPLETE | Docker Fleet Manager implementation (sidecar + frontend + BFF proxy) |
| 19.5 | COMPLETE | Full system analysis — 130 findings (16C, 59H, 47M, 8L) |
| 19.6 | COMPLETE | All 130 findings fixed, 25/25 builds, 29/29 tests |
| 19.7 | COMPLETE | Docker crash-loop fixes, all 22 containers healthy |
| 19.8 | COMPLETE | Documentation and handoff updated |

### Dev-Test Stack Access
- **Frontend:** https://localhost:8443
- **Gateway API:** https://localhost:8443/api/v1/ (or http://localhost:4080)
- **PostgreSQL:** localhost:5532
- **Redis:** localhost:6479
- **MinIO Console:** localhost:9101
- **Grafana:** localhost:3101
- **Jaeger UI:** localhost:16687
- **Start:** `docker/dev-test-start.sh`
- **Stop:** `docker/dev-test-stop.sh`

### Docker Fleet Manager App
- Design: `docs/designs/docker-fleet-manager-app.md`
- Sidecar: `services/docker-bff/` (21 tests)
- Frontend: `examples/docker-fleet-manager/` (37 files)
- BFF Proxy: `services/app/src/routes/bff-docker.ts`
- Enabled via: `OP_ENABLE_DOCKER_BFF=true` in dev-test compose

### Build & Test Status
- 25/25 builds passing
- 29/29 test suites passing
- All 22 Docker containers healthy

### Blockers
None.
