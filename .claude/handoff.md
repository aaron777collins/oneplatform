# OnePlatform Session Handoff — 2026-07-14 (Comprehensive Frontend Fix Session)

## IMPORTANT: Read These Docs After Every Compaction
1. `DEVELOPMENT-PROCESS.md` — Full dev pipeline
2. `docs/WORKING-STATE.md` — Current development state
3. This file (`.claude/handoff.md`) — Session continuity

## Latest Session — Comprehensive API Envelope Unwrapping Fixes (2026-07-14)

### What Was Done

**1. Fixed Dashboard "Active Pipelines" widget (finally!)**
- Root cause: After unwrapping gateway envelope, `pipelinesListInner` was already the array, but code did `.data` on it again (arrays don't have `.data`), falling to `[]`
- Fix: Check `Array.isArray(pipelinesListInner)` before accessing `.data`
- Same fix applied to activities list
- Commit: `291dcb6`

**2. Fixed all remaining API envelope bugs across frontend (8 files)**
- `BuildHistoryTable.tsx` — infinite query getNextPageParam/flatMap didn't unwrap envelope
- `AppRollbackDialog.tsx` — `.data ?? []` accessed PaginatedResponse object, not array
- `LogViewer.tsx` — same infinite query pattern as BuildHistoryTable
- `DLQTable.tsx` — same pattern
- `StorageBrowserPage.tsx` — no double-unwrap guard
- `NodeConfigPanel.tsx` — ConnectorFields, TransformerFields, SubWorkflowFields needed double-unwrap
- Commit: `e96d9ae`

**3. Fixed App Templates route ordering (400 error)**
- Root cause: `GET /templates` was registered AFTER `GET /:id` in app service routes
- "templates" was captured as a UUID param → validation error
- Fix: Moved `/templates` and `/from-template` routes before `/:id`
- App service container rebuilt and deployed

**4. Fixed rate limit env var name**
- `OP_GLOBAL_RATE_LIMIT` (never read by gateway) → `OP_RATE_LIMIT_PER_MIN` (correct var name)
- Rate limit was effectively 1000/min instead of intended 10,000/min
- Gateway restarted with correct env var

### Previous Session Fixes (also 2026-07-14)
- Sync flow: BullMQ UUID, RLS bypass, Redis ACLs, built-in CSV handler
- Pipeline list/detail pages: React Error #130 from `TRIGGER_ICONS[undefined]`
- Ontology pages: `{ items: [...] }` response format crash
- Dashboard resolveCount: double-wrapped pagination handling
- Connector status: "Disabled" shown for never-synced enabled connectors
- Sync history crash: wrong response shape unwrap
- Pipeline builder connector crash: NodeConfigPanel envelope issues
- SSE rate limit exemption in gateway
- Connector `/types` route ordering before `/:id`

### Commits (this session)
- `291dcb6` — fix: dashboard Active Pipelines widget — unwrap array correctly
- `e96d9ae` — fix: API envelope unwrapping across remaining frontend pages + templates route
- `0582edb` — docs: update session handoff
- `82dc85b` — fix: dashboard resolveCount
- `3685544` — fix: ontology pages { items } format
- `0644f94` — fix: pipeline list/detail pages
- `c7d8519` — fix: end-to-end sync flow

### Verification Results (Playwright screenshots confirmed)
All major pages render correctly with real data:
- **Dashboard**: "Student Grades Pipeline" visible in Active Pipelines, Recent Activity shows events, all 9 services healthy
- **Connectors**: All show "Active" status
- **Data Models**: "Student Grades" entity (2 fields)
- **Pipelines**: "Student Grades Pipeline" card renders
- **Apps**: 7+ apps listed, New App dialog shows 9 templates (CRUD Admin, Analytics Dashboard, etc.)
- **App Editor**: File tree, Build/Deploy buttons
- **No 429 errors**: Rate limit properly set to 10,000/min

### Known Remaining Issues
1. **App Editor preview**: Shows "Preview unavailable" — expected until an app is built/deployed
2. **Query Builder bare route**: `/ontology/query-builder` shows "Entity not found" — works when accessed via entity's "Query" button which passes entity param
3. **Quick Start "Set up data structure"**: Not marked complete despite Student Grades entity existing — may need specific detection logic

### Infrastructure State
- **Dev login**: `aaron777collins@gmail.com` / `DevPassword123!`
- **Connector ID (Google Sheets)**: `340800f2-eb37-4316-be8e-a2a9e17db1c6`
- **Pipeline ID**: `2bd06450-2bf2-4b06-838e-7c003b2398b3`
- **Ontology Entity ID**: `516241e3-edc6-4b2b-bd90-b0271a46d861`
- **App ID (Student Grades Dashboard)**: `76147a79-bf3d-42e6-92eb-f897d9620d1e`
- **Tenant ID**: `0ca69b39-8470-497d-8fa2-26461c741eda`
- **All containers**: healthy (op-dev-test-*)
- **Rate limit**: 10,000 req/min (OP_RATE_LIMIT_PER_MIN)

### Key Architecture Notes
- **API response envelopes vary by endpoint** — always use double-unwrap pattern: `(data as { data?: T })?.data ?? data` then check `Array.isArray` before `.data`
- **useInfiniteQuery pages need unwrapping** — each page in `query.data.pages` is gateway-wrapped
- **Route ordering matters** — static routes (`/templates`, `/types`) must be registered before parameterized routes (`/:id`)
- **Gateway reads `OP_RATE_LIMIT_PER_MIN`** not `OP_GLOBAL_RATE_LIMIT`
