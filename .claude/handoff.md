# OnePlatform Session Handoff — 2026-07-11 (Stale Container Investigation)

## IMPORTANT: Read These Docs After Every Compaction
1. `DEVELOPMENT-PROCESS.md` — Full dev pipeline
2. `docs/WORKING-STATE.md` — Current development state
3. This file (`.claude/handoff.md`) — Session continuity

## Latest Session — Stale Container Investigation, Sandbox Fix, Envelope Unwrap Sweep (2026-07-11)

### What Was Done

**1. Investigated 3 user-reported runtime blockers**
- Empty connector marketplace, app builder crash on stat editing, code editor not showing files
- Root cause: running containers built 2026-07-08, missing fixes from commit bd38e0e (2026-07-10)

**2. Rebuilt stale containers**
- Rebuilt `op-dev-test-frontend`, `op-dev-test-gateway`, `op-dev-test-ingestion`
- Resolved Docker build cache issue: `--no-cache` did not regenerate frontend bundle; correct dist was copied from host `packages/frontend/dist/` into the container

**3. Fixed sandbox-vm Unix socket protocol framing mismatch (commit `1990001`)**
- Root cause: `docker/sandbox/src/server.js` was sending raw JSON without a length prefix, while the execution service's `UnixSocketClient` expected 4-byte big-endian uint32 length-prefixed frames
- First 4 bytes of raw JSON were read as a ~2GB length, exceeding the 12MB max, causing socket destruction every 10 seconds
- Fix: rewrote sandbox server with matching length-prefixed protocol + added ping/drain method handlers
- Result: eliminated 840 errors/hour crash loop — zero errors since fix
- Rebuilt sandbox-vm container and restarted execution service

**4. Fixed response envelope unwrapping on 25 frontend pages (commits `bc8984b`, `fe56102`)**
- Root cause: gateway wraps responses as `{data: <payload>}`, but many API calls that return paginated lists get double-wrapped as `{data: {data: [...], total: N}}`; frontend pages were reading `.data` once and getting the inner envelope object instead of the array
- Pages fixed in `bc8984b`: ConnectorMarketplacePage, NewConnectorPage, PluginsPage
- Pages fixed in `fe56102`: 22 remaining pages including PipelinesPage, AppsPage, LogsPage, OntologyPage, MappingsPage, DataCatalogPage, MetricsPage, and 15 more
- Pattern applied: `response.data?.data ?? response.data` to handle both wrapped and unwrapped shapes

**5. Fixed builder store stale layout capture in all 9 mutations (commit `1df13ab`)**
- Root cause: builder store mutations (addComponent, updateComponent, deleteComponent, etc.) were capturing `layout` from the outer `get()` call result, then calling `set()` later — rapid prop edits would overwrite each other because the layout snapshot was stale by the time `set()` ran
- Fix: moved layout read inside each `set()` callback to always read `s.layout` from current state
- All 9 mutations updated; 26/26 builder store tests pass

**6. Started docker-bff and docker-socket-proxy containers**
- Docker Fleet Manager BFF sidecar and Docker socket proxy were stopped; both started

**7. Deployed fresh frontend build after each fix**
- Rebuilt frontend TypeScript, copied new dist into the running container after each batch of fixes

### Commits
| Hash | Description |
|------|-------------|
| `1990001` | fix: sandbox-vm length-prefixed framing + ping/drain handlers |
| `6161f47` | docs: update session notes |
| `bc8984b` | fix: envelope unwrap on marketplace, new connector, plugins pages |
| `1df13ab` | fix: builder store reads layout inside set() to prevent stale closure |
| `fe56102` | fix: envelope unwrap on 22 remaining frontend pages |

### Current Container State
- `op-dev-test-frontend`: rebuilt 2026-07-11, dist redeployed after each fix batch
- `op-dev-test-gateway`: rebuilt 2026-07-11 05:58
- `op-dev-test-ingestion`: rebuilt 2026-07-11 05:58
- `op-dev-test-sandbox-vm`: rebuilt 2026-07-11 07:09, socket protocol fixed
- `op-dev-test-execution`: restarted 2026-07-11 07:12
- `op-dev-test-docker-bff`: started this session
- `op-dev-test-docker-socket-proxy`: started this session
- All other containers: unchanged, healthy
- **Total: 21 containers running, all healthy**

### System Health at Session End
- All 9 services OK with sub-15ms latency
- Zero errors across all services for 45+ minutes
- Frontend build passes, 26/26 builder store tests pass

### Outstanding / User Action Required
The user should verify the browser experience (Authelia credentials required):
1. **Connector marketplace** — navigate to Connectors → Marketplace; expect 5 built-in connectors listed
2. **App builder stat editing** — open an app, edit a stat component's value; should not crash
3. **Code editor file tree** — open code editor for an app; file tree should list files (not blank)
4. **Sandbox execution** — run a code execution in an app; should complete without socket errors

### Docker Build Cache Warning
After rebuilding with `docker build --no-cache`, the frontend bundle was still stale. Root cause not fully diagnosed — Vite or Turborepo may cache outputs outside the Docker layer context. If this recurs:
```bash
rm -rf packages/frontend/dist packages/frontend/.turbo
pnpm --filter @oneplatform/frontend build
docker build -f docker/Dockerfile.frontend -t op-frontend .
```

### Key Files
- `packages/frontend/src/pages/ConnectorsPage.tsx` — marketplace envelope unwrap
- `packages/frontend/src/pages/` (all 25 pages) — envelope unwrap sweep
- `packages/frontend/src/stores/builder-store.ts` — stale layout closure fix
- `packages/frontend/src/components/editor/FileTree.tsx` — `isDirectory === true` check
- `docker/sandbox/src/server.js` — length-prefixed framing fix
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
