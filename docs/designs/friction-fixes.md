# Friction Fixes Design

**Date**: 2026-06-14
**Status**: REVISED — all 5 blocking issues resolved, all 7 warnings addressed, 6 suggestions incorporated
**Findings addressed**: 30 (1 CRITICAL, 10 HIGH, 13 MEDIUM, 9 LOW — one LOW from the prompt list is counted against the HIGH and MEDIUM counts where items were grouped)

## Revision notes (post-review)

Five blocking issues and seven warnings were raised against the previous revision. This section records what was wrong and what was added. The full corrected sections are inline below.

**BLOCKING-1 (OA-4)**: The previous text said "update all service healthcheck commands" without enumerating which services or what the exact YAML looked like. Added an explicit nine-service diff table with the exact before/after YAML for every `test:` line.

**BLOCKING-2 (OA-6)**: The previous text described the split design but omitted: (a) what happens to the exported `Config` type, (b) the complete list of nine service `index.ts` callers, (c) the exact intermediate-state migration commit strategy, and (d) how the existing `config.test.ts` tests must change. All four points are now specified.

**BLOCKING-3 (CC-1)**: The previous text asserted the transport unwraps `{ data: T }` without showing the code. The `transport.ts` `executeRequest()` method (lines 322–328) explicitly checks `if (envelope.data !== undefined) { return envelope.data; }` before returning `parsed`. This means the transport layer unwraps the top-level `data` envelope automatically. The `list()` callback receives the unwrapped value, not the envelope. However, the service list response shape is `{ data: [], pagination: {} }` — the transport sees a top-level `data` field and returns the array directly, stripping the `pagination` object. The Paginator callback must receive both. The fix is to NOT rely on the transport's envelope unwrapping for list endpoints — instead type the response as `{ data: T[]; pagination: { nextCursor: string | null; total: number | null } }`, which the transport will unwrap at the `data` key, losing the pagination. The correct fix is to have `list()` use a raw fetch path that bypasses envelope unwrapping, or restructure the service response so pagination is at the top level. The exact resolution is documented in the updated CC-1 section.

**BLOCKING-4 (DE-2)**: The diff route handler was described in prose only. Added the exact code replicating the ForbiddenError scope check pattern from `entities.ts`.

**BLOCKING-5 (PA-5)**: The dev-mode tenant restriction was described as prose. Added the exact server-side guard code that enforces `tenantId` equality.

**Warnings addressed**: OA-1 Zod fallback note added; OA-3 `deploy.replicas` caveat added; OA-5 docker.sock replaced with file-based log collection; AD-7 URL validation in BffClient constructor added; Batch E dependency wording clarified; DE-2 breaking API change noted; OA-8 `sleep 2` replaced with LASTSAVE polling.

**Suggestions incorporated**: DE-9 entity-type caching for `resolveFieldId`; PA-4 scoped to error message improvement only (sandbox implementation deferred); CC-3 grep commands added; PA-2 `_note` moved to README.md instead; OA-11 `internal: true` already present noted; AD-3 `enum` field type added to TYPE_MAP.

---

## Verification summary

All 30 friction findings were verified against the live source code before designs were written.
Key discoveries that changed the fix scope:

- **OA-1 (MinIO CHANGE_ME)**: The `CHANGE_ME` validation in `docker/init/init.sh` only scans files written to `/data/init/`. `OP_MINIO_PASSWORD` is read from the Docker Compose environment, not written to `init-data`. The validation never sees it. This is the actual gap.
- **CC-1 (API path split)**: Confirmed three divergent path families: SDK uses `/api/v1/ontologies` (plural), CLI uses `/api/v1/ontology/entities` or `/api/v1/ontology/validate`, service routes are on `/api/v1/ontology`. The gateway must alias both families or one canonical path must be chosen.
- **DE-2 (diff signature)**: SDK `diff(fromVersion, toVersion)` sends `GET /api/v1/ontologies/diff?from=&to=` — no such route exists in the service. CLI `diff(entityType, --file)` sends `POST /api/v1/ontology/entities/:entityType/diff` — also no such route. The service exposes no diff route at all currently. Both need a consistent endpoint added.
- **DE-9 (mapping UUIDs)**: Confirmed. `mapping create --target-field` accepts a UUID. The service schema at `services/ingestion/src/schemas/index.ts` line 141 expects this as `targetFieldId`. There is no slug-to-ID resolution in the CLI.
- **PA-1 (testing import)**: `packages/plugin-sdk/package.json` exposes `"./testing"` export pointing to `dist/testing/index.js`. The path `@oneplatform/plugin-sdk/testing` is valid. However, the scaffold template in `scaffold.ts` emits `createMockContext` usage but not an actual import resolution issue at the package level — the issue is that the generated plugin's `devDependencies` in `buildPackageJson()` lists `"@oneplatform/plugin-sdk": "*"` but `esbuild` is absent (PA-3), so `npm run build` fails. The test import path itself resolves correctly if the SDK is built.
- **OA-4 (health path inconsistency)**: Confirmed. Plugin service uses `/health/live` and `/health/ready`. All other services use `/healthz` and `/readyz`. The docker-compose healthchecks poll `/health/live` on all services — this means only the plugin service would return a valid response; all others return 404 from the healthcheck.
- **AD-2 (AppProvider error UI)**: Confirmed. The error UI at line 248 of `AppProvider.tsx` uses inline `style={{ color: "red" }}` with no class names, no design system tokens, no accessible `aria-live` region, and a non-descript button label "Retry".
- **AD-7 (BffClient same-origin)**: `BffClient` constructor hardcodes `window.location.origin` as `baseUrl`. This prevents usage in React Native, embedded iframes with cross-origin BFF hosts, or Electron-style hybrid apps.
- **OA-6 (loadConfig requires all env vars)**: Confirmed. `loadConfig()` runs `configSchema.safeParse(process.env)` where `configSchema` requires `OP_MASTER_KEY`, `OP_JWT_SECRET`, `OP_CURSOR_SECRET`, `OP_DATABASE_URL`, and `OP_REDIS_URL` unconditionally. Every service that imports `@oneplatform/core` fails at startup if any of these are absent, even if a service only needs two of them.

---

## Batch assignment and parallelism

Fixes are grouped into five implementation batches. Batches A through D can be executed in parallel by different agents. Batch E depends on Batch A completing first (the canonical path definition must exist before gateway aliases are added).

```
Batch A (CRITICAL + security):         OA-1, OA-2, OA-3, OA-10, OA-11
Batch B (API contract unification):    CC-1, DE-1, DE-2, DE-3, CC-3
Batch C (CLI usability):               DE-5, DE-9, DE-4, DE-6, DE-7, DE-8
Batch D (SDK / AppProvider / Apps):    AD-1, AD-2, AD-3, AD-5, AD-6, AD-7
Batch E (Plugin developer experience): PA-1, PA-2, PA-3, PA-4, PA-5, PA-6, PA-7
Batch F (Operations):                  OA-4, OA-5, OA-6, OA-7, OA-8, OA-9, CC-2, AD-4
```

Batch E depends on Batch B completing first. The dependency is: CC-1 in Batch B establishes the canonical SDK path (`/api/v1/ontology`). PA-1 in Batch E generates test files that import from `@oneplatform/plugin-sdk/testing`, and the plugin SDK's testing utilities internally call the ontology client. If the SDK path is still `/api/v1/ontologies` (wrong) during test generation, generated integration tests will call the wrong endpoint. Batch B must be merged and its path change must be in the installed SDK version before Batch E starts. Batch F is independent of all others and can run in parallel with A–E.

---

## CRITICAL

### OA-1: MinIO password startup validation

**Complexity**: S

**Root cause**: `docker/init/init.sh` validates that no `CHANGE_ME` strings exist inside `/data/init/`, but `OP_MINIO_PASSWORD` is injected via Docker Compose `environment:` block — never written to `/data/init/`. The validation is blind to it.

**Files to modify**:
- `docker/service-entrypoint.sh`
- `.env.example`
- `packages/core/src/config.ts`

**Changes**:

1. In `docker/service-entrypoint.sh`, add a guard immediately after the `op-init ready` check:

```sh
# Guard: reject the placeholder MinIO password that ships in .env.example.
# OP_MINIO_PASSWORD is injected via docker-compose environment: and is
# not visible to op-init. Validate it here before secrets are loaded.
if [ "${OP_MINIO_PASSWORD:-}" = "CHANGE_ME_minio" ] || [ -z "${OP_MINIO_PASSWORD:-}" ]; then
  echo "[service-entrypoint] FATAL: OP_MINIO_PASSWORD is unset or still set to the placeholder value." >&2
  echo "[service-entrypoint] Set a strong password in .env before running docker compose up." >&2
  exit 1
fi
```

2. In `packages/core/src/config.ts`, tighten the `OP_MINIO_PASSWORD` schema from `.optional()` to reject the placeholder in production:

```ts
OP_MINIO_PASSWORD: z.string()
  .optional()
  .refine(
    (v) => {
      if (process.env["NODE_ENV"] === "production" && (!v || v === "CHANGE_ME_minio")) {
        return false;
      }
      return true;
    },
    { message: "OP_MINIO_PASSWORD must be set to a non-placeholder value in production" }
  ),
```

**Note (WARNING-1)**: This Zod check is a secondary fallback for non-Compose deployments (e.g., bare Node.js or Kubernetes) where the `service-entrypoint.sh` guard does not run. In the standard Docker Compose deployment path, the entrypoint check in step 1 fires first and exits before the Node process starts, making the Zod check unreachable. Both layers are kept because (a) they serve different deployment topologies and (b) defense-in-depth dictates two independent checks for a credential this sensitive.

3. In `.env.example`, replace the comment block above `OP_MINIO_PASSWORD` with an explicit warning comment that reads:
```
# REQUIRED before first `docker compose up`. Generate with: openssl rand -hex 32
# This value IS validated at service startup. The placeholder will cause all
# services to refuse to start.
OP_MINIO_PASSWORD=CHANGE_ME_minio
```

**Security implications**: Without this fix, a deployment with the default `.env.example` values has an unguarded MinIO admin credential. MinIO's admin API allows bucket creation and deletion, which affects all stored plugin bundles, app assets, and audit logs.

**Testing**: Add a unit test in `packages/core/src/__tests__/config.test.ts` that verifies `loadConfig()` throws when `NODE_ENV=production` and `OP_MINIO_PASSWORD` is the placeholder string.

---

## HIGH

### CC-1: Canonical API path unification

**Complexity**: L

**Root cause**: Three path families exist in the codebase simultaneously:
- SDK (`packages/sdk/src/resources/ontologies.ts` line 31): `BASE = '/api/v1/ontologies'` (plural)
- CLI (`packages/cli/src/commands/ontology/index.ts` lines 25–36): `/api/v1/ontology/entities` and `/api/v1/ontology/validate`
- Service (`services/ontology/src/routes/entities.ts` line 38): `/api/v1/ontology` (singular, no `/entities` suffix)

**Decision**: The service routes are the authoritative definition. Migrate both SDK and CLI to align with the service path family. The canonical paths are:

| Operation | Canonical path |
|---|---|
| List entities | `GET /api/v1/ontology` |
| Get entity | `GET /api/v1/ontology/:entityType` |
| Create entity | `POST /api/v1/ontology` |
| Update entity | `PATCH /api/v1/ontology/:entityType` |
| Delete entity | `DELETE /api/v1/ontology/:entityType` |
| Validate schema | `POST /api/v1/ontology/validate` |
| Diff entity | `POST /api/v1/ontology/:entityType/diff` (new — see DE-2) |
| Migrations | `GET/POST /api/v1/ontology/migrations` (already correct) |
| Migration rollback | `POST /api/v1/ontology/migrations/:id/rollback` |

