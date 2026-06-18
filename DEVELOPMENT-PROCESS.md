# OnePlatform Development Process

This document defines the rigorous development pipeline used for ALL work on OnePlatform. Every feature, service, and component goes through this process. No exceptions. This is the single source of truth for how development is conducted.

---

## 1. Core Principles (Non-Negotiable)

These principles govern every decision at every level. They are not suggestions — they are requirements.

### 1.1 SOLID Principles

| Principle | Enforcement |
|-----------|-------------|
| **Single Responsibility** | Each class/module/service does exactly one thing. If a module description contains "and", split it. |
| **Open/Closed** | New features extend via plugins, hooks, or interfaces — never by modifying existing code. |
| **Liskov Substitution** | Any implementation of an interface can be swapped without behavioral changes. |
| **Interface Segregation** | Consumers depend only on the methods they use. Split fat interfaces into focused ones. |
| **Dependency Inversion** | High-level modules depend on abstractions. Services receive dependencies via constructor injection. |

### 1.2 Architecture Principles

| Principle | How It's Applied |
|-----------|------------------|
| **Extensibility** | Everything is extensible via plugins and interfaces. Built-in features use the same extension points as third-party ones. |
| **Plugin Architecture** | Plugin Service and plugin-sdk are first-class. Connectors, transformers, destinations, auth providers, and widgets are all plugins. |
| **Core Library** | `@oneplatform/core` is the shared backbone. All services import it. Zero boilerplate for new services. |
| **Microservices** | 9 services with clean boundaries. Inter-service auth via Ed25519 service tokens. 3-tier network topology. |
| **Maintainability** | Modular code, comprehensive tests, auto-generated docs. Code is readable and well-structured. |
| **Security First** | Auth is first-class. Ontology-driven RBAC. Sandboxed execution. Encrypted credentials. |
| **API First** | Every operation is available via REST API, CLI, and SDKs. The UI is one client of many. |
| **No Compromise** | Never shortcut for "MVP". Always choose the best option. Finish everything perfectly. |

---

## 2. Reference Hierarchy

When working on any part of the system, always reference UP the chain:

```
Level 0: Architecture Decisions (docs/decisions/001-architecture-decisions.md)
  ↓ must conform to
Level 1: Design Spec (docs/superpowers/specs/*-design.md)
  ↓ must conform to
Level 2: Service-Level Design (docs/designs/{service-name}.md)
  ↓ must conform to
Level 3: Implementation (services/{service-name}/src/)
  ↓ verified by
Level 4: Tests (services/{service-name}/src/__tests__/)
```

At every level, check that your work conforms to ALL levels above it. If a lower-level decision contradicts a higher-level one, the higher level wins. If you believe a higher-level decision is wrong, propose a change through the architecture review process — never silently diverge.

---

## 3. Agent Team & Sub-Agent Architecture

ALL development work uses specialized agents and sub-agents. This is not optional. The correct agent must be used for each phase of work. Sub-agents are used for parallelizable tasks within each phase.

### 3.1 Agent Types and When to Use Them

| Agent Type | Role | When to Invoke | Key Tools |
|------------|------|----------------|-----------|
| **Architect** | Creates designs for services, features, and system changes | Any new feature, any cross-service change, any API change | Read, Write, WebSearch |
| **Architecture Reviewer** | Reviews designs for correctness, security, completeness, SOLID compliance | After every architect produces a design — ALWAYS | Read, all tools |
| **Developer** | Implements code following approved designs | After design is APPROVED and theoretical tests pass | All tools |
| **Tester** | Writes comprehensive test suites — unit, integration, contract, e2e, security | After developer produces implementation code | All tools |
| **Code Reviewer** | Reviews code for security, correctness, performance, quality | After tests are written and passing | Read, all tools |
| **Explore** | Fast read-only search for locating code patterns, files, symbols | When searching codebase for existing patterns, usage sites, or understanding context | Read, grep |

### 3.2 Sub-Agent Strategy

Sub-agents are used to parallelize independent work within a phase. The orchestrating agent (you) dispatches sub-agents and synthesizes their results.

