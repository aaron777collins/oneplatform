# OnePlatform Session Handoff — 2026-07-14 (E2E Flow Fix + Verification)

## IMPORTANT: Read These Docs After Every Compaction
1. `DEVELOPMENT-PROCESS.md` — Full dev pipeline
2. `docs/WORKING-STATE.md` — Current development state
3. This file (`.claude/handoff.md`) — Session continuity

## Latest Session — Full E2E Flow: CSV Source → Connector → Pipeline → App (2026-07-14)

### What Was Done

**1. Fixed sync flow (BullMQ UUID, RLS bypass, Redis ACLs)**
- BullMQ used numeric `job.id` instead of UUID for sync tracking → added `syncJobId` UUID in job data
- Ingestion service role needed `BYPASSRLS` for RLS-protected tables
- Pipeline Redis user needed `&events:*` channel permission for pub/sub
- SSE `/api/v1/events` exempted from gateway rate limiting

**2. Fixed pipeline list/detail pages (React Error #130)**
- Pipeline list API returns `{ pipeline: {...}, lastRunAt }` wrapper — frontend expected flat records
- `TRIGGER_ICONS[undefined]` caused React Error #130 (undefined component render)
- Fixed `PipelinesPage.tsx`: unwrap `PipelineListItem.pipeline`, derive triggerType
- Fixed `PipelineDetailPage.tsx`: run history snake_case→camelCase mapping, stepCount from definition
- Fixed `DashboardPage.tsx`: Active Pipelines widget unwrap + resolveCount envelope handling

**3. Fixed ontology pages (items wrapper crash)**
- Ontology list API returns `{ data: { items: [...] } }` not `{ data: [...] }`
- `OntologyPage.tsx`, `EntityDetailPage.tsx`, `QueryBuilderPage.tsx` all crashed when entities existed
- Fixed to extract from `.items` array

**4. Created ontology entity + data for CSV records**
- Entity: "Student Grades" (slug: `student_grades`) with fields `col_1`, `col_2`
- Mapping rules created for connector `340800f2-eb37-4316-be8e-a2a9e17db1c6`
- Tenant data table populated with 3 CSV records (a/5, b/7, c/6)
- Data queryable via `POST /api/v1/ontology/query`

**5. Fixed 8+ frontend pages with broken data unwrapping**
- ConnectorsPage, ConnectorDetailPage, AppsPage, OntologyPage, EntityDetailPage
- TeamsPage, ApiKeysPage, WebhooksPage, NodeConfigPanel
- All had `(data as unknown as {...}).data.data ?? data.data` pattern issues

### Commits
- `c7d8519` — fix: end-to-end sync flow (UUID job IDs, RLS bypass, data unwrap, Redis ACLs)
- `0644f94` — fix: pipeline list/detail pages (unwrap API response wrapper, map snake_case)
- `3685544` — fix: ontology pages (handle { items: [...] } response format)
- `82dc85b` — fix: dashboard resolveCount (correctly handle paginated response envelope)

### Verification Results (Playwright screenshots)
All major pages render correctly:
- **Dashboard**: Quick Start wizard shows 2/4 steps, all 9 services healthy (green)
- **Connectors**: 8 connectors, all "Active" status
- **Data Models**: "Student Grades" entity (2 fields, View/Query actions)
- **Pipelines**: "Student Grades Pipeline" card, "Run manually" trigger
- **Pipeline Detail**: Overview tab with Last Run, Trigger, Steps cards
- **Apps**: 7 apps listed
- **App Editor**: File tree (src/App.tsx, index.tsx, package.json, tsconfig.json), Build/Deploy buttons
- **Settings pages**: API Keys, Webhooks, Teams all load correctly

### Known Remaining Issues
1. **SSE 429 rate limiting**: Console shows 429 errors on `/api/v1/events` — the gateway rate limiter path exemption works but the frontend opens multiple SSE connections per page
2. **Dashboard "Active Pipelines"**: Shows correct pipeline count but "No pipelines yet" text — the pipeline list widget query may need cache invalidation or the pipeline wrapper unwrap in the widget rendering
3. **App preview**: App editor shows "Preview unavailable" — expected since no app has been built/deployed yet
4. **Query Builder route**: Accessible at `/ontology/query` not `/ontology/query-builder`

### Infrastructure State
- **Admin Redis password**: `sKjWz3UrRG8U3FKVdWjGRZB5utYbtTID`
- **Dev login**: `aaron777collins@gmail.com` / `DevPassword123!`
- **Connector ID (Google Sheets)**: `340800f2-eb37-4316-be8e-a2a9e17db1c6`
- **Pipeline ID**: `2bd06450-2bf2-4b06-838e-7c003b2398b3`
- **Ontology Entity ID**: `516241e3-edc6-4b2b-bd90-b0271a46d861`
- **App ID (Student Grades Dashboard)**: `76147a79-bf3d-42e6-92eb-f897d9620d1e`
- **Tenant ID**: `0ca69b39-8470-497d-8fa2-26461c741eda`
- **All containers**: healthy (op-dev-test-* with project name "op-dev-test")

### Key Architecture Notes
- **API response envelopes vary**: Some endpoints return `{ data: [...] }`, others `{ data: { items: [...] } }`, others `{ data: { pipeline: {...}, lastRunAt } }`
- **Pipeline DB columns are snake_case**: `triggered_by`, `started_at`, `completed_at` — frontend needs mapping
- **Ontology data storage**: Per-tenant schema `tenant_<id_no_hyphens>.<entity_slug>` with system columns `_id`, `_created_at`, etc.
- **BullMQ job IDs are numeric**: Always pass UUIDs via `job.data.syncJobId`, never rely on `job.id`