**Files to modify**:
- `packages/sdk/src/resources/ontologies.ts`: Change `BASE` from `/api/v1/ontologies` to `/api/v1/ontology`. Update `list()` to expect the `data` array field (the service wraps the list in `{ data: [], pagination: {} }`, but the SDK Paginator expects `items`). Update `validate()` path from `${BASE}/validate` to `/api/v1/ontology/validate`.
- `packages/cli/src/commands/ontology/index.ts`: Remove the `/entities` suffix from all paths. `listAction` → `GET /api/v1/ontology`, `getAction` → `GET /api/v1/ontology/:entityType`, `createAction` → `POST /api/v1/ontology`, `updateAction` → `PATCH /api/v1/ontology/:entityType` (currently uses `PUT` — change to `PATCH` to match service), `deleteAction` → `DELETE /api/v1/ontology/:entityType`, `validateAction` → `POST /api/v1/ontology/validate`.

**SDK Paginator response shape mismatch — BLOCKING-3 resolution**:

The transport layer in `packages/sdk/src/transport.ts` (lines 322–328) automatically unwraps a top-level `{ data: T }` envelope before returning to callers:

```ts
// packages/sdk/src/transport.ts, executeRequest(), lines 322–328
const envelope = parsed as { data?: T };
if (envelope.data !== undefined) {
  return envelope.data;
}
return parsed as T;
```

This means `transport.request<OntologySchema[]>({ ... })` called against the list endpoint returns the array directly. However, the service returns `{ data: [...], pagination: { nextCursor, total } }` — the transport sees `envelope.data` as the array and returns it, discarding the `pagination` object. The `list()` Paginator callback therefore loses the cursor information entirely.

The current SDK ontologies `list()` types the response as `{ items: OntologySchema[]; nextCursor: string | null; total: number | null }` — but the transport will attempt to unwrap `data` from that expected shape. Since the actual response has `data` not `items`, the transport unwraps `data` (the array) and the caller receives an array, not an object with `items`.

**The correct fix**: Type the `transport.request` call to match what the transport actually returns after unwrapping. The transport unwraps `{ data: X }` to return `X`. So for the list endpoint, the transport must be told the return type is the full response object — bypass unwrapping by using a type that does not have a top-level `data` key that the transport would interpret as the envelope. The service response has `data` and `pagination` at the same level. Since the transport checks `if (envelope.data !== undefined)`, it will unwrap the `data` array and drop `pagination`.

**Resolution**: Change the list route in `services/ontology/src/routes/entities.ts` to return the pagination fields at the top level alongside a renamed `items` key, so the transport's `data` unwrap does not collide:

```ts
// services/ontology/src/routes/entities.ts — list route response:
return c.json({
  data: {
    items: result.data.map(/* ... */),
    nextCursor: result.nextCursor,
    total: result.data.length,
    hasMore: result.nextCursor !== null,
  },
});
```

Now the transport unwraps the top-level `data` envelope, and the `list()` callback receives `{ items, nextCursor, total, hasMore }` — exactly the shape the Paginator expects.

The SDK `list()` then types the request correctly:

```ts
list(options?: ListOptions): PaginatedIterable<OntologySchema> {
  const pageSize = options?.limit ?? 50;
  return new Paginator<OntologySchema>(async (cursor, limit) => {
    // transport.request unwraps { data: { items, nextCursor, total, hasMore } }
    // so the callback receives { items, nextCursor, total, hasMore } directly.
    const result = await transport.request<{
      items: OntologySchema[];
      nextCursor: string | null;
      total: number | null;
      hasMore: boolean;
    }>({
      method: 'GET',
      path: BASE,
      query: { limit, ...(cursor !== null ? { cursor } : {}) },
    });
    return result; // shape matches PageFetcher<T> contract
  }, pageSize);
},
```

Apply the same `{ data: { items, nextCursor, ... } }` response pattern to all other list endpoints (`connectors`, `apps`, `plugins`, `data`) — or verify each returns the nested shape already. Use `grep -rn '"data".*\[\]' services/*/src/routes/*.ts` to find list routes that still return a flat `{ data: [] }` top-level array.

**Security implications**: None from the path change itself. Ensure the gateway does not inadvertently expose both `/api/v1/ontologies` and `/api/v1/ontology` as separate upstream routes during any transition period.

**Testing**: Update integration tests in `tests/level3/auth-to-ontology.test.ts` to confirm the canonical path family. Run `pnpm test` after changes to verify no broken SDK or CLI tests.

---

### CC-2: Getting-started documentation

**Complexity**: M

**Files to create** (do not modify existing files):
- `docs/quickstart/platform-admin.md`
- `docs/quickstart/data-engineer.md`
- `docs/quickstart/app-developer.md`
- `docs/quickstart/plugin-developer.md`

**Content per file**: Each quickstart must cover exactly: (1) prerequisites, (2) installation/setup (3 commands maximum), (3) first working example with expected output, (4) next steps links. They must not exceed 150 lines.

**Platform Admin quickstart** covers: `docker compose up`, bootstrap token extraction, first admin creation via `op auth login`, and verifying `op service health`.

**Data Engineer quickstart** covers: `op auth login`, `op ontology create --file schema.json`, `op connector create`, `op connector trigger`, `op mapping create`.

**App Developer quickstart** covers: `npm create @oneplatform/app`, `op app create`, `op app dev`, expected `window.__OP_APP_CONFIG__` shape.

**Plugin Developer quickstart** covers: `op plugin create` (interactive), `npm install`, `npm run build`, `op plugin simulate-hook before:ingestion.receive --input data.json`, `op plugin pack`.

**Security implications**: None.

**Testing**: Verify commands shown in each quickstart execute without error against a running stack using the level-3 test environment.

---

### DE-9: Mapping rules require field UUIDs

**Complexity**: M

**Root cause**: `op mapping create --target-field` requires a UUID (the `targetFieldId`). Users must first call `op ontology get <entity-type>` and parse the JSON to find a field's UUID, which is not a human workflow.

**Files to modify**:
- `packages/cli/src/commands/mapping/index.ts`

**Change**: In `createAction`, before building the POST body, add a slug-to-ID resolution step. If `opts.targetField` does not match a UUID pattern (`/^[0-9a-f-]{36}$/`), treat it as a field slug and resolve it:

```ts
async function resolveFieldId(
  entityType: string,
  fieldSlugOrId: string,
  ctx: CommandContext,
): Promise<string> {
  // If it already looks like a UUID, use it directly.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fieldSlugOrId)) {
    return fieldSlugOrId;
  }
  // Fetch the entity schema and find the field by slug.
  const entity = await ctx.http.get<{
    fields: Array<{ id: string; slug: string; name: string }>
  }>(`/api/v1/ontology/${encodeURIComponent(entityType)}`);
  const field = entity.fields.find(
    (f) => f.slug === fieldSlugOrId || f.name.toLowerCase() === fieldSlugOrId.toLowerCase()
  );
  if (!field) {
    throw new CliError(
      `Field "${fieldSlugOrId}" not found on entity "${entityType}". ` +
      `Run "op ontology get ${entityType}" to list available field slugs.`,
      EXIT.GENERAL,
    );
  }
  return field.id;
}
```

Call `resolveFieldId(entityType, opts.targetField, ctx)` before constructing the POST body, and update the `targetFieldId` in the body to the resolved ID.

**Entity type caching (SUGGESTION DE-9)**: If the user creates multiple mapping rules in a single CLI session targeting the same entity type (e.g., a loop or piped input), `resolveFieldId` will make one GET request per field lookup. Add a simple in-process Map cache keyed on `tenantId:entityType` to avoid redundant fetches within the same CLI invocation:

```ts
const entitySchemaCache = new Map<string, Array<{ id: string; slug: string; name: string }>>();

async function resolveFieldId(
  entityType: string,
  fieldSlugOrId: string,
  ctx: CommandContext,
): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fieldSlugOrId)) {
    return fieldSlugOrId;
  }
  const cacheKey = `${ctx.tenantId}:${entityType}`;
  let fields = entitySchemaCache.get(cacheKey);
  if (!fields) {
    const entity = await ctx.http.get<{
      fields: Array<{ id: string; slug: string; name: string }>
    }>(`/api/v1/ontology/${encodeURIComponent(entityType)}`);
    fields = entity.fields;
    entitySchemaCache.set(cacheKey, fields);
  }
  const field = fields.find(
    (f) => f.slug === fieldSlugOrId || f.name.toLowerCase() === fieldSlugOrId.toLowerCase()
  );
  if (!field) {
    throw new CliError(
      `Field "${fieldSlugOrId}" not found on entity "${entityType}". ` +
      `Run "op ontology get ${entityType}" to list available field slugs.`,
      EXIT.GENERAL,
    );
  }
  return field.id;
}
```

The cache is process-scoped (lives only for the duration of the CLI command invocation) and requires no eviction logic.

Also update the CLI help text for `--target-field` to read: `"UUID or slug of the target ontology entity field"`.

**Security implications**: The resolution adds one extra GET call with `ontology:read` scope, which the caller must already have to list mappings. No privilege escalation.

**Testing**: Unit test the `resolveFieldId` helper with mock HTTP responses. Integration test: create a mapping using a field slug and verify it is stored with the correct UUID.

---

### AD-1: `app init` command

**Complexity**: M

**Root cause**: `op plugin create` exists (with interactive scaffold in `packages/plugin-sdk/src/dev/scaffold.ts`), but `op app create` only creates an app record server-side — it does not scaffold a local project. Developers have no starting point for an app project.

**Files to modify**:
- `packages/cli/src/commands/app/index.ts`

**New command to add**: `op app init` — scaffolds a local app project. This is a local operation only (no HTTP call at scaffold time). It creates:
- `package.json` with `@oneplatform/app-sdk` dependency
- `src/App.tsx` — minimal React component using `AppProvider` and `useQuery`
- `src/index.ts` — entry point calling `ReactDOM.render(<App />)`
- `tsconfig.json` — extends from a sensible base with `jsx: "react-jsx"`
- `vite.config.ts` — with `@oneplatform/app-sdk` external, output `dist/bundle.js`
- `app.manifest.json` — with `name`, `version`, `entrypoint: "dist/bundle.js"` fields

**Implementation pattern**: Follow the same embedded-template approach used in `packages/plugin-sdk/src/dev/scaffold.ts` — no filesystem template files, all content as string constants.

**New file to create**: `packages/app-sdk/src/dev/scaffold.ts` — exports `generateAppScaffold(opts: AppScaffoldOptions): AppScaffoldResult` where `AppScaffoldOptions = { name: string; slug: string; outputDir: string }` and `AppScaffoldResult = { outputDir: string; files: Array<{ relativePath: string; content: string }> }`.

**Registration**: In `registerApp()`, add:
```ts
app.command("init")
  .description("Scaffold a new app project locally")
  .requiredOption("--name <name>", "App display name")
  .option("--slug <slug>", "URL slug (kebab-case; derived from name if omitted)")
  .option("--out <dir>", "Output directory (default: ./<slug>)")
  .action(withContext<[AppInitOpts]>(initAction));
```