#### When to Use Sub-Agents

- **Parallel analysis**: When multiple independent aspects need to be analyzed (e.g., analyzing 5 services for the same pattern)
- **Parallel implementation**: When multiple independent files need changes that don't interact
- **Parallel testing**: When multiple test suites can be written independently
- **Multi-perspective review**: When a design needs review from security, performance, and API-consistency angles simultaneously

#### When NOT to Use Sub-Agents

- When tasks have dependencies (one must complete before the next starts)
- When a task is simple enough to do directly
- When context from previous steps is needed to inform the next step

### 3.3 Detailed Prompt Requirements

Every agent/sub-agent prompt MUST include:

1. **Context**: What the project is, what has been done, what's being done now
2. **Specific task**: Exactly what to do, with file paths and line numbers when applicable
3. **Constraints**: SOLID principles, security requirements, API consistency rules
4. **Reference documents**: Which design docs, ADRs, or specs to reference
5. **Output format**: Exactly what format the response should be in
6. **Quality criteria**: What "done" looks like, what would cause rejection

#### Example Architect Prompt

```
You are designing a feature for OnePlatform, an open-source data platform.

CONTEXT:
- The Auth Service (services/auth/) handles all identity and access control
- Current design: docs/designs/auth-service.md (2483 lines)
- Architecture decisions: docs/decisions/001-architecture-decisions.md (ADR-7, ADR-11, ADR-19)
- The system uses JWT access tokens (15min) + opaque refresh tokens (7 days)

TASK:
Design the SSO/SAML integration for the Auth Service. This must:
1. Support SAML 2.0 SP-initiated and IdP-initiated flows
2. Support OIDC authorization code flow with PKCE
3. Allow multiple IdP configurations per tenant
4. Map IdP attributes to platform roles
5. Coexist with existing email/password and OAuth flows

CONSTRAINTS:
- Must conform to ADR-7 (auth model) and ADR-19 (inter-service auth)
- Must follow SOLID — SSO should be a plugin, not hardcoded logic
- Must not break existing auth flows
- Must support tenant isolation (each tenant configures its own IdP)
- Must handle IdP-down scenarios gracefully

OUTPUT FORMAT:
Produce an L2 design document section following the format in docs/designs/auth-service.md:
- Database schema changes
- Redis key additions
- API endpoint specifications with Zod schemas
- Flow diagrams (ASCII)
- Security invariants
- Error codes
- Test strategy

QUALITY CRITERIA:
- All edge cases covered (IdP down, token expired, attribute mapping failure, etc.)
- No new security vulnerabilities introduced
- Compatible with existing token-service.ts and auth-service.ts
- Extensible for future IdP types (Azure AD, Okta, etc.)
```

#### Example Code Reviewer Prompt

```
You are reviewing code for OnePlatform, an open-source data platform.

CONTEXT:
- This PR implements SSO/SAML integration for the Auth Service
- Approved design: docs/designs/auth-service.md Section 14 (SSO)
- The implementation touches: services/auth/src/services/sso-service.ts,
  services/auth/src/routes/sso.ts, services/auth/src/repositories/idp-config-repository.ts

FILES TO REVIEW:
[list all changed files with line ranges]

REVIEW CRITERIA:
1. SECURITY: No injection, no SSRF, no token leakage, proper validation
2. SOLID: Single responsibility, dependency injection, interface segregation
3. CONFORMANCE: Implementation matches the approved L2 design exactly
4. ERROR HANDLING: All error paths return proper error codes from the design
5. PERFORMANCE: No N+1 queries, no unbounded iterations, proper indexing
6. TESTING: Are the tests comprehensive? Do they cover edge cases?

OUTPUT FORMAT:
Issue a verdict:
- RED: Blocking issues that MUST be fixed before merge
- YELLOW: Issues that SHOULD be fixed before merge
- GREEN: Approved, no issues

For each finding:
| # | Severity | File:Line | Issue | Fix |
```

---

## 4. Development Flow

