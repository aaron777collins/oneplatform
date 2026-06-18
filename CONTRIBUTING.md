# Contributing to OnePlatform

Welcome, and thank you for considering a contribution to OnePlatform. This project is built
by its community, and every pull request — whether a bug fix, a new connector, a docs
improvement, or a fresh feature — makes the platform better for everyone.

Before contributing, please read and abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
We are committed to a welcoming environment for contributors of all backgrounds and
experience levels.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Project Structure](#project-structure)
3. [Development Workflow](#development-workflow)
4. [Coding Standards](#coding-standards)
5. [Architecture](#architecture)
6. [Reporting Issues](#reporting-issues)
7. [Code of Conduct](#code-of-conduct)

---

## Getting Started

### Prerequisites

| Tool | Minimum version | Notes |
|------|-----------------|-------|
| Node.js | 22+ | Use `nvm` or `fnm` to manage versions |
| pnpm | 9+ | `npm install -g pnpm` |
| Docker | 24+ | Required for database and cache infrastructure |
| Docker Compose | v2 plugin | Bundled with Docker Desktop; check with `docker compose version` |

### Clone and install dependencies

```bash
git clone https://github.com/aaron777collins/oneplatform.git
cd oneplatform
pnpm install
```

`pnpm install` respects `pnpm-lock.yaml`. Never delete the lockfile or run `pnpm install
--no-frozen-lockfile` on a PR — the CI pipeline enforces an exact lockfile match.

### Start infrastructure

The platform requires PostgreSQL 16 and Redis 7 running locally. Docker Compose provides
them with the correct initialization scripts and schemas:

```bash
docker compose -f docker/docker-compose.yml up -d postgres redis pgbouncer
```

Verify they are healthy before proceeding:

```bash
docker compose -f docker/docker-compose.yml ps
```

### Copy environment variables

```bash
cp .env.example .env
```

The defaults in `.env.example` are configured for the Docker Compose dev environment and
work without modification for local development.

### Build all packages

Building packages in dependency order is handled by Turborepo:

```bash
pnpm build
# or equivalently
turbo build
```

The `@oneplatform/core` package must be built first; Turborepo resolves this automatically
from the workspace dependency graph.

### Run the test suite

```bash
pnpm test
```

This runs all unit tests across every service and package in parallel via Turborepo. See
[Coding Standards — Test coverage](#test-coverage) for what the suite includes.

### Start development servers

```bash
pnpm dev
```

All 9 services and the frontend start in watch mode with automatic rebuilds on file changes.
The API Gateway is available at `http://localhost:3000`; the frontend at `http://localhost:5173`.

For TLS in development (matching production Caddy configuration):

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts the full stack including Caddy, which provides TLS at `https://localhost` using
a self-signed certificate.

---

## Project Structure

```
services/           9 microservices — one directory per service
  gateway/          API routing, rate limiting, auth validation
  auth/             Users, sessions, OAuth, RBAC
  ingestion/        Data connectors, webhooks, file uploads
  ontology/         Schema engine, data mapping, code generation
  pipeline/         Workflow orchestration, triggers, cron
  execution/        Sandboxed code execution (isolated-vm + Docker)
  app/              User app hosting and runtime
  logging/          Centralized logs, audit, metrics
  plugin/           Plugin lifecycle, hooks, registry

packages/           Shared packages consumed by services and external developers
  core/             @oneplatform/core — shared engine library (DB, auth, queues, types)
  sdk/              @oneplatform/sdk — external TypeScript client SDK
  app-sdk/          @oneplatform/app-sdk — React hooks and BFF client for platform apps
  plugin-sdk/       @oneplatform/plugin-sdk — plugin manifest, testing utilities, dev tools
  cli/              @oneplatform/cli — the `op` CLI tool
  frontend/         React 18 + Tailwind CSS v4 frontend application

plugins/            Built-in connectors (each is a plugin following the plugin-sdk contract)
  connector-csv/
  connector-mysql/
  connector-postgres/
  connector-rest-api/
  connector-webhook/

docker/             Docker Compose definitions, Caddy config, init scripts, service configs
docs/               Architecture decisions, L2 service designs, user story analyses, quickstarts
  decisions/        Architecture Decision Records (ADRs)
  designs/          L2 service designs (database schemas, API specs, flow diagrams)
  quickstart/       Per-persona getting-started guides
tests/              Cross-service integration and E2E test infrastructure
tools/              Build tools (OpenAPI generator)
.github/            CI workflows, issue templates, PR template
```

Every service follows the same internal layout:

```
services/<name>/
  src/
    routes/         Hono route handlers
    services/       Business logic (injected via constructor)
    repositories/   Database access (parameterized queries only)
    middleware/      Request-scoped middleware
    __tests__/      Unit and integration tests
  package.json
  tsconfig.json
```

---

## Development Workflow

### Branch naming

| Prefix | When to use |
|--------|-------------|
| `feat/` | New feature or capability |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `refactor/` | Code restructure with no behaviour change |
| `test/` | Adding or fixing tests |
| `chore/` | Dependency updates, tooling, CI |

Examples: `feat/oidc-sso-plugin`, `fix/gateway-rate-limit-header`, `docs/quickstart-data-engineer`

Branch from `main` and keep branches focused on a single concern. Long-lived branches
diverge quickly in an active monorepo.

### Commit message style

OnePlatform uses [Conventional Commits](https://www.conventionalcommits.org/). The format is:

```
<type>(<optional scope>): <subject>

<optional body explaining WHY, not just WHAT>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`

Examples:

```
feat(auth): add OIDC authorization code flow with PKCE

Implements the IdP plugin interface defined in docs/designs/auth-service.md §14.
SSO is exposed as a plugin rather than hardcoded logic so enterprise identity
providers can be added without modifying the Auth service core.
```

```
fix(gateway): correct rate limit header on 429 responses

The Retry-After header was returning milliseconds instead of seconds.
Affects all clients that rely on the header to back off correctly.
```

Commit body lines should be no longer than 72 characters. The subject line should be no
longer than 72 characters and written in the imperative mood ("add", "fix", "update",
not "added", "fixed", "updated").

Do not include TODO/FIXME/HACK comments in committed code. Fix the issue before committing
or create a GitHub issue and reference it with a ticket number.

### Development pipeline

All non-trivial work follows the six-phase pipeline described in
[DEVELOPMENT-PROCESS.md](./DEVELOPMENT-PROCESS.md). The phases are:

1. **Analysis** — user story and impact analysis across the affected personas
2. **Architecture** — design document produced and reviewed against the ADRs
3. **Design** — detailed L2 design (database schema, API spec, flow diagrams, error codes)
4. **Implementation** — code written against the approved design
5. **Code review** — security, SOLID, conformance, performance, test coverage
6. **Commit and document** — commit with rationale, update working state and handoff docs

For small bug fixes and documentation changes the pipeline is lighter, but the code review
and "all tests pass" requirements are never skipped.

### Pull request process

1. Open a PR against `main` using the [PR template](./.github/PULL_REQUEST_TEMPLATE.md).
2. Fill every section of the template — summary, changes, testing steps, checklist.
3. Ensure CI is green before requesting review. Never ask for a review on a red build.
4. At least one approving review is required before merge.
5. Squash-merge is preferred for feature branches to keep `main` history readable.
   Exception: multi-commit chains that tell a clear story may be merged with rebase.
6. Delete the source branch after merge.

For large features (new service, new connector, significant API change), open a Discussion
or a draft PR describing the design **before** writing implementation code. This prevents
large PRs being blocked on architectural feedback late in the process.

### Code review requirements

Reviewers check the following criteria (defined in full in DEVELOPMENT-PROCESS.md §4.5):

| Criterion | What reviewers look for |
|-----------|------------------------|
| Security | Injection, SSRF, token leakage, missing auth checks |
| SOLID | SRP violations, tight coupling, fat interfaces, missing DI |
| Conformance | Implementation matches the approved L2 design |
| Error handling | All error paths return defined error codes; no swallowed errors |
| Performance | N+1 queries, unbounded iterations, missing indexes |
| Tests | Edge cases, security paths, and error conditions covered |
| API consistency | Envelope format, cursor pagination, naming conventions |

Verdicts are **RED** (blocking — fix before merge), **YELLOW** (should fix), or **GREEN**
(approved).

---

## Coding Standards

### TypeScript strict mode

All packages compile with `"strict": true`. New code must not introduce `any`, non-null
assertions (`!`), or type casts (`as Foo`) except where genuinely unavoidable, and those
cases must be commented explaining why.

The base TypeScript configuration lives in [`tsconfig.base.json`](./tsconfig.base.json).
Every package and service extends it.

### SOLID principles

SOLID compliance is non-negotiable on this project (DEVELOPMENT-PROCESS.md §1.1):

- **Single Responsibility** — each class, module, and service does exactly one thing. If
  you find yourself writing "and" in a class description, split it.
- **Open/Closed** — new features extend via plugins, hooks, or interfaces rather than
  modifying existing code. This is why the plugin system is first-class.
- **Liskov Substitution** — any concrete implementation of an interface must be swappable
  without behavioral changes. Tests for the interface contract, not the implementation.
- **Interface Segregation** — no fat interfaces. Consumers depend only on the methods they
  use. Split broad interfaces into focused ones.
- **Dependency Inversion** — all external dependencies are injected via constructor. No
  module-level singletons for services that touch the database, Redis, or external APIs.

These are reviewed at every PR. A SOLID violation is a **RED** review finding.

### Linting and formatting

```bash
pnpm lint       # ESLint across all packages (must be clean before opening a PR)
pnpm format     # Prettier format check
pnpm format:fix # Apply Prettier formatting
```

CI enforces both. Fix lint and format issues locally rather than relying on CI to catch them.

The ESLint configuration is in each package's `eslint.config.js`, extending the shared
base configuration in `packages/core`.

### Test coverage

Every change must include tests at the appropriate level:

| Level | What it covers | Where |
|-------|---------------|-------|
| Unit | Individual functions and classes in isolation, with mocked dependencies | `services/<name>/src/__tests__/` |
| Integration (L1) | Service HTTP API against a real database and Redis | `services/<name>/src/__tests__/integration/` |
| Cross-service (L2) | Service-to-service HTTP communication | `tests/integration/` |
| E2E (L3) | Complete user stories through the full stack | `tests/e2e/` |

Minimum coverage targets:

- 80% line coverage for all service code
- 90% line coverage for security-critical paths (auth, permission checks, sandbox)

Test naming convention (see DEVELOPMENT-PROCESS.md §7.5):

```typescript
describe('AuthService', () => {
  describe('login', () => {
    it('should return access and refresh tokens for valid credentials', ...);
    it('should return UNAUTHORIZED for invalid password', ...);
    it('should lock account after 10 consecutive failed logins', ...);
  });
});
```

Names must be complete sentences that describe the expected behavior, not the
implementation. A failing test should read like a specification violation.

### Parameterized queries

All database queries use parameterized statements. String concatenation in SQL is never
acceptable. This is enforced in code review as a **RED** security finding.

### Input validation at boundaries

Every HTTP request body, query parameter, and path parameter is validated at the route
handler level using Zod schemas before reaching business logic. Validation schemas live
alongside the route files.

### Error handling

- All error paths must return a defined error code from the service's error catalog.
- Never swallow errors silently.
- Log errors with enough context for diagnosis (request ID, tenant ID, relevant entity IDs).
- Never expose internal error messages, stack traces, or database errors to API consumers.

### Dependency additions

Adding a new dependency requires justification in the PR description:

- Why is this dependency needed?
- Why is an existing dependency not sufficient?
- What is the dependency's maintenance status and license?

Production dependencies are scrutinized more than dev dependencies. Prefer packages with
a small dependency tree. Run `pnpm audit` before opening a PR.

---

## Architecture

The authoritative architecture documentation lives in:

- [`docs/decisions/001-architecture-decisions.md`](./docs/decisions/001-architecture-decisions.md) —
  all 23 Architecture Decision Records (ADRs) governing the system
- [`docs/decisions/002-expanded-architecture-decisions.md`](./docs/decisions/002-expanded-architecture-decisions.md) —
  extended ADRs for later design phases
- [`docs/designs/`](./docs/designs/) — L2 service designs with database schemas, API
  specifications, flow diagrams, and error catalogs for each of the 9 services

Any contribution that changes a public API, database schema, cross-service contract, or
core library interface must reference the applicable ADRs in the PR. If the change
requires a new architectural decision, propose an ADR update in the PR and mark the PR
as draft until the architecture question is resolved.

If you believe an existing ADR should change, open a GitHub Discussion to propose the
change before writing code. Silently diverging from the architecture is a **RED** code
review finding.

---

## Reporting Issues

Use the GitHub issue templates to report bugs or propose features:

- **[Bug Report](./.github/ISSUE_TEMPLATE/bug_report.md)** — for reproducible defects.
  Include steps to reproduce, expected behavior, actual behavior, and environment details.
- **[Feature Request](./.github/ISSUE_TEMPLATE/feature_request.md)** — for new
  capabilities or improvements. Describe the problem being solved, not just the solution.

**Security vulnerabilities** must not be reported as public issues. Use
[GitHub's private security advisory workflow](https://github.com/aaron777collins/oneplatform/security/advisories/new)
so the vulnerability can be assessed and patched before public disclosure.

For questions and early-stage ideas that do not fit either template, use
[GitHub Discussions](https://github.com/aaron777collins/oneplatform/discussions).

When reporting a bug, please check existing open issues first to avoid duplicates. If an
issue already exists, add a comment with any additional reproduction details rather than
opening a new one.

---

## Code of Conduct

By participating in this project, you agree to abide by the
[Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md) (version 2.1).

Instances of abusive, harassing, or otherwise unacceptable behavior may be reported to
the project maintainers at the contact address listed in the Code of Conduct. All
complaints will be reviewed and investigated promptly and fairly. Maintainers are obligated
to maintain confidentiality with regard to the reporter of an incident.