The `initAction` writes the scaffold files locally (analogous to `plugin create`'s file-writing loop) and prints next-step instructions including `op app create --name <name> --slug <slug>` as the server-side registration step.

**Security implications**: Pure local file write — no security surface.

**Testing**: Unit test `generateAppScaffold()` to verify all expected files are returned with non-empty content. Integration test: run `op app init --name "Test App"` and verify directory structure.

---

### PA-1: Test template imports non-existent module path

**Complexity**: S

**Root cause**: The scaffold template at `packages/plugin-sdk/src/dev/scaffold.ts` line 455 emits:
```ts
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
```
This path (`@oneplatform/plugin-sdk/testing`) is defined in `packages/plugin-sdk/package.json` under `exports["./testing"]` and is valid when the SDK is built. The real issue is that the scaffolded plugin's `package.json` (generated by `buildPackageJson()`) lists `"@oneplatform/plugin-sdk": "*"` in `devDependencies` but does not include `esbuild` (PA-3). Running `npm install && npm run build` in the scaffolded project fails because the `build` script calls `tsc`, not `esbuild`, and the test file cannot locate the testing export until the SDK is locally linked or published.

The actual fix for PA-1 is to add a comment in the generated test file explaining the dependency requirement:

```ts
// import { createMockContext } from "@oneplatform/plugin-sdk/testing";
// Requires @oneplatform/plugin-sdk to be built and linked (npm link or workspace).
// Run `npm install` then `npm run test` after resolving the SDK.
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
```

Additionally, update the `buildTestSource()` scaffold template to include `@vitest/globals` and use `import type` where appropriate so the test compiles without the SDK being resolved at tsc type-check time.

**Files to modify**:
- `packages/plugin-sdk/src/dev/scaffold.ts`: Update `buildPackageJson()` to add `esbuild` to `devDependencies` (see PA-3) and update `buildTestSource()` to add a resolution note comment at the top of the generated test file.

**Security implications**: None.

**Testing**: Verify the generated test file compiles when `@oneplatform/plugin-sdk` is installed.

---

### PA-4: `--sandbox` flag exits with unhelpful message

**Complexity**: S

**Root cause**: In `packages/plugin-sdk/src/dev/simulate-hook.ts` line 185:
```ts
process.stderr.write("[sandbox mode not available in SDK — install isolated-vm in the CLI]\n");
process.exit(1);
```
This message is accurate but tells the user nothing about how to actually enable sandbox mode.

**Files to modify**:
- `packages/plugin-sdk/src/dev/simulate-hook.ts`

**Change**: Replace the terse message with a diagnostic that tells the user exactly what to do:

```ts
process.stderr.write(
  "[simulate-hook] Sandbox mode requires the 'isolated-vm' package.\n" +
  "  Install it in your plugin project: npm install --save-dev isolated-vm\n" +
  "  Then re-run with: op plugin simulate-hook --sandbox ...\n" +
  "  Note: isolated-vm requires a C++ build toolchain (node-gyp).\n" +
  "  Without --sandbox, the default vm.Script mode provides adequate isolation for development.\n"
);
process.exit(1);
```

**Scope clarification (SUGGESTION PA-4)**: The fix for PA-4 is limited to the improved error message only. Implementing a full `isolated-vm` sandbox execution branch is out of scope for this friction-fix batch — it requires designing the host/guest communication protocol, memory limits, timeout enforcement, and capability injection, which is a standalone design effort. The error message improvement is a one-line-of-code change that provides immediate value regardless of whether sandbox execution is ever implemented. Add a `TODO(sandbox)` comment in the code pointing to the deferred design ticket.

**Security implications**: None.

**Testing**: Verify the error message appears when `--sandbox` is passed without `isolated-vm` installed.

---

### OA-2: docker-compose.yml exposes all internal service ports

**Complexity**: S

**Root cause**: Every application service in `docker/docker-compose.yml` has a `ports:` block that binds the container port to `0.0.0.0` on the host. Services on ports 3001–3008 are internal implementation details — only the gateway (3000) and frontend (8080) should be reachable from the host.

**Files to modify**:
- `docker/docker-compose.yml`

**Change**: Remove the `ports:` block from all services except `gateway-service` (port 3000) and `frontend` (port 8080). The internal services communicate over the `oneplatform-internal` bridge network using Docker service names, so no host-side binding is needed.

For local debugging scenarios where a developer needs to reach an internal service directly, add commented-out `ports:` blocks with a comment explaining that they exist for debugging only and must not be enabled in production:

```yaml
# auth-service:
#   ports:
#     # DEBUG ONLY — disable in production. Internal services reach auth-service
#     # via the oneplatform-internal Docker network, not the host.
#     - "127.0.0.1:3001:3000"
```

Note that the debug ports should bind to `127.0.0.1` rather than `0.0.0.0` so they are only reachable from the local machine even when enabled.

**Security implications**: The current configuration exposes database-adjacent services to any network interface the host has. Removing the bindings means an attacker who reaches the host network cannot directly contact the auth service, plugin service, or ingestion service. This is a significant attack surface reduction.

**Testing**: After the change, verify that `docker compose up` starts successfully and that `op auth login` works through the gateway. Verify that `curl http://localhost:3001/healthz` returns `Connection refused`.

---

### OA-3: No docker-compose.prod.yml

**Complexity**: M

**Root cause**: No production-specific compose override exists.

**File to create**: `docker/docker-compose.prod.yml`

This file is a Docker Compose override (`docker compose -f docker-compose.yml -f docker-compose.prod.yml up`). It must:

1. Set `NODE_ENV: production` on all services (it is already set in docker-compose.yml; verify it is not overridden anywhere).
2. Add resource limits appropriate for a single-node production deployment (increase gateway memory to `1g`, increase ingestion to `2g`, set explicit CPU quotas).
3. Do NOT add `deploy.replicas` to `docker-compose.prod.yml`. Docker Compose running in standalone mode (the common single-node case) silently ignores the entire `deploy:` key, including `replicas`. Adding it would create a false impression of HA where none exists and would produce no error to warn the operator. Instead, add a comment block at the top of the file:
```yaml
# ── Scaling note ────────────────────────────────────────────────────────────
# This file does NOT set deploy.replicas. In standalone Docker Compose,
# the deploy: key is silently ignored. For horizontal scaling, use:
#   - Docker Swarm:     docker stack deploy -c docker-compose.yml \
#                                          -c docker-compose.prod.yml op
#   - Kubernetes:       convert with kompose and set replicaCount in Helm values
# The resource limits below (memory/cpu) ARE respected in standalone Compose.
```
4. Override the logging driver to `json-file` with `max-size: 200m` and `max-file: 10` for longer retention.
5. Add environment variable overrides that reject the `.env.example` defaults:
```yaml
gateway-service:
  environment:
    OP_ALLOWED_ORIGINS: ${OP_ALLOWED_ORIGINS:?Must set OP_ALLOWED_ORIGINS for production}
    OP_BASE_URL: ${OP_BASE_URL:?Must set OP_BASE_URL for production}
```
The `:?` syntax causes Docker Compose to fail with a clear error message if these are unset.

6. Include a comment header explaining how to use the file and what each override does.

**Security implications**: The `:?` required-variable syntax prevents launching production with defaults. This is the primary security control the file adds beyond documentation.

**Testing**: Run `docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml config` to verify the merged config is valid.

---

### OA-10: POSTGRES_PASSWORD defaults to weak value

**Complexity**: S

**Root cause**: `.env.example` sets `POSTGRES_PASSWORD=dev_postgres_superuser`. The docker-compose.yml uses `${POSTGRES_PASSWORD:-dev_postgres_superuser}` so this is also the Docker default if `.env` is absent. There is no startup validation that rejects this in production.

**Files to modify**:
- `docker/docker-compose.prod.yml` (new file, see OA-3)
- `.env.example`

**Change**:

1. In `.env.example`, update the comment above `POSTGRES_PASSWORD` to explicitly state:
```
# REQUIRED to be changed in production. Generate with: openssl rand -hex 32
# The value below is the development default and is rejected by docker-compose.prod.yml.
POSTGRES_PASSWORD=dev_postgres_superuser
```

2. In `docker/docker-compose.prod.yml`, override the postgres environment to require a non-default password:
```yaml
postgres:
  environment:
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Must set a strong POSTGRES_PASSWORD for production. Generate with: openssl rand -hex 32}
```

3. In `docker/postgres/set-passwords.sh` (if it exists and sets per-service role passwords), add a check that `POSTGRES_PASSWORD` is not equal to `dev_postgres_superuser` when `NODE_ENV=production`.

**Security implications**: The postgres superuser password controls all database operations. A weak default in production would allow any host-network attacker to authenticate to postgres (if port 5432 were ever inadvertently exposed) with a guessable password.

**Testing**: Verify that `docker compose -f docker-compose.yml -f docker-compose.prod.yml up` fails with a clear error when `POSTGRES_PASSWORD` is absent from the environment.

---

## MEDIUM

### DE-1 and DE-2: SDK ontology namespace path and diff signature

**Complexity**: M (both together)

**DE-1**: Covered by CC-1. Once `BASE` is changed from `/api/v1/ontologies` to `/api/v1/ontology`, DE-1 is resolved.

**DE-2 (diff signature)**: The SDK `diff(fromVersion, toVersion)` queries `GET /api/v1/ontology/diff?from=&to=`. No such route exists in the service. The CLI `diff` sends `POST /api/v1/ontology/entities/:entityType/diff` with the proposed schema as the body — also no such route exists.

The correct design for a schema diff is: given an entity type and a proposed schema body, return the set of changes relative to the current live schema. This is a write-shaped operation (body required) so it should be `POST`.

**Files to modify**:
- `packages/sdk/src/resources/ontologies.ts`: Change `diff()` signature to:
  ```ts
  diff(entityTypeId: string, proposedSchema: UpdateOntologyRequest): Promise<OntologyDiff>;
  ```
  Implementation: `POST /api/v1/ontology/${encodeURIComponent(entityTypeId)}/diff` with `proposedSchema` as the body.

- `services/ontology/src/routes/entities.ts`: Add a `POST /api/v1/ontology/:entityType/diff` route immediately after the `validate` route (line 205). This route requires `ontology:read` scope (it is non-mutating). Replicate the exact scope-check pattern from existing routes in the same file — see `routes.get("/api/v1/ontology")` at line 38 for the reference pattern. The exact code to add:

```ts
routes.post("/api/v1/ontology/:entityType/diff", async (c) => {
  const user = c.var.user;
  // Scope check: same pattern as other ontology:read routes in this file
  if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
    throw new ForbiddenError("ontology:read scope is required.");
  }

  const entityType = c.req.param("entityType");
  const body = await c.req.json();
  const parsed = patchEntityRequest.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid diff request body", parsed.error.issues);
  }

  const result = await entityService.diffEntity(user.tenantId, entityType, parsed.data);
  return c.json({
    changes: result.changes,
    isBreaking: result.isBreaking,
    requiresMigration: result.requiresMigration,
  });
});
```

The response shape:
```ts
{
  changes: Array<{ op: "add" | "remove" | "modify"; path: string; from?: unknown; to?: unknown }>;
  isBreaking: boolean;
  requiresMigration: boolean;
}
```

This requires adding `diffEntity(tenantId, entityType, patch)` to the `EntityService` interface and its implementation.

- `packages/cli/src/commands/ontology/index.ts`: `diffAction` is already close to correct — it sends `POST /api/v1/ontology/entities/:entityType/diff`. Change path to `POST /api/v1/ontology/:entityType/diff` (remove `/entities`).

**Breaking SDK API change (WARNING-6)**: The SDK `diff(fromVersion, toVersion)` signature is being replaced by `diff(entityTypeId, proposedSchema)`. This is a breaking change to the public SDK API. Before landing:

1. In `packages/sdk/src/resources/ontologies.ts`, mark the old `diff(fromVersion, toVersion)` overload as deprecated with a JSDoc tag: `@deprecated Use diff(entityTypeId, proposedSchema) instead. Will be removed in SDK v1.0.`.
2. Keep the old signature as a no-op that throws a `ClientError` with a descriptive message if called with two string arguments (no valid `proposedSchema`).
3. Add the new signature alongside.
4. Update the `OntologyNamespace` interface type to include both (transitionally), then remove the old one in a separate commit tagged as breaking.
5. Document this in `CHANGELOG.md` under a `### Breaking Changes` header.

The two-signature interim form:
```ts
// In OntologyNamespace interface:
/** @deprecated Use diff(entityTypeId, proposedSchema) */
diff(fromVersion: string, toVersion: string): Promise<OntologyDiff>;
/** Compute a non-destructive diff of proposedSchema against the live entity schema. */
diff(entityTypeId: string, proposedSchema: UpdateOntologyRequest): Promise<OntologyDiff>;
```

**Testing**: Add a route-level unit test for the new diff endpoint. Verify the CLI diff output matches the expected format. Verify the deprecated SDK form throws with a descriptive message.

---

### DE-3: CLI ontology commands hit different paths than service routes

**Complexity**: S

**Root cause**: Covered by CC-1. The CLI uses `/api/v1/ontology/entities` while the service routes are on `/api/v1/ontology`. Removing the `/entities` suffix from all CLI paths resolves DE-3 simultaneously with CC-1.

No separate changes are needed beyond what CC-1 specifies.

---

### DE-5: CLI connector update cannot change credentials or sync mode

**Complexity**: S

**Root cause**: In `packages/cli/src/commands/connector/index.ts`, the `UpdateOpts` interface is:
```ts
interface UpdateOpts { name?: string; config?: string }
```
The service `PATCH /api/v1/connectors/:id` (in `services/ingestion/src/routes/connectors.ts` line 110–111) accepts `credentials` and `syncMode` in the update body. The CLI simply does not expose these options.

**Files to modify**:
- `packages/cli/src/commands/connector/index.ts`

**Change**: Update `UpdateOpts` and `updateAction`:

```ts
interface UpdateOpts {
  name?: string;
  config?: string;
  credentials?: string;
  syncMode?: "full" | "incremental";
  enabled?: boolean;
}
```

In `updateAction`, add:
```ts
if (opts.credentials) body["credentials"] = JSON.parse(readFileSync(opts.credentials, "utf8")) as Record<string, string>;
if (opts.syncMode) body["syncMode"] = opts.syncMode;
if (opts.enabled !== undefined) body["isEnabled"] = opts.enabled;
```

In `registerConnector`, update the `connector update` command registration:
```ts
.option("--credentials <credentials.json>", "Path to JSON file with updated credentials")
.option("--sync-mode <mode>", "New sync mode: full | incremental")
.option("--enabled", "Enable the connector")
.option("--no-enabled", "Disable the connector")
```

**Security implications**: Credentials are passed as a file path (not inline), consistent with the `create` command. The file is read once and the contents are sent in the PATCH body (encrypted server-side). No change to the security model.

**Testing**: Integration test: create a connector, update its credentials and sync mode, verify `op connector get` reflects the changes.

---

### AD-2: AppProvider error UI unstyled and unhelpful

**Complexity**: S

**Root cause**: The error block in `packages/app-sdk/src/provider/AppProvider.tsx` (lines 248–264) uses bare inline styles, exposes raw error messages to end users in dev mode via an unstyled `<pre>`, and has an inaccessible "Retry" button with no `aria-` attributes. In production, it shows nothing except a bold label and the retry button.

**Files to modify**:
- `packages/app-sdk/src/provider/AppProvider.tsx`

**Change**: Replace the error render block with an accessible, self-contained component. This should not import any external CSS framework (the app-sdk has no UI dependency beyond React). Use CSS custom properties so host apps can theme it.

```tsx
if (initState.status === "error") {
  const isDev = typeof __OP_DEV__ !== "undefined" ? __OP_DEV__ : true;

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100dvh",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        backgroundColor: "var(--op-error-bg, #fff8f8)",
        color: "var(--op-error-fg, #333)",
      }}
    >
      <div
        style={{
          maxWidth: "480px",
          border: "1px solid var(--op-error-border, #fca5a5)",
          borderRadius: "8px",
          padding: "1.5rem",
          backgroundColor: "var(--op-error-surface, #fff)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
        }}
      >
        <p style={{ margin: "0 0 0.5rem", fontWeight: 600, fontSize: "1rem" }}>
          Unable to load the application
        </p>
        <p style={{ margin: "0 0 1rem", fontSize: "0.875rem", color: "var(--op-error-subtext, #666)" }}>
          {isDev
            ? initState.message
            : "The application failed to start. Please try again or contact support if the issue persists."}
        </p>
        <button
          type="button"
          aria-label="Retry loading the application"
          onClick={() => setRetryCount((n) => n + 1)}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: "6px",
            border: "1px solid var(--op-error-btn-border, #d1d5db)",
            background: "var(--op-error-btn-bg, #f9fafb)",
            cursor: "pointer",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
```

**Security implications**: The change preserves the `isDev` guard. Raw error messages (which may contain internal service URLs or auth configuration details) are still hidden in production builds.

**Testing**: Render the error state in a Storybook or Vitest browser test, verify `role="alert"` is present, verify the production build hides `initState.message`.

---

### AD-3: App-SDK type declarations are hardcoded, not generated

**Complexity**: M

**Root cause**: The `packages/app-sdk/src/types/entities.ts` defines `FilterSpec`, `QueryOptions`, `UserContext`, and related types as static TypeScript interfaces. App developers who want type-safe `useQuery<Customer>()` calls must manually declare a module augmentation file. The spec describes a "declaration injection mechanism" but no generator exists.

**Files to create**:
- `packages/app-sdk/src/dev/generate-types.ts` — exports a function `generateEntityTypes(entities: OntologyEntitySchema[]): string` that produces a TypeScript declaration file content.
- `packages/cli/src/commands/sdk/index.ts` — already exists; add a `sdk generate-types` subcommand.

**Schema for generated output**: Given entities from `GET /api/v1/ontology`, the generator produces a file `op-types.d.ts`:

```ts
// Auto-generated by `op sdk generate-types`. Do not edit.
declare module "@oneplatform/app-sdk" {
  interface EntityTypeMap {
    customer: {
      id: string;
      name: string;
      email: string;
      // ...generated from field definitions
    };
    order: {
      id: string;
      customerId: string;
      total: number;
    };
  }
}
```

App developers then call `useQuery<EntityTypeMap["customer"]>("customer")` for full type safety.

**CLI command** (`sdk generate-types`):
```ts
async function generateTypesAction(opts: { out?: string }, ctx: CommandContext): Promise<void> {
  const entities = await ctx.http.get<{ data: Array<{ slug: string; fields: Array<{ slug: string; fieldType: string; required: boolean }> }> }>(
    "/api/v1/ontology"
  );
  const content = generateEntityTypes(entities.data);
  const outPath = opts.out ?? "op-types.d.ts";
  writeFileSync(outPath, content, "utf8");
  ctx.renderer.success(`Type declarations written to ${outPath}`);
}
```

**Field type mapping** (from service `fieldType` strings to TypeScript types):
```ts
const TYPE_MAP: Record<string, string> = {
  "text": "string",
  "integer": "number",
  "float": "number",
  "boolean": "boolean",
  "datetime": "string", // ISO 8601
  "json": "Record<string, unknown>",
  "uuid": "string",
  "array": "unknown[]",
  // enum fields carry enumValues in their field definition.
  // The generator must handle this case specially: produce a union type
  // from the field's enumValues array rather than a scalar mapping.
  // If enumValues is present: `"value1" | "value2" | "value3"`
  // If enumValues is absent (malformed schema): fall back to string.
  "enum": "string", // overridden per-field when enumValues is present
};
```

When generating types, the `generateEntityTypes()` function must check for `enum` fields and generate a union literal type from `field.enumValues`:

```ts
function fieldToTs(field: { slug: string; fieldType: string; required: boolean; enumValues?: string[] }): string {
  let tsType: string;
  if (field.fieldType === "enum" && field.enumValues && field.enumValues.length > 0) {
    tsType = field.enumValues.map((v) => JSON.stringify(v)).join(" | ");
  } else {
    tsType = TYPE_MAP[field.fieldType] ?? "unknown";
  }
  const optional = field.required ? "" : "?";
  return `    ${field.slug}${optional}: ${tsType};`;
}
```

**Security implications**: The command requires `ontology:read` scope. Generated types are written to a local file on the developer's machine — no server-side effect.

**Testing**: Unit test `generateEntityTypes()` with fixture entities. Verify the output parses as valid TypeScript using `tsc --noEmit` on a file that imports it.

---

### AD-5: No SDK method for app deployment

**Complexity**: S

**Root cause**: `packages/sdk/src/resources/apps.ts` has a `deploy(id, buildId)` method that sets an existing build as the current deployment. It does not expose file upload deployment (posting a pre-built bundle). The CLI's `app deploy --file` uses multipart upload directly.

**Files to modify**:
- `packages/sdk/src/resources/apps.ts`

**Change**: Add an `uploadAndDeploy()` method alongside the existing `deploy()`:

```ts
interface AppsNamespace {
  // ... existing methods
  deploy(id: string, buildId: string): Promise<App>;
  /** Upload a pre-built bundle file and trigger a deployment. */
  uploadAndDeploy(id: string, bundle: Blob | Buffer, opts?: { env?: string }): Promise<{ deploymentId: string; buildId?: string }>;
}
```

Implementation: POST multipart form to `/api/v1/apps/${id}/deploy` with field `bundle` (the file) and optional `env` field.

```ts
async uploadAndDeploy(id, bundle, opts = {}) {
  const form = new FormData();
  const blob = bundle instanceof Buffer
    ? new Blob([bundle], { type: "application/octet-stream" })
    : bundle;
  form.append("bundle", blob, "bundle.js");
  if (opts.env) form.append("env", opts.env);
  return transport.requestMultipart<{ deploymentId: string; buildId?: string }>({
    method: "POST",
    path: `${BASE}/${encodeURIComponent(id)}/deploy`,
    body: form,
  });
}
```

This requires verifying that the `Transport` interface in `packages/sdk/src/transport.ts` supports multipart. If it does not, add a `requestMultipart()` method to the transport interface.

**Security implications**: None beyond existing app deploy authorization.

**Testing**: Verify the new method is exported from the SDK index. Integration test: upload a minimal bundle and verify the deployment ID is returned.

---

### AD-6: `app deploy --file` requires pre-built bundle with no format docs

**Complexity**: S

**Root cause**: The CLI help text for `app deploy --file` says "Local bundle path" with no indication of what format the bundle must be in, what the expected directory layout is, or how to build one.

**Files to modify**:
- `packages/cli/src/commands/app/index.ts`
- `docs/quickstart/app-developer.md` (new file, see CC-2)

**Change in CLI**: Update the `--file` option description and add a help note:

```ts
app.command("deploy")
  .description(
    "Deploy an app. Without --file, triggers a server-side build from the registered source.\n" +
    "With --file, uploads a pre-built bundle (.js ESM module, max 50MB).\n" +
    "Bundle format: ES module (type: module) exporting a default React component.\n" +
    "Build with: vite build --outDir dist (or esbuild — see docs/quickstart/app-developer.md)"
  )
  .argument("<slug>", "App URL slug")
  .option("--file <bundle-path>", "Pre-built ESM bundle path (see description for format)")
  // ...
```

**Documentation**: The app developer quickstart (CC-2) must include a section "Bundle format for `app deploy --file`" that specifies:
- Entry point: a single `.js` file
- Module type: ES module
- Default export: a React component accepting no props (platform passes context via `window.__OP_APP_CONFIG__`)
- Maximum file size: 50 MB
- Recommended build tool: `vite build` with `lib` mode or `esbuild --bundle --format=esm`
- The `@oneplatform/app-sdk` dependency must be externalized, not bundled

**Testing**: Verify that deploying a bundle built with the documented approach succeeds against a running stack.

---

### AD-7: BffClient hardcodes same-origin

**Complexity**: S

**Root cause**: `packages/app-sdk/src/client/BffClient.ts` line 97:
```ts
this.baseUrl = window.location.origin;
```
This means the SDK only works in browser environments where the BFF is on the same origin as the app.

**Files to modify**:
- `packages/app-sdk/src/client/BffClient.ts`
- `packages/app-sdk/src/provider/types.ts`
- `packages/app-sdk/src/provider/AppProvider.tsx`

**Change**: Add an optional `bffBaseUrl` prop to `AppProviderProps` and thread it through to the `BffClient` constructor. Add URL validation in the constructor so a misconfigured `bffBaseUrl` fails immediately at construction time rather than at the first request:

```ts
// types.ts
export interface AppProviderProps {
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;
  /**
   * Override the BFF base URL. Defaults to window.location.origin.
   * Set this when the BFF is hosted on a different origin (e.g. React Native,
   * Electron, or cross-origin iframe embeddings).
   * Must be an absolute URL (http:// or https://) with no trailing slash.
   * Warning: setting this to a third-party origin will send auth cookies cross-origin.
   * Ensure the target origin is trusted.
   */
  bffBaseUrl?: string;
  _testAppId?: string;
  _testTenantId?: string;
}

// BffClient.ts — change constructor to include URL validation:
constructor(bffBaseUrl?: string) {
  const resolved = bffBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  if (resolved !== "") {
    // Validate that the provided URL is well-formed and uses http or https.
    // new URL() throws a TypeError for malformed URLs, giving an early error.
    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      throw new Error(
        `[BffClient] bffBaseUrl "${resolved}" is not a valid URL. ` +
        `Provide an absolute URL such as "https://api.example.com".`
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `[BffClient] bffBaseUrl must use http or https, got "${parsed.protocol}".`
      );
    }
  }
  this.baseUrl = resolved.replace(/\/$/, ""); // strip trailing slash for consistent path joining
}
```

In `useProviderSingletons()`, accept and pass the `bffBaseUrl` to the `BffClient` constructor. Because `useProviderSingletons` is called with `React.useRef`, construct the client at first render only — passing the URL from `AppProvider`'s props. This requires lifting `bffBaseUrl` into the singletons hook:

```ts
function useProviderSingletons(bffBaseUrl?: string) {
  const bffClientRef = React.useRef<BffClient | null>(null);
  if (!bffClientRef.current) bffClientRef.current = new BffClient(bffBaseUrl);
  // ...
}
```

**Security implications**: The `redirect: "error"` policy in `BffClient.request()` remains unchanged. Allowing a configurable base URL means a misconfigured `bffBaseUrl` could send auth cookies to the wrong origin — document this clearly in the prop's JSDoc. The app developer is responsible for setting this correctly.

**Testing**: Unit test BffClient with `bffBaseUrl = "https://bff.example.com"` and verify the constructed URL uses that base. Verify the default still uses `window.location.origin` in browser environments.

---

### PA-3: esbuild not in scaffold devDependencies

**Complexity**: S

**Root cause**: `buildPackageJson()` in `packages/plugin-sdk/src/dev/scaffold.ts` generates `package.json` with `tsc` as the build script (`"build": "tsc --project tsconfig.json"`). The plugin pack step requires `esbuild` to bundle the plugin into `dist/bundle.js`, but neither `esbuild` nor the build script that calls `esbuild` is included in the scaffold output.

**Files to modify**:
- `packages/plugin-sdk/src/dev/scaffold.ts`

**Changes in `buildPackageJson()`**:

1. Add `esbuild` to `devDependencies`:
```ts
devDependencies: {
  "@oneplatform/plugin-sdk": "*",
  typescript: "^5.5.0",
  vitest: "^1.6.0",
  esbuild: "^0.21.0",  // ADD THIS
},
```

2. Update the `build` script to use esbuild for bundling (tsc remains for type-checking only):
```ts
scripts: {
  build: "esbuild src/index.ts --bundle --format=esm --outfile=dist/bundle.js --packages=external",
  "build:types": "tsc --project tsconfig.json --emitDeclarationOnly",
  dev: "esbuild src/index.ts --bundle --format=esm --outfile=dist/bundle.js --packages=external --watch",
  test: "vitest run",
  "test:watch": "vitest",
  pack: "op plugin pack",
  "type-check": "tsc --noEmit -p tsconfig.json",
},
```

The `--packages=external` flag tells esbuild to not bundle `@oneplatform/plugin-sdk` (it is injected at runtime by the execution environment).

**Security implications**: None.

**Testing**: Run the generated `npm run build` and verify `dist/bundle.js` is created. Verify `op plugin pack` succeeds on the scaffold output.

---

### PA-5: Plugin install requires platform-admin, no dev-mode alternative

**Complexity**: M

**Root cause**: `op plugin install` sends a multipart upload to `/api/v1/plugins` which requires `platform-admin` scope. Plugin developers iterating on a plugin must be granted `platform-admin` just to test their plugin, which is excessive.

**Design**: Add a `--dev` flag to `op plugin install` that installs the plugin in a tenant-scoped development mode, requiring only `plugins:manage` scope. A dev-mode installation:
- Is tagged as `dev: true` in the plugin record
- Is automatically scoped to the installer's tenant
- Does not go through the full approval workflow
- Is removed automatically after 7 days unless renewed

**Files to modify**:
- `packages/cli/src/commands/plugin/index.ts`
- `services/plugin/src/routes/index.ts` (or the relevant plugin service route file)

**CLI change**: Add `--dev` flag to the `plugin install` command:
```ts
plugin.command("install")
  .argument("<source>", "Local .oppkg path, HTTPS URL, or registry reference")
  .option("--tenant <id>", "Install for specific tenant")
  .option("--dev", "Install in development mode (tenant-scoped, no admin approval required, expires in 7 days)")
  .action(withContext<[string, InstallOpts]>(installAction));
```

In `installAction`, when `opts.dev` is true, append `?devMode=true` to the upload URL, skip the approval confirmation prompt, and print a warning that the installation expires.

**Service change**: In the plugin service route that handles `POST /api/v1/plugins`, check for `devMode=true` in the query string. If present, require only `plugins:manage` scope (not `platform-admin`) and enforce that the plugin is installed only for the caller's own tenant. The exact server-side guard code:

```ts
// services/plugin/src/routes/index.ts — POST /api/v1/plugins handler
routes.post("/api/v1/plugins", async (c) => {
  const user = c.var.user;
  const isDevMode = c.req.query("devMode") === "true";

  if (isDevMode) {
    // Dev-mode: requires only plugins:manage scope, but MUST be tenant-scoped.
    if (!user.scopes.includes("plugins:manage") && !user.scopes.includes("admin")) {
      throw new ForbiddenError("plugins:manage scope is required for dev-mode plugin installation.");
    }

    // Tenant enforcement: if a --tenant flag was passed in the request body,
    // reject it if it does not match the caller's own tenantId.
    // This prevents cross-tenant dev plugin installation even if the caller
    // somehow has a token scoped to a different tenant.
    const requestedTenantId = (await c.req.json()).tenantId as string | undefined;
    if (requestedTenantId !== undefined && requestedTenantId !== user.tenantId) {
      throw new ForbiddenError(
        "Dev-mode plugins can only be installed for your own tenant. " +
        `Requested tenantId "${requestedTenantId}" does not match ` +
        `authenticated tenantId "${user.tenantId}".`
      );
    }

    // Force tenantId to the caller's own tenant regardless of what was in the body.
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const plugin = await pluginService.installPlugin({
      /* ... parsed bundle fields ... */
      tenantId: user.tenantId, // ALWAYS the caller's tenant, never from request body
      dev: true,
      expiresAt,
    });
    return c.json(plugin, 201);
  }

  // Non-dev-mode: requires platform-admin scope as before.
  if (!user.scopes.includes("platform-admin") && !user.scopes.includes("admin")) {
    throw new ForbiddenError("platform-admin scope is required for plugin installation.");
  }
  // ... existing install logic ...
});
```

The key invariant is that `tenantId` is always set from `user.tenantId` (derived from the authenticated JWT), never from the request body. The request body's `tenantId` field is only validated for consistency (to surface programmer error in CLI tooling), not trusted for authorization.

**Security implications**: Dev-mode installations are tenant-scoped — they cannot affect other tenants. The 7-day expiry prevents forgotten dev plugins from accumulating. The tenant enforcement ensures that even if a user constructs a raw HTTP request with a different `tenantId` in the body, the service ignores it and installs for the authenticated tenant only. Scope reduction from `platform-admin` to `plugins:manage` is intentional and correct for plugin development.

**Testing**: Integration test: install a plugin with `--dev` using a user with only `plugins:manage` scope, verify it installs successfully for the caller's tenant. Verify a non-`--dev` install with the same scope fails with 403. Verify that supplying a different `tenantId` in the body returns 403 with a descriptive message.

---

### OA-4: Health endpoint path inconsistency

**Complexity**: S

**Root cause**: All services except the plugin service use `/healthz` and `/readyz` as their liveness and readiness endpoints. The plugin service uses `/health/live` and `/health/ready`. The docker-compose.yml healthchecks poll `http://localhost:3000/health/live` for all services — meaning every service except the plugin service returns a 404 from its healthcheck. All nine service `test:` lines must change.

**Verification**: Confirmed in `docker/docker-compose.yml`. Every application service `test:` line currently reads `wget -qO- http://localhost:3000/health/live || exit 1`. The nine services are: `gateway-service`, `auth-service`, `ingestion-service`, `ontology-service`, `pipeline-service`, `execution-service`, `app-service`, `logging-service`, `plugin-service`.

**Decision**: Standardize on `/healthz` and `/readyz` (consistent with Kubernetes conventions and what the core `health.ts` module already implements).

**Files to modify**:
- `services/plugin/src/routes/health.ts`: Rename `/health/live` → `/healthz`, `/health/ready` → `/readyz`.
- `services/plugin/src/index.ts`: Update `publicRoutes` from `["/health/live", "/health/ready"]` to `["/healthz", "/readyz"]`.
- `docker/docker-compose.yml`: Update ALL NINE service healthcheck `test:` lines from `/health/live` to `/healthz`. The complete diff is:

| Service | Current `test:` line | Replacement `test:` line |
|---|---|---|
| `gateway-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `auth-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `ingestion-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `ontology-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `pipeline-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `execution-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `app-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `logging-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |
| `plugin-service` | `"wget -qO- http://localhost:3000/health/live \|\| exit 1"` | `"wget -qO- http://localhost:3000/healthz \|\| exit 1"` |

Each service has its own `healthcheck:` block with its own `test:` line — each must be individually updated. The replacement `CMD-SHELL` block for every service follows this form exactly:
```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -qO- http://localhost:3000/healthz || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 20s
```

The `gateway-service` has `start_period: 20s` and `interval: 10s` — keep the existing interval/timeout/retries/start_period values per service unchanged; only the path within the `test:` string changes.

**Security implications**: None beyond fixing broken healthchecks (a broken healthcheck is a reliability risk, not a security risk directly).

**Testing**: After the change, run `docker compose up` and verify all services report `healthy` in `docker compose ps` output.

---

### OA-5: No centralized log aggregation in docker-compose

**Complexity**: M

**Root cause**: Each service uses the `json-file` Docker logging driver. Logs are spread across individual containers with no way to aggregate or query them centrally without `docker logs <container>`.

**File to modify**: `docker/docker-compose.yml`

**Design**: Add a Vector sidecar as a log aggregation collector. Vector is chosen because it:
- Has a single binary with no runtime dependencies
- Supports routing to multiple sinks (file, Loki, Elasticsearch) via config
- Has a minimal memory footprint (~20MB)

**WARNING-3 resolution — no docker.sock mount**: The docker_logs source in Vector requires mounting `/var/run/docker.sock` into the Vector container. Mounting the Docker socket is a significant security risk: any process inside the container with socket access can create containers with arbitrary volume mounts and escape the host filesystem. The project already isolates Docker socket access through the `docker-socket-proxy` service (which restricts to read-only CONTAINERS=1). However, Vector's `docker_logs` source requires `POST` access to the Docker Engine API (for log streaming calls), which the proxy denies.

**Use file-based log collection instead**: Configure all services to write structured JSON logs to a shared named volume using the Docker `json-file` logging driver (which they already use), and mount that volume into Vector for file tailing. The Docker daemon writes log files under `/var/lib/docker/containers/<id>/<id>-json.log`. We use a volume mount of the host's Docker log directory into Vector for file tailing.

Add to `docker-compose.yml`:
```yaml
vector:
  image: timberio/vector:0.39.0-alpine
  volumes:
    - /var/lib/docker/containers:/var/lib/docker/containers:ro
    - ./vector/vector.yaml:/etc/vector/vector.yaml:ro
    - log-data:/var/log/oneplatform
  networks:
    - oneplatform-internal
  restart: unless-stopped
  user: "0:0"  # Must run as root to read /var/lib/docker/containers
  depends_on:
    - gateway-service
  deploy:
    resources:
      limits:
        memory: 256m
        cpus: "0.25"
```

Create `docker/vector/vector.yaml`:
```yaml
sources:
  docker_file_logs:
    type: file
    include:
      - /var/lib/docker/containers/**/*-json.log
    read_from: end

transforms:
  parse_docker_json:
    type: remap
    inputs: [docker_file_logs]
    source: |
      # Docker json-file format: {"log":"...\n","stream":"stdout","time":"..."}
      parsed, err = parse_json(.message)
      if err == null {
        .message = strip_whitespace(parsed.log ?? "")
        .stream  = parsed.stream ?? "stdout"
        .time    = parsed.time ?? ""
      }
      # Attempt to parse the log line itself as structured JSON
      inner, err2 = parse_json(.message)
      if err2 == null { . = merge(., inner) }
      # Extract container name from the file path for routing
      .container_name = replace(
        replace(get_env_var!("HOSTNAME"), "-", "_"),
        r'^/var/lib/docker/containers/([a-f0-9]+)/.+$', "$1"
      )

sinks:
  file:
    type: file
    inputs: [parse_docker_json]
    path: /var/log/oneplatform/{{ container_name }}.log
    encoding:
      codec: json
    compression: none
```

Add to `volumes:` at the bottom of docker-compose.yml:
```yaml
log-data:
```

**Security implications**: The `/var/lib/docker/containers` mount is read-only. Vector runs as root only to read that host directory — this is unavoidable for file-based log collection. Vector itself does not have network access to the Docker daemon and cannot create containers. Log files may contain sensitive data — the `log-data` volume is only accessible from within the `oneplatform-internal` network.

**Testing**: After starting the stack, verify `docker exec vector ls /var/log/oneplatform/` shows per-service log files within 60 seconds of stack startup.

---

### OA-6: loadConfig() requires ALL env vars for every service

**Complexity**: M

**Root cause**: `packages/core/src/config.ts` defines a single `configSchema` that includes every env var across all services. `loadConfig()` validates `process.env` against this full schema. Services like the logging service (which does not use SMTP) still fail to start if `OP_SMTP_FROM` is set but fails the `z.string().email()` check, even though the logging service never reads that variable.

**Design**: Split the config schema into a required base (all services need these) and per-service optional schemas, loaded on demand.

**Files to modify**:
- `packages/core/src/config.ts`
- `packages/core/src/__tests__/config.test.ts`
- Nine service `index.ts` files (see complete list below)

**What happens to the `Config` type**: The exported `export type Config = z.infer<typeof configSchema>` is removed. It is replaced by per-service type aliases:

```ts
export type BaseConfig = z.infer<typeof baseConfigSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;
export type OntologyConfig = z.infer<typeof ontologyConfigSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type PluginConfig = z.infer<typeof pluginConfigSchema>;
```

No top-level `Config` type is exported after this change. Any code outside the services that imports `Config` from `@oneplatform/core` must be updated — run `grep -rn "from.*@oneplatform/core.*Config\|import.*Config.*from.*core" --include="*.ts"` to find all usages before committing.

**Complete list of callers that must be updated** (verified against source):

| Service | File | Current call | Required change |
|---|---|---|---|
| gateway | `services/gateway/src/index.ts:287` | `loadConfig()` | `loadConfig(gatewayConfigSchema)` |
| auth | `services/auth/src/index.ts:288` | `loadConfig()` | `loadConfig(authConfigSchema)` |
| ingestion | `services/ingestion/src/index.ts:334` | `loadConfig()` | `loadConfig(ingestionConfigSchema)` |
| ontology | `services/ontology/src/index.ts:222` | `loadConfig()` | `loadConfig(ontologyConfigSchema)` |
| pipeline | `services/pipeline/src/index.ts:354` | `loadConfig()` | `loadConfig(pipelineConfigSchema)` |
| execution | `services/execution/src/index.ts:309` | `loadConfig()` | `loadConfig(executionConfigSchema)` |
| app | `services/app/src/index.ts:623` | `loadConfig()` | `loadConfig(appConfigSchema)` |
| logging | `services/logging/src/index.ts:231` | `loadConfig()` | `loadConfig(loggingConfigSchema)` |
| plugin | `services/plugin/src/index.ts:370` | `loadConfig()` | `loadConfig(pluginConfigSchema)` |

Each service must also update its import from:
```ts
import { loadConfig } from "@oneplatform/core";
```
to:
```ts
import { loadConfig, gatewayConfigSchema } from "@oneplatform/core"; // example for gateway
```

**Intermediate state / migration commit strategy**: This change must land as a single atomic commit. The build is broken between the moment `loadConfig()` loses its zero-argument signature and the moment all nine callers are updated. The correct procedure:

1. Add all new per-service schemas and the new `loadConfig<S>` signature to `packages/core/src/config.ts` in a single edit. Keep the old zero-argument overload temporarily as a deprecated shim that calls `loadConfig(configSchema)` — this preserves TypeScript compilation of callers while the migration is in progress within the same PR.
2. Update all nine service `index.ts` files to use the service-specific schema and named import.
3. Remove the deprecated zero-argument shim.
4. Update `config.test.ts` (see below).
5. Commit everything as one commit: `"refactor(core): split loadConfig into per-service schemas"`. Do not split across multiple commits in a way that leaves the monorepo in a broken state.

**Updated `loadConfig` signature**:

```ts
export function loadConfig<S extends z.ZodTypeAny>(
  serviceSchema: S
): z.infer<S> {
  const result = serviceSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data;
}
```

**Per-service schema definitions** (in `packages/core/src/config.ts`):

```ts
// Base schema — every service requires these.
const baseConfigSchema = z.object({
  OP_MASTER_KEY: z.string().min(1),
  OP_JWT_SECRET: z.string().min(32),
  OP_CURSOR_SECRET: z.string().min(32),
  OP_BASE_URL: z.string().url(),
  OP_ALLOWED_ORIGINS: originsSchema.optional().default("http://localhost:3000"),
  OP_DATABASE_URL: z.string().url(),
  OP_REDIS_URL: z.string().url(),
});

const gatewayConfigSchema = baseConfigSchema.extend({
  OP_GLOBAL_RATE_LIMIT: z.coerce.number().int().positive().default(10000),
  OP_GATEWAY_REPLICAS: z.coerce.number().int().positive().optional(),
  OP_WEBHOOK_ALLOW_HTTP: z.string().transform((v) => v === "true").default("false"),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

const authConfigSchema = baseConfigSchema.extend({
  OP_REQUIRE_EMAIL_VERIFICATION: z.string().transform((v) => v === "true").default("false"),
  OP_SMTP_HOST: z.string().optional(),
  OP_SMTP_PORT: z.coerce.number().int().optional(),
  OP_SMTP_USER: z.string().optional(),
  OP_SMTP_PASS: z.string().optional(),
  OP_SMTP_FROM: z.string().email().optional(),
  OP_SMTP_SECURE: z.string().transform((v) => v === "true").default("true"),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

const ingestionConfigSchema = baseConfigSchema.extend({
  OP_INGESTION_BATCH_SIZE: z.coerce.number().int().positive().max(10000).default(1000),
  OP_LARGE_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

const ontologyConfigSchema = baseConfigSchema.extend({
  OP_MIGRATION_TIMEOUT: z.coerce.number().int().positive().default(3600),
  OP_ONTOLOGY_POLL_INTERVAL: z.coerce.number().int().positive().default(15),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

const pipelineConfigSchema = baseConfigSchema.extend({
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

const executionConfigSchema = baseConfigSchema.extend({
  OP_SANDBOX_POOL_SIZE: z.coerce.number().int().positive().default(5),
  OP_CONNECTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

const appConfigSchema = baseConfigSchema.extend({
  OP_WILDCARD_DOMAIN: z.string().optional(),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

const loggingConfigSchema = baseConfigSchema.extend({
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

const pluginConfigSchema = baseConfigSchema.extend({
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

export {
  baseConfigSchema, gatewayConfigSchema, authConfigSchema, ingestionConfigSchema,
  ontologyConfigSchema, pipelineConfigSchema, executionConfigSchema,
  appConfigSchema, loggingConfigSchema, pluginConfigSchema,
};
```

**How existing tests must change** (`packages/core/src/__tests__/config.test.ts`):

The current tests call `loadConfig()` with no arguments and rely on the old zero-argument signature. After the refactor, every test call must pass a schema. The `setMinimalEnv()` helper (which sets only the base env vars) is still valid for testing `baseConfigSchema` and any per-service schema that requires only base vars. Changes required:

- All five calls to `loadConfig()` must become `loadConfig(baseConfigSchema)` (since `setMinimalEnv()` only sets base vars and the tests do not test service-specific fields).
- Add one new test per service schema to verify that the service-specific env vars are validated correctly (the existing tests cover the base vars only).
- Example change:
```ts
// Before:
const config = loadConfig();
// After:
const config = loadConfig(baseConfigSchema);
```

The test import line becomes:
```ts
const { loadConfig, baseConfigSchema } = await import("../config.js");
```

**Security implications**: None. Services continue to validate all env vars they actually use. The change prevents spurious validation failures for irrelevant env vars.

**Testing**: Add a test per service schema verifying that `loadConfig(serviceSchema)` succeeds with only that service's required env vars present and no others — specifically, that a service which does not use `OP_SMTP_*` does not fail when those vars are absent.

---

### OA-8: No backup/restore tooling

**Complexity**: M

**Files to create**:
- `docker/scripts/backup.sh`
- `docker/scripts/restore.sh`

**`backup.sh` design**:
```sh
#!/bin/sh
# Usage: ./backup.sh [output-dir]
# Creates a timestamped backup of: Postgres (pg_dump), MinIO data (mc mirror), Redis (BGSAVE + RDB copy)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${1:-./backups}/${TIMESTAMP}"
mkdir -p "$BACKUP_DIR"

# Postgres: pg_dump via docker exec
docker compose exec -T postgres pg_dump \
  -U postgres \
  -d oneplatform \
  -F custom \
  -f "/tmp/backup.dump" && \
docker compose cp postgres:/tmp/backup.dump "$BACKUP_DIR/postgres.dump"

# MinIO: use mc (MinIO client) to mirror all buckets
docker run --rm \
  --network oneplatform_oneplatform-internal \
  -v "$BACKUP_DIR:/backup" \
  minio/mc:latest \
  mirror "minio/http://minio:9000" /backup/minio

# Redis: trigger BGSAVE, then poll LASTSAVE until the timestamp changes.
# 'sleep 2' is NOT used here — BGSAVE is asynchronous and may take longer
# than 2 seconds on large datasets. Polling LASTSAVE is the correct approach.
BEFORE_SAVE=$(docker compose exec -T redis redis-cli LASTSAVE | tr -d '[:space:]')
docker compose exec -T redis redis-cli BGSAVE
echo "[backup] Waiting for Redis BGSAVE to complete..."
for i in $(seq 1 30); do
  AFTER_SAVE=$(docker compose exec -T redis redis-cli LASTSAVE | tr -d '[:space:]')
  if [ "$AFTER_SAVE" != "$BEFORE_SAVE" ]; then
    echo "[backup] BGSAVE complete (LASTSAVE changed from $BEFORE_SAVE to $AFTER_SAVE)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[backup] WARNING: BGSAVE did not complete within 30 seconds. RDB may be stale." >&2
  fi
  sleep 1
done
docker compose cp redis:/data/dump.rdb "$BACKUP_DIR/redis.rdb"

echo "Backup complete: $BACKUP_DIR"
```

**`restore.sh` design**: Takes a backup directory argument, reverses the process. Includes a required `--yes` flag (no accidental restore). Documents that restore requires stopping the application services first.

**Security implications**: Backup files contain all platform data including encrypted secrets. The scripts must warn the user to protect backup files (`chmod 600`). The scripts do not contain credentials — they rely on the running containers having credentials already configured.

**Testing**: Run `backup.sh` against a running stack, verify all three backup artifacts are produced. Run `restore.sh` against a fresh stack and verify data is present.

---

### OA-11: No TLS between internal services

**Complexity**: L

**Root cause**: Internal service communication uses plain HTTP over the `oneplatform-internal` Docker bridge network. Docker bridge networks are not encrypted at the transport layer.

**Design decision**: For single-node Docker Compose deployments, mutual TLS between containers adds significant operational complexity (certificate rotation, CA management) for marginal security gain — the Docker bridge network is not reachable from outside the host without explicit port binding (OA-2 addresses that). However, the design must still address the finding.

**Two-stage approach**:

*Stage 1 (immediate, low complexity)*: Add a comment block to `docker/docker-compose.yml` at the `oneplatform-internal` network definition explaining the security model. Note: `internal: true` is already present in the current `docker/docker-compose.yml` (lines 629–630) — no need to add it. Only the explanatory comment is new:
```yaml
networks:
  oneplatform-internal:
    driver: bridge
    internal: true  # already present — do not duplicate
    # Security note: traffic on this network is not TLS-encrypted.
    # The 'internal: true' flag prevents external routing but does not encrypt traffic.
    # All services authenticate via Ed25519-signed JWTs (see service-entrypoint.sh).
    # For production deployments requiring transport encryption (e.g. regulatory compliance
    # or multi-node environments), replace this bridge network with an overlay network
    # with IPsec enabled, or deploy behind a service mesh (e.g. Linkerd, Cilium).
```

*Stage 2 (production overlay, documented only)*: Add a section to `docs/DEPLOYMENT.md` describing how to enable inter-service TLS using Caddy as a sidecar (forward proxy) per service, or using Linkerd with mTLS auto-injection. Do not implement the stage-2 infrastructure in docker-compose.yml as part of this batch — the operational complexity is only justified in multi-node deployments and must be designed per target platform.

**Security implications**: Stage 1 documents the current threat model honestly. Stage 2 is a future work item. The existing Ed25519 JWT authentication between services provides integrity and authentication guarantees even without transport encryption — an attacker who can sniff the internal network can see payload data but cannot forge requests.

**Testing**: Verify the comment block is accurate by confirming `oneplatform-internal` is set to `internal: true` (which it already is, preventing external routing).

---

### CC-3: Inconsistent error response shapes across services

**Complexity**: M

**Root cause**: The `packages/core/src/errors.ts` `AppError.toApiError()` returns `{ error: { code, message, details?, requestId } }`. The `errorHandlerMiddleware` in `packages/core/src/middleware/error-handler.ts` applies this shape consistently for all `AppError` subclasses. However, services that throw raw errors (non-`AppError`) fall through to the catch block which wraps them in `InternalError` — but the `message` field is `"An unexpected error occurred."` with no code context for the caller.

**The actual inconsistency**: The ingestion service's validation errors return a flat `{ message }` shape in some paths (where Zod parse errors are caught but not wrapped in `ValidationError`). Check `services/ingestion/src/routes/connectors.ts` for any unguarded `.json()` parsing.

**Files to modify**:
- All service route files where raw `JSON.parse` errors or Zod errors are not wrapped in `ValidationError` before being thrown
- Specifically audit: `services/ingestion/src/routes/connectors.ts`, `services/app/src/routes/`, `services/plugin/src/routes/`

**Audit grep commands** (run from the repo root to find all inconsistent patterns before starting):
```sh
# Find service route files that return raw Zod errors without ValidationError wrapping
grep -rn "c\.json.*error.*parsed\.error\|return.*400.*parsed\.error" services/*/src/routes/ --include="*.ts"

# Find route files that catch JSON parse errors with a raw SyntaxError (not ValidationError)
grep -rn "catch.*SyntaxError\|\.json().*catch\|req\.json.*catch" services/*/src/routes/ --include="*.ts"

# Find all places a response is returned with a flat { error: } or { message: } shape
# (not through the AppError.toApiError() path)
grep -rn "c\.json(.*{.*error:\|c\.json(.*{.*message:" services/*/src/routes/ --include="*.ts"

# Verify errorHandlerMiddleware is registered in every service's index.ts
grep -rn "errorHandlerMiddleware\|errorHandler" services/*/src/index.ts --include="*.ts"
```

**Change pattern**: Replace any pattern of:
```ts
const body = await c.req.json(); // can throw SyntaxError
const parsed = schema.safeParse(body);
if (!parsed.success) return c.json({ error: parsed.error }, 400); // inconsistent shape
```
with:
```ts
let body: unknown;
try {
  body = await c.req.json();
} catch {
  throw new ValidationError("Request body must be valid JSON");
}
const parsed = schema.safeParse(body);
if (!parsed.success) throw new ValidationError("Invalid request", parsed.error.issues);
```

The `ValidationError` class in `errors.ts` already produces the correct shape via `toApiError()`.

**SDK contract**: Document the canonical error shape in `packages/sdk/src/resources/platform-types.ts`:
```ts
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}
```

**Security implications**: Consistent error shapes prevent information leakage via inconsistent error format. `InternalError.toApiError()` already conceals the real message — this change ensures that `ValidationError` shapes are also consistent so clients can reliably parse them.

**Testing**: Add integration tests asserting that every error type (400, 401, 403, 404, 422, 500) returns the canonical `{ error: { code, message, requestId } }` shape.

---

## LOW

### DE-4: No scheduleCron option in CLI connector create

**Complexity**: S

**Root cause**: The service schema at `services/ingestion/src/schemas/index.ts` line 133 accepts `scheduleCron` as an optional cron expression. The CLI `connector create` does not expose it.

**Files to modify**:
- `packages/cli/src/commands/connector/index.ts`

**Change**: Add `scheduleCron?: string` to `CreateOpts`. Add `--schedule-cron <expr>` option to the `connector create` command registration with description `"Cron schedule for automatic syncs (e.g. '0 9 * * 1-5' for weekdays at 9am UTC)"`. Include the value in the POST body when provided. Add a client-side validation that the cron expression has exactly 5 space-separated fields.

---

### DE-6: Missing SDK methods for sync listing/progress

**Complexity**: S

**Files to modify**:
- `packages/sdk/src/resources/connectors.ts`

**Change**: Add to the `ConnectorsNamespace` interface and implementation:
```ts
listSyncs(connectorId: string, options?: ListOptions): PaginatedIterable<SyncJob>;
getSyncProgress(connectorId: string, syncJobId: string): Promise<SyncProgress>;
```

Where `SyncJob` and `SyncProgress` are new types added to `packages/sdk/src/resources/platform-types.ts`:
```ts
export interface SyncJob {
  syncJobId: string;
  connectorId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
  recordsProcessed: number;
  errorMessage: string | null;
}

export interface SyncProgress {
  syncJobId: string;
  status: string;
  progress: number; // 0–100
  recordsProcessed: number;
  estimatedCompletionAt: string | null;
}
```

Paths: `GET /api/v1/connectors/:id/syncs` and `GET /api/v1/connectors/:id/syncs/:syncJobId/progress`.

---

### DE-7: CLI data query uses offset, API uses cursor

**Complexity**: S

**Root cause**: `packages/cli/src/commands/data/index.ts` `queryAction` sends `offset` as a query parameter. The service `GET /api/v1/data/:entityType` uses cursor-based pagination.

**Files to modify**:
- `packages/cli/src/commands/data/index.ts`

**Changes**:
- Remove `offset` from `QueryOpts` and the CLI option.
- Add `cursor?: string` to `QueryOpts`.
- Add `--cursor <token>` option to the `data query` command with description `"Pagination cursor from previous response (replaces --offset)"`.
- Update `queryAction` to send `cursor` instead of `offset`.
- Print the `nextCursor` from the response to stderr so users can paginate: `ctx.renderer.info(`Next cursor: ${result.nextCursor ?? "(end)"})`.

---

### DE-8: No inline schema creation from CLI

**Complexity**: S

**Root cause**: `op ontology create` requires `--file <schema.json>`. There is no way to create a simple entity type inline.

**Files to modify**:
- `packages/cli/src/commands/ontology/index.ts`

**Change**: Add a `--name` option that enables a minimal entity creation without a file:
```ts
ont.command("create")
  .description("Create a new entity type from schema file or inline options")
  .option("--file <schema.json>", "Path to JSON schema file (full schema)")
  .option("--name <name>", "Entity type display name (inline creation)")
  .option("--slug <slug>", "URL slug (derived from name if omitted)")
  .option("--description <desc>", "Entity description")
  .option("--public", "Make entity publicly readable")
  .action(withContext<[CreateOpts]>(createAction));