Every piece of work follows this exact pipeline. No shortcuts. No skipping steps.

```
┌──────────────────────────────────────────────────────────────────┐
│                     DEVELOPMENT PIPELINE                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────┐                │
│  │  PHASE 1: ANALYSIS                          │                │
│  │  ├── User Story Analysis (per persona)      │                │
│  │  ├── Friction Point Identification           │                │
│  │  └── Gap Analysis (vs competitors)           │                │
│  └──────────────────┬──────────────────────────┘                │
│                     ↓                                            │
│  ┌─────────────────────────────────────────────┐                │
│  │  PHASE 2: ARCHITECTURE                       │                │
│  │  ├── Architect agent creates design          │                │
│  │  ├── Architecture Reviewer validates          │                │
│  │  │   ├── APPROVED → proceed                  │                │
│  │  │   └── REVISE → back to Architect           │                │
│  │  └── Theoretical Test (edge cases, failures)  │                │
│  └──────────────────┬──────────────────────────┘                │
│                     ↓                                            │
│  ┌─────────────────────────────────────────────┐                │
│  │  PHASE 3: DESIGN                             │                │
│  │  ├── Produce L2 design (database, API, flows)│                │
│  │  ├── Design Review                           │                │
│  │  │   ├── SOLID compliance check              │                │
│  │  │   ├── Security review                     │                │
│  │  │   ├── API consistency check               │                │
│  │  │   └── APPROVED / REVISE                   │                │
│  │  └── Theoretical test of design              │                │
│  └──────────────────┬──────────────────────────┘                │
│                     ↓                                            │
│  ┌─────────────────────────────────────────────┐                │
│  │  PHASE 4: IMPLEMENTATION                     │                │
│  │  ├── Developer agent implements code         │                │
│  │  ├── Tester agent writes test suites         │                │
│  │  ├── Run all tests (unit+integration+e2e)    │                │
│  │  └── If tests fail → fix and re-run          │                │
│  └──────────────────┬──────────────────────────┘                │
│                     ↓                                            │
│  ┌─────────────────────────────────────────────┐                │
│  │  PHASE 5: CODE REVIEW                        │                │
│  │  ├── Code Reviewer checks all criteria       │                │
│  │  │   ├── RED → back to Developer (fix)       │                │
│  │  │   ├── YELLOW → fix then re-review         │                │
│  │  │   └── GREEN → approved                    │                │
│  │  └── Final test run to confirm               │                │
│  └──────────────────┬──────────────────────────┘                │
│                     ↓                                            │
│  ┌─────────────────────────────────────────────┐                │
│  │  PHASE 6: COMMIT & DOCUMENT                  │                │
│  │  ├── Commit with descriptive message         │                │
│  │  ├── Update WORKING-STATE.md                 │                │
│  │  ├── Update handoff.md                       │                │
│  │  └── Push to remote                          │                │
│  └──────────────────────────────────────────────┘                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.1 Phase 1: Analysis

Before writing any code, analyze the user impact:

1. **Identify all affected personas** — Who uses this feature? Who is affected by this change?
2. **Walk through user stories** — Step by step, what does each persona do? Where do they get stuck?
3. **Identify friction points** — What error messages? What confusion? What missing documentation?
4. **Gap analysis** — What would a user of Fivetran/n8n/Retool expect that we don't have?
5. **Prioritize** — CRITICAL (blocks core functionality), HIGH (significant pain), MEDIUM (annoying), LOW (nice-to-have)

Use sub-agents to parallelize persona analysis:
```
Launch 5 parallel sub-agents:
  - Agent 1: Analyze from data-engineer perspective
  - Agent 2: Analyze from app-developer perspective
  - Agent 3: Analyze from ops-admin perspective
  - Agent 4: Analyze from security-reviewer perspective
  - Agent 5: Analyze from new-user perspective
