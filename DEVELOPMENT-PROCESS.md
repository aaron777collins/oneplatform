# OnePlatform Development Process

This document defines the rigorous development pipeline used for ALL work on OnePlatform. Every feature, service, and component goes through this process. No exceptions.

## Core Principles (ALWAYS in mind)

These principles govern every decision at every level:

1. **SOLID** — Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion
2. **Extendibility** — Everything is extensible via plugins and interfaces. Built-in features use the same extension points as third-party ones.
3. **Plugin Architecture** — The Plugin Service and plugin-sdk are first-class. Connectors, transformers, destinations, auth providers, and widgets are all plugins.
4. **CORE Library** — `@oneplatform/core` is the shared backbone. All services import it. Zero boilerplate for new services.
5. **Microservices** — 9 services with clean boundaries. Inter-service auth. 3-tier network topology.
6. **Maintainability** — Modular code, comprehensive tests, auto-generated docs. Code is readable and well-structured.
7. **Security First** — Auth is first-class. Ontology-driven RBAC. Sandboxed execution. Encrypted credentials.
8. **API First** — Every operation is available via REST API, CLI, and SDKs. The UI is one client of many.

## Reference Hierarchy

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

At every level, check that your work conforms to ALL levels above it. If a lower-level decision contradicts a higher-level one, the higher level wins.

## Development Flow

Every piece of work follows this pipeline:

```
┌─────────────┐
│  1. PROPOSE │  Architect agent creates design
└──────┬──────┘
       ↓
┌─────────────────┐
│  2. ARCH REVIEW │  Architecture reviewer validates design
└──────┬──────────┘
       ↓ (if REVISE → back to 1)
┌─────────────────────────┐
│  3. THEORETICAL TEST    │  Verify design covers all edge cases,
│                         │  failure modes, and contracts
└──────┬──────────────────┘
       ↓
┌─────────────┐
│  4. DEVELOP │  Developer agent implements code
└──────┬──────┘
       ↓
┌──────────────────┐
│  5. WRITE TESTS  │  Tester agent writes comprehensive test suites
└──────┬───────────┘
       ↓
┌──────────────┐
│  6. RUN TESTS│  Execute all tests — unit, integration, contract
└──────┬───────┘
       ↓
┌────────────────────────────┐
│  7. CODE REVIEW            │  Code reviewer checks:
│     RED / YELLOW / GREEN   │  RED = blocking issues
│                            │  YELLOW = warnings, should fix
│                            │  GREEN = approved
└──────┬─────────────────────┘
       ↓ (if RED → back to 4)
       ↓ (if YELLOW → fix then back to 7)
┌──────────────┐
│  8. COMMIT   │  Commit and push
└──────────────┘
```

## Agent Team Roles

| Agent | Role | Tools |
|-------|------|-------|
| **Architect** | Creates designs for services/features. References L0 architecture. | Read, Write, WebSearch |
| **Architecture Reviewer** | Reviews designs for correctness, security, completeness. Issues APPROVED/REVISE. | Read, all tools |
| **Developer** | Implements code following approved designs. SOLID principles. | All tools |
| **Tester** | Writes comprehensive test suites — unit, integration, contract, e2e, security. | All tools |
| **Code Reviewer** | Reviews code for security, correctness, performance, quality. Issues RED/YELLOW/GREEN. | Read, all tools |

## Test Strategy

Every service must have:

### Unit Tests
- Every function/method tested in isolation
- Edge cases, error paths, boundary conditions
- Mock external dependencies (DB, Redis, other services)

### Integration Tests
- Service-level: test the service's HTTP API with real DB/Redis
- Cross-service: test service-to-service communication
- Queue integration: test BullMQ job processing end-to-end

### Contract Tests
- Every service defines its API contract (OpenAPI spec)
- Contract tests verify the service conforms to its spec
- Consumer-driven: downstream services define what they expect
- Provider verification: upstream services prove they deliver it

### E2E Tests
- Full user stories tested end-to-end through all services
- Docker Compose stack spun up for e2e test runs
- Covers: data ingestion → ontology mapping → pipeline execution → app display

### Security Tests
- Auth bypass attempts
- Sandbox escape attempts
- SQL injection, XSS, CSRF
- Rate limit verification
- Permission boundary tests (entity, field, row level)

## Commit Guidelines

- Commit often — after each meaningful unit of work
- Commit message format: imperative, descriptive, with rationale
- Always push to remote after commits
- Never leave uncommitted work at the end of a session

## Quality Gates

Before any PR is merged:
1. All tests pass (unit + integration + contract)
2. Code review is GREEN (no RED or YELLOW items)
3. Architecture review is APPROVED
4. Design conforms to L0 architecture decisions
5. Documentation is auto-generated and up-to-date
6. No TODO/FIXME/HACK comments (fix them or create tickets)