```

In `createAction`, if `--file` is absent and `--name` is present, construct a minimal schema:
```ts
const schema = opts.name
  ? { name: opts.name, slug: opts.slug, description: opts.description, isPublic: opts.public ?? false, fields: [] }
  : JSON.parse(readFileSync(opts.file!, "utf8"));
```

Require that at least one of `--file` or `--name` is present; throw a `CliError` otherwise.

---

### AD-4: useQuery memoization requirement undocumented

**Complexity**: S

**Root cause**: `packages/app-sdk/src/hooks/useQuery.ts` line 87 has an `eslint-disable` comment noting "if the caller passes a new options literal each render, staleTime prevents redundant network calls. App developers should memoize options objects for optimal performance." This comment exists only in source code — it is not surfaced to developers using the published package.

**Files to modify**:
- `packages/app-sdk/src/hooks/useQuery.ts`: Add a JSDoc comment above the `useQuery` export explaining memoization:

```ts
/**
 * ...existing docs...
 *
 * @performance The `options` object is compared by reference for cache key computation.
 * To prevent unnecessary refetches, memoize the options object:
 * ```ts
 * // WRONG — new object every render causes refetch loop
 * const { data } = useQuery("customer", { filter: { status: { eq: "active" } } });
 *
 * // CORRECT — memoized options object
 * const queryOptions = useMemo(
 *   () => ({ filter: { status: { eq: "active" } } }),
 *   [] // stable reference
 * );
 * const { data } = useQuery("customer", queryOptions);
 * ```
 */