Synthesize results and deduplicate findings.
```

### 4.2 Phase 2: Architecture

For every change that affects system contracts, data models, or cross-service interaction:

1. **Architect agent** produces a design document:
   - References all applicable ADRs
   - Includes database schema changes (SQL)
   - Includes API endpoint specifications (with Zod schemas)
   - Includes flow diagrams (ASCII)
   - Lists security invariants
   - Identifies error codes and error paths
   - Describes observability (metrics, traces, logs)

2. **Architecture Reviewer agent** validates:
   - Does the design conform to ALL applicable ADRs?
   - Are SOLID principles applied correctly?
   - Are all edge cases and failure modes covered?
   - Is the design secure? (no SSRF, no injection, no token leaks)
   - Is the design extensible? (can plugins/hooks extend it?)
   - Verdict: **APPROVED** or **REVISE** (with specific issues)

3. **Theoretical Test** (before any code is written):
   - Walk through every API endpoint mentally: what happens with invalid input? What if the DB is down? What if Redis is down?
   - For each error path: does the design specify the exact error code and HTTP status?
   - For each security boundary: what happens if an attacker sends a crafted request?
   - For each concurrent access scenario: what happens with race conditions?

### 4.3 Phase 3: Design

Produce the detailed L2 design following the format established in `docs/designs/`:

1. **Database schema** — Full SQL with constraints, indexes, RLS policies
2. **Redis key inventory** — Key patterns, types, TTLs, failure behavior
3. **API endpoints** — Request/response schemas (Zod), auth requirements, rate limits
4. **Authentication flows** — Sequence diagrams for every auth-related change
5. **Error codes** — Every error code, HTTP status, and when it occurs
6. **Observability** — Metrics, traces, logs, and alerts
7. **Testing strategy** — What tests are needed at each level

Design review checks:
- SOLID compliance at every interface boundary
- Extensibility via plugins/hooks
- Backward compatibility with existing APIs
- Security implications documented
- Performance implications documented

### 4.4 Phase 4: Implementation

1. **Developer agent** implements following the approved design:
   - Reference the L2 design document for EVERY decision
   - Use dependency injection for all external dependencies
   - Follow existing code patterns in the codebase
   - No TODO/FIXME/HACK comments — fix it now or create a ticket

2. **Tester agent** writes comprehensive tests:
   - Unit tests for every function/method
   - Edge cases, error paths, boundary conditions
   - Integration tests for HTTP endpoints
   - Contract tests against the API spec
   - Security tests (auth bypass, injection, etc.)

3. **Run all tests** — Every test must pass. No exceptions. No skipping.

### 4.5 Phase 5: Code Review

The Code Reviewer agent checks:

| Criterion | What to Look For |
|-----------|------------------|
| **Security** | Injection, SSRF, token leakage, missing auth checks, insecure defaults |
| **SOLID** | SRP violations, tight coupling, missing interfaces, fat classes |
| **Conformance** | Does implementation match the approved L2 design? |
| **Error Handling** | All error paths return correct codes, no swallowed errors |
| **Performance** | N+1 queries, unbounded iterations, missing indexes, excessive allocations |
| **Tests** | Coverage of edge cases, security paths, error conditions |
| **API Consistency** | Follows envelope format, cursor pagination, naming conventions |

Verdicts:
- **RED** — Blocking issues that MUST be fixed. Stop. Fix. Re-review.
- **YELLOW** — Issues that SHOULD be fixed. Fix then re-review.
- **GREEN** — Approved. Proceed to commit.

### 4.6 Phase 6: Commit, CI & Document

1. **Commit** with a descriptive message explaining WHY, not just WHAT
2. **Push** to remote — CI pipeline runs automatically
3. **Verify CI passes** — All checks must be green (lint, typecheck, test, build)
4. **If CI fails** — Fix locally, commit, push again. Never merge red CI.
5. **Update `docs/WORKING-STATE.md`** — Mark completed items, add new items
6. **Update `.claude/handoff.md`** — Session continuity for the next developer
7. **Verify observability** — After deploy, confirm metrics/traces appear in Jaeger/Grafana

---

## 5. User Story Analysis Methodology

### 5.1 Persona Catalog

Every analysis must cover these personas:

| Persona | Key Concerns | Example User Stories |
|---------|-------------|---------------------|
| **First-time self-hoster** | Installation, first run, onboarding | "I clone the repo and run docker compose up" |
| **Data engineer** | Connectors, sync schedules, data quality, monitoring | "I connect 5 Postgres databases and schedule hourly syncs" |
| **App developer** | SDK ergonomics, type safety, deployment, debugging | "I build an internal dashboard app using the SDK" |
| **Plugin developer** | Scaffold, testing, packaging, publishing, versioning | "I build a custom Stripe connector plugin" |
| **Platform admin** | Users, roles, tenants, health, scaling, incidents | "I need to add 50 users across 3 tenants" |
| **DevOps/SRE** | Deployment, TLS, monitoring, secrets, upgrades | "I deploy to production with HA and TLS" |
| **Security auditor** | Auth flows, RBAC, encryption, compliance | "I audit the platform for SOC2 compliance" |
| **Enterprise evaluator** | SSO, audit logs, SLAs, compliance, support | "I'm comparing this to Fivetran for my company" |
| **Power user** | API, CLI, bulk operations, complex pipelines | "I run 100 pipelines with custom code transformations" |
| **Non-technical user** | App usability, permissions, data access | "I just need to view the dashboard my team built" |

### 5.2 Analysis Template

For each persona, walk through every user story step by step:

```
PERSONA: [name]
STORY: [what they're trying to do]

Step 1: [action]
  - Expected: [what should happen]
  - Actual: [what actually happens — CHECK THE CODE]
  - Finding: [friction point, if any]
  - Severity: [CRITICAL/HIGH/MEDIUM/LOW]
  - File: [path:line]
  - Fix: [what needs to change]

Step 2: [next action]
  ...
```

### 5.3 Friction Point Severity Scale

| Severity | Definition | Example |
|----------|-----------|---------|
| **CRITICAL** | Blocks core functionality. Feature is broken or unusable. | Auth endpoint returns wrong status code; service crashes on startup |
| **HIGH** | Significant pain. Workaround exists but is non-obvious. | Error message is cryptic; documentation is missing |
| **MEDIUM** | Annoying but workable. User can figure it out. | UI element misaligned; CLI output format is inconsistent |
| **LOW** | Nice-to-have improvement. | Slightly better error message; convenience alias |

---

## 6. Gap Analysis Methodology

### 6.1 Competitive Comparison Framework

For each competitor feature:

```
FEATURE: [name]
COMPETITOR: [Fivetran/n8n/Retool]
COMPETITOR STATE: [how they do it]
OUR STATE: [what we have — CHECK THE CODE]
GAP: [what's missing]
IMPACT: [who is affected and how badly]
EFFORT: [S/M/L/XL to close the gap]
PRIORITY: [P1/P2/P3/P4]
```

### 6.2 Priority Levels

| Priority | Meaning | Timeline |
|----------|---------|----------|
| **P1** | Must-have for credible MVP launch | Before first public release |
| **P2** | Required for first enterprise customer | Within 3 months of launch |
| **P3** | Competitive differentiation | Within 6 months of launch |
| **P4** | Nice-to-have / future | Backlog |

---

## 7. Test Strategy

Every service must have comprehensive tests at every level:

### 7.1 Unit Tests
- Every function/method tested in isolation
- Edge cases, error paths, boundary conditions
- Mock external dependencies (DB, Redis, other services)
- Minimum 80% line coverage, 90% for security-critical code

### 7.2 Integration Tests
- **Level 1**: Service-level — test the service's HTTP API with real DB/Redis
- **Level 2**: Cross-service — test service-to-service communication
- **Level 3**: Full-stack E2E — complete user stories through all services

### 7.3 Contract Tests
- Every service defines its API contract (OpenAPI spec)
- Contract tests verify the service conforms to its spec
- Consumer-driven: downstream services define what they expect
- Provider verification: upstream services prove they deliver it

### 7.4 Security Tests
- Auth bypass attempts
- Sandbox escape attempts
- SQL injection, XSS, CSRF
- Rate limit verification
- Permission boundary tests (entity, field, row level)
- Header injection tests
- Token manipulation tests

### 7.5 Test Naming Convention

```typescript
describe('AuthService', () => {
  describe('login', () => {
    it('should return access and refresh tokens for valid credentials', ...);
    it('should return UNAUTHORIZED for invalid password', ...);
    it('should increment failed_login_count on invalid password', ...);
    it('should lock account after 10 consecutive failed logins', ...);
    it('should prevent timing oracle by running bcrypt even for unknown emails', ...);
  });
});
```

---

## 8. Commit Guidelines

- Commit after each meaningful unit of work
- Commit message format: imperative mood, descriptive, with rationale
- Always push to remote after commits
- Never leave uncommitted work at the end of a session
- Format:
  ```
  Add SSO/SAML integration to Auth Service

  Implements SAML 2.0 SP-initiated flow with IdP attribute mapping.
  Follows L2 design (docs/designs/auth-service.md §14). Key decisions:
  - SSO is a plugin interface, not hardcoded
  - IdP configs are tenant-scoped
  - Graceful degradation when IdP is unavailable
  ```

---

## 9. Quality Gates

Before any PR is merged, ALL of the following must be true:

1. All tests pass (unit + integration + contract + security)
2. Code review is GREEN (no RED or YELLOW items)
3. Architecture review is APPROVED
4. Design conforms to L0 architecture decisions
5. Documentation is auto-generated and up-to-date
6. No TODO/FIXME/HACK comments (fix them or create tickets)
7. SOLID principles verified at every interface boundary
8. Security implications documented and reviewed
9. API consistency verified (envelope format, error codes, pagination)
10. Performance implications assessed (no N+1, proper indexing)

---

## 10. Documentation Standards

### 10.1 What Must Be Documented

| Document | Location | Contents |
|----------|----------|----------|
| Architecture decisions | `docs/decisions/` | All ADRs with rationale |
| L2 service designs | `docs/designs/` | Database, API, flows, errors for each service |
| User story analysis | `docs/USER-STORIES-ANALYSIS-V*.md` | Friction points by persona |
| Gap analysis | `docs/GAP-ANALYSIS.md` | Competitive gaps and roadmap |
| Working state | `docs/WORKING-STATE.md` | Current phase, completed items, pending items |
| Session handoff | `.claude/handoff.md` | What was done, what's next, key decisions |
| API reference | Auto-generated from OpenAPI | All endpoints, schemas, error codes |
| SDK reference | Auto-generated from TypeDoc | All public APIs, types, examples |
| CLI reference | Auto-generated from CLI metadata | All commands, options, examples |
| Quickstart guides | `docs/quickstart/` | Per-persona getting-started guides |

### 10.2 Document Updates

After every change:
- Update `docs/WORKING-STATE.md` with new status
- Update `.claude/handoff.md` with session details
- If design changed: update `docs/designs/` L2 document
- If ADR changed: update `docs/decisions/` ADR document
- If API changed: regenerate OpenAPI spec

---

## 11. Implementation Patterns

### 11.1 Service-to-Service Authentication (Ed25519 JWT)

Every internal call (`/internal/*` routes) MUST include a signed Ed25519 JWT in the `X-Service-Token` header. The core library provides a signer utility:

```typescript
import { createServiceTokenSigner, loadServicePrivateKey } from "@oneplatform/core";

const privateKeyPem = await loadServicePrivateKey("my-service", serviceKeysDir);
const signer = await createServiceTokenSigner("my-service", privateKeyPem);

// In service code:
const token = await signer.sign();
const resp = await fetch(url, {
  headers: { "X-Service-Token": token, "Content-Type": "application/json" },
  ...
});
```

**Rules:**
- Never pass `OP_SERVICE_TOKEN_SECRET` or any plain string as a service token
- The signer caches tokens and reissues when < 60s remaining (5-min JWT lifetime)
- Private keys are at `/data/service-keys/{service-name}.key.pem`
- Public keys at `/data/service-keys/{service-name}.pub` (loaded by receiving services)
- Thread the `ServiceTokenSigner` via dependency injection — never import signer as a module-level global

### 11.2 Per-User Token Revocation

When deactivating a user, blocklist all their access tokens using a per-user Redis key:

```typescript
await redis.set(`revocation:user:${userId}`, "1", "EX", jwtExpirySeconds);
```

The auth middleware checks both per-token JTI and per-user revocation. Access token JTIs are embedded in the JWT and NOT stored server-side, so per-JTI blocklisting is impossible for user deactivation.

### 11.3 Cron Expression Validation

Always use `cronExpressionSchema` from `@oneplatform/core` for cron input validation. Never implement local cron validation. The schema validates 5-field standard cron with range/step/list syntax.

### 11.4 NODE_ENV Safety

For code that should only return sensitive data in development:
```typescript
// WRONG: falls through when NODE_ENV is unset
if (process.env["NODE_ENV"] === "production") { throw ... }

// CORRECT: defaults to safe behavior
if (process.env["NODE_ENV"] !== "development" && process.env["NODE_ENV"] !== "test") { throw ... }
```

### 11.5 Redis Key TTLs

Every Redis key set for revocation, caching, or rate limiting MUST have a TTL. Keys without TTLs leak memory over time. Use `redis.set(key, value, "EX", ttlSeconds)`.

## 12. Key File Locations

| Purpose | Path |
|---------|------|
| Architecture decisions | `docs/decisions/001-architecture-decisions.md` |
| Expanded decisions | `docs/decisions/002-expanded-architecture-decisions.md` |
| Service designs | `docs/designs/{service-name}.md` |
| Working state | `docs/WORKING-STATE.md` |
| User analysis v2 | `docs/USER-STORIES-ANALYSIS-V2.md` |
| User analysis v3 | `docs/USER-STORIES-ANALYSIS-V3.md` |
| Gap analysis | `docs/GAP-ANALYSIS.md` |
| Session handoff | `.claude/handoff.md` |
| Service token signer | `packages/core/src/service-token.ts` |
| Cron validation | `packages/core/src/cron.ts` |
| Core library | `packages/core/src/` |
| SDKs | `packages/sdk/`, `packages/app-sdk/`, `packages/plugin-sdk/` |
| CLI | `packages/cli/` |
| Frontend | `packages/frontend/` |
| Services | `services/{gateway,auth,ingestion,ontology,pipeline,execution,app,logging,plugin}/` |
| Docker config | `docker/` |
| Quickstarts | `docs/quickstart/` |
| Test infrastructure | `tests/` |
| Build tools | `tools/` |
| CI/CD pipeline | `.github/workflows/ci.yml` |
| Built-in connectors | `plugins/connector-*` |

---

## 13. CI/CD Pipeline

All pushes to `main` and all pull requests trigger the CI pipeline (`.github/workflows/ci.yml`).

### 13.1 Pipeline Stages

```
lint → typecheck → test → build → docker (main only)
```

| Stage | What It Does | Failure Action |
|-------|-------------|----------------|
| **Lint & Format** | ESLint + Prettier check | Fix lint issues locally |
| **Type Check** | `turbo build` (TypeScript compilation) | Fix type errors |
| **Test** | `turbo test` (all unit tests) | Fix failing tests |
| **Build** | Full production build | Fix build errors |
| **Docker** | Build all 9 service images + frontend | Fix Dockerfile or build |

### 13.2 Rules

- Never merge with failing CI — no exceptions
- CI runs concurrently across stages where possible
- Docker builds only run on pushes to `main` (not on PRs)
- Use `pnpm install --frozen-lockfile` — lockfile must be committed

---

## 14. Rollback & Incident Response

### 14.1 Rollback Process

If a deployed change causes issues:

1. **Assess severity** — Is the platform down (P1)? Degraded (P2)? Annoying (P3)?
2. **P1 (platform down)** — Revert immediately: `git revert HEAD && git push`
3. **P2 (degraded)** — Fix forward if < 30 minutes, otherwise revert
4. **P3 (annoying)** — Fix forward in next session

### 14.2 Docker Rollback

```bash
# Roll back to previous image
docker compose pull  # if using registry
docker compose up -d --force-recreate <service-name>
```

### 14.3 Database Rollback

Schema migrations must be reversible. Every migration file should include a `down` function that undoes the `up` changes. Test rollback in staging before production.

---

## 15. Dependency Management

### 15.1 Update Schedule

- **Security patches** — Apply immediately when `pnpm audit` reports vulnerabilities
- **Minor updates** — Review and apply monthly
- **Major updates** — Evaluate impact, test thoroughly, apply quarterly

### 15.2 Process

1. Run `pnpm audit` to check for known vulnerabilities
2. Run `pnpm outdated` to see available updates
3. Update one dependency at a time — never batch unrelated updates
4. Run full test suite after each update
5. Document breaking changes in commit message

---

## 16. Performance Testing

### 16.1 When Required

- Any change to hot paths (request handling, database queries, sync jobs)
- Any change to data structures used at scale (arrays → maps, etc.)
- Any new external service call in a request path
- Before major releases

### 16.2 What to Measure

| Metric | Target | How |
|--------|--------|-----|
| API response time (p95) | < 200ms | Load test with realistic payloads |
| Ingestion throughput | > 1000 records/second | Batch sync with varying sizes |
| Concurrent users | > 100 simultaneous | Parallel request simulation |
| Memory under load | < 512MB per service | Monitor during load test |

---

## 17. Database Migration Strategy

### 17.1 Migration Rules

- Every schema change is a versioned migration file
- Migrations run automatically on service startup (via init.sh)
- Migrations must be idempotent — running twice produces the same result
- Never modify a migration that has been applied to any environment
- Destructive changes (DROP, ALTER TYPE) require a two-phase approach:
  1. Phase 1: Add new column/table, dual-write
  2. Phase 2: Migrate data, remove old column/table

### 17.2 Testing Migrations

- Test migration up AND down in CI
- Test with representative data volumes (not just empty tables)
- Verify indexes are created and used by the query planner

---

## 18. Hotfix Process

For urgent production fixes that cannot wait for the full pipeline:

1. **Create a hotfix branch** from the latest production tag
2. **Apply the minimal fix** — smallest possible change
3. **Run tests** — full test suite must pass
4. **Code review** — at minimum one reviewer, security-focused
5. **Deploy** — push to main, verify CI, deploy
6. **Post-mortem** — document what happened and how to prevent recurrence

Hotfixes skip Phase 1 (Analysis) and Phase 2/3 (Architecture/Design) ONLY if the fix is a pure bug fix with no design implications. If the fix changes an interface or data model, the full pipeline applies.

---

## 19. Accessibility Testing

### 19.1 Requirements

All frontend components must meet WCAG 2.1 Level AA. Key requirements:

| Criterion | How to Verify |
|-----------|--------------|
| Color contrast | 4.5:1 for normal text, 3:1 for large text |
| Keyboard navigation | All interactive elements reachable via Tab |
| Screen reader | All images have alt text, forms have labels |
| Focus indicators | Visible focus ring on all interactive elements |
| Motion | Respect `prefers-reduced-motion` |

### 19.2 Testing Process

- Use axe-core or similar in component tests
- Manual keyboard navigation test for new UI flows
- Screen reader verification for critical paths (login, bootstrap, dashboard)

---

## 20. API Versioning Strategy

### 20.1 Current Version

All APIs are versioned at `/api/v1/`. The `v1` prefix is included in every route.

### 20.2 Breaking Changes

A change is breaking if it:
- Removes or renames an endpoint
- Removes or renames a field in a response body
- Changes the type of a field
- Adds a required field to a request body
- Changes the semantics of an existing field

### 20.3 Process for Breaking Changes

1. **Introduce v2 endpoint** alongside v1
2. **Deprecation notice** — v1 endpoint returns `Sunset` header with removal date
3. **Migration period** — minimum 3 months of dual support
4. **Remove v1** — only after all known consumers have migrated
5. **Document** — changelog entry with migration guide