```

---

### PA-2: scaffold package.json references `op` binary not installed

**Complexity**: S

**Root cause**: `buildPackageJson()` in `scaffold.ts` generates:
```json
"pack": "op plugin pack"
```
The `op` CLI binary is not installed as part of the scaffolded project. Developers must install it separately.

**Files to modify**:
- `packages/plugin-sdk/src/dev/scaffold.ts`

**Change**: Update `buildPackageJson()` to use `npx` prefix:
```json
"pack": "npx op plugin pack"
```

Do NOT add a `_note` key to the generated `scripts` object. The `scripts` object in `package.json` is a standard field with defined semantics — adding a `_note` key is non-standard and will generate npm warnings. Instead, add the CLI installation note to the generated `README.md` file. Update `buildReadme()` in `scaffold.ts` to include a section:

```markdown
## Prerequisites

Install the OnePlatform CLI to use the `op` commands referenced in this README:

\`\`\`sh
npm install -g @oneplatform/cli
\`\`\`

The `npm run pack` script uses `npx op plugin pack` and will download the CLI temporarily
if it is not globally installed.
```

---

### PA-6: No plugin versioning/upgrade path

**Complexity**: M

**Root cause**: Plugins are installed as a single version with no mechanism for in-place upgrade or rollback.

**Design**: This is a service-level feature, not a CLI-only change.

**Phase 1 (CLI only, no service changes)**:
- Add `op plugin upgrade <plugin-id> <source>` command that: (1) checks the currently installed version, (2) validates the new version is higher, (3) posts to `/api/v1/plugins/:id/upgrade` with the new bundle.
- Add `op plugin rollback <plugin-id>` command that posts to `/api/v1/plugins/:id/rollback`.

**Phase 2 (service changes)**:
- The plugin service must store version history (keep the last 3 versions).
- Add `GET /api/v1/plugins/:id/versions` to list installed versions.
- The `upgrade` endpoint validates semver ordering and stores the previous bundle before swapping.
- The `rollback` endpoint swaps back to the previous bundle and invalidates all active execution contexts for the plugin.

Phase 1 is the CLI portion; Phase 2 requires plugin service work and a separate design for execution context invalidation. File this as a separate ticket beyond this friction-fix batch.

---

### PA-7: Plugin manifest description min 10 chars surprising

**Complexity**: S

**Root cause**: The plugin manifest schema (in `packages/plugin-sdk/src/manifest/schema.ts`) enforces a minimum 10-character `description`. This is a reasonable content quality check but not documented anywhere — developers who write `description: "A connector"` get a cryptic Zod error.

**Files to modify**:
- `packages/plugin-sdk/src/manifest/schema.ts`: Add a `.describe()` call to the description field:

```ts
description: z.string().min(10).describe(
  "A human-readable description of the plugin (minimum 10 characters). " +
  "Example: 'Syncs customer records from Salesforce to OnePlatform.'"
),
```

- `packages/plugin-sdk/src/dev/scaffold.ts`: Update `buildManifest()` to generate a longer default description:
```ts
description: `A OnePlatform ${opts.type} plugin that ${opts.type === 'connector' ? 'fetches data from an external source' : opts.type === 'transformer' ? 'transforms records during ingestion' : 'processes platform data'}`,
```

This ensures the scaffold always generates a description that passes the 10-character check.

**Testing**: Verify `z.string().min(10)` error message includes the custom `.describe()` text in Zod validation output.

---

### OA-7: No service restart/scale commands

**Complexity**: S

**Root cause**: `packages/cli/src/commands/service/index.ts` only has `rotate-keys` and `health`. Operators cannot restart or scale services through the CLI.

**Files to modify**:
- `packages/cli/src/commands/service/index.ts`

**Change**: Add two new subcommands:

```ts
service.command("restart")
  .description("Restart one or all services (admin scope)")
  .argument("[service-name]", "Service to restart; omit to restart all")
  .option("--graceful", "Wait for in-flight requests to complete (default: true)", true)
  .action(withContext<[string | undefined, { graceful: boolean }]>(restartAction));

service.command("scale")
  .description("Set the replica count for a service (requires orchestrator support)")
  .argument("<service-name>", "Service name (e.g. gateway-service)")
  .argument("<replicas>", "Number of replicas")
  .action(withContext<[string, string, Record<string, never>]>(scaleAction));
```

`restartAction` calls `POST /api/v1/admin/services/:name/restart` (or `/api/v1/admin/services/restart` for all). The gateway service's admin routes must implement these endpoints that call `docker compose restart` or the equivalent orchestrator API.

**Note**: Full implementation of `scale` requires the gateway to have access to the Docker daemon (via `docker-socket-proxy`) or to the Swarm/Kubernetes API. For the initial implementation, `scale` should print instructions for manual scaling and post to a `/api/v1/admin/services/:name/scale` endpoint that is a no-op stub returning a 501 with documentation.

---

### OA-9: PgBouncer/Postgres password file naming tribal knowledge

**Complexity**: S

**Root cause**: The password file naming convention (`db_password_${SERVICE_SHORT}.txt`, `redis_password_${SERVICE_SHORT}.txt`) is only documented in `service-entrypoint.sh` as inline comments.

**Files to modify**:
- `docker/pgbouncer/pgbouncer-entrypoint.sh` — add a comment block at the top explaining the naming convention
- `docker/init/init.sh` — add a comment at the start of the password generation loop that documents the convention
- `.env.example` — add a section comment that references where password files are located

**Change**: Add a comment block to `docker/init/init.sh` immediately before the database password generation loop:

```sh
# ── Database Role Password Naming Convention ────────────────────────────────
# Password files are named: db_password_<service-short-name>.txt
# where <service-short-name> = SERVICE_NAME with the "-service" suffix removed.
# Examples:
#   gateway-service → db_password_gateway.txt
#   auth-service    → db_password_auth.txt
#   ingestion-service → db_password_ingestion.txt
#
# The service-entrypoint.sh reads these files and sets:
#   OP_DATABASE_URL=postgres://<service>_service_role:<password>@pgbouncer:5433/oneplatform_<service>
#
# The pgbouncer-entrypoint.sh reads the same files and writes userlist.txt.
# The postgres set-passwords.sh reads the same files and applies them via ALTER ROLE.
#
# If you add a new service, add it to the loop below and ensure:
# 1. A matching alias exists in docker/pgbouncer/pgbouncer.ini [databases]
# 2. A matching role creation exists in docker/postgres/init.sql
# 3. A matching line exists in docker/postgres/set-passwords.sh
```

---

## Implementation order and agent assignments

```
BATCH A (security, run first, unblocks deployment testing):
  OA-1 (S), OA-2 (S), OA-10 (S), OA-3 (M), OA-11 (L)
  Agent: Security-focused agent, no interdependencies

BATCH B (API contract, run in parallel with A):
  CC-1 (L), DE-1 (covered by CC-1), DE-2 (M), DE-3 (covered by CC-1), CC-3 (M)
  Agent: SDK/service-layer agent
  Note: CC-1 and DE-3 are the same fix; DE-1 is a side effect of CC-1

BATCH C (CLI usability, run in parallel with A and B):
  DE-5 (S), DE-9 (M), DE-4 (S), DE-7 (S), DE-8 (S)
  DE-6 is a subset of this batch (SDK method add)
  Agent: CLI-focused agent

BATCH D (SDK/AppProvider/App, run in parallel with A, B, C):
  AD-1 (M), AD-2 (S), AD-3 (M), AD-5 (S), AD-6 (S), AD-7 (S)
  Agent: Frontend/SDK agent

BATCH E (Plugin DX, depends on BATCH B completing and being merged first):
  PA-1 (S), PA-2 (S), PA-3 (S), PA-4 (S), PA-5 (M), PA-6 (M), PA-7 (S)
  Agent: Plugin developer experience agent
  Hard dependency: BATCH B must be merged before BATCH E starts. The reason is that
  CC-1 in Batch B changes the canonical SDK ontology path from /api/v1/ontologies to
  /api/v1/ontology. Plugin SDK test utilities call the ontology client. If Batch E
  generates test files before the path is fixed, those tests will call the wrong
  endpoint and pass against a broken integration environment. Do not start Batch E
  until the Batch B PR is merged and the installed @oneplatform/sdk version reflects
  the corrected path.

BATCH F (Operations, fully independent):
  OA-4 (S), OA-5 (M), OA-6 (M), OA-7 (S), OA-8 (M), OA-9 (S), CC-2 (M), AD-4 (S)
  Agent: Operations/DevOps agent
```

## Complexity summary

| Finding | Complexity | Batch | Notes |
|---|---|---|---|
| OA-1 | S | A | 3 files |
| OA-2 | S | A | 1 file |
| OA-10 | S | A | 2 files |
| OA-3 | M | A | 1 new file |
| OA-11 | L | A | doc + comment only |
| CC-1 | L | B | 2 files, Paginator shape change |
| DE-1 | S | B | resolved by CC-1 |
| DE-2 | M | B | new service route + SDK method change |
| DE-3 | S | B | resolved by CC-1 |
| CC-3 | M | B | audit + fix across route files |
| DE-5 | S | C | 1 file |
| DE-9 | M | C | 1 file, new resolver function |
| DE-4 | S | C | 1 file |
| DE-6 | S | C | 1 file |
| DE-7 | S | C | 1 file |
| DE-8 | S | C | 1 file |
| AD-1 | M | D | 1 new file + 1 modified |
| AD-2 | S | D | 1 file |
| AD-3 | M | D | 1 new file + 1 CLI file |
| AD-5 | S | D | 1 file |
| AD-6 | S | D | 1 file + 1 doc |
| AD-7 | S | D | 2 files |
| PA-1 | S | E | 1 file |
| PA-2 | S | E | 1 file |
| PA-3 | S | E | 1 file |
| PA-4 | S | E | 1 file |
| PA-5 | M | E | 2 files (CLI + service) |
| PA-6 | M | E | CLI only for Phase 1 |
| PA-7 | S | E | 1 file |
| OA-4 | S | F | 3 files |
| OA-5 | M | F | 2 new files |
| OA-6 | M | F | 1 file, breaking change |
| OA-7 | S | F | 1 file |
| OA-8 | M | F | 2 new files |
| OA-9 | S | F | 2 files |
| CC-2 | M | F | 4 new doc files |
| AD-4 | S | F | 1 file |
