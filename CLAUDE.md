# OnePlatform — Claude Code Instructions

## Authoritative Process Document

**Read `DEVELOPMENT-PROCESS.md` before doing ANY work.** It is the single source of truth for how development is conducted on this project. Follow it exactly.

## Core Directives

1. **Always use agents and sub-agents.** Every phase of work uses the appropriate agent type (Architect, Architecture Reviewer, Developer, Tester, Code Reviewer). Use sub-agents for parallel work.
2. **Write detailed prompts.** Every agent prompt must include: context, specific task, constraints, reference documents, output format, and quality criteria. See DEVELOPMENT-PROCESS.md §3.3 for examples.
3. **Follow the full pipeline.** Analysis → Architecture → Arch Review → Theoretical Test → Design → Design Review → Implementation → Tests → Code Review → Commit. No shortcuts.
4. **SOLID is non-negotiable.** Every interface, every module, every service follows SOLID principles. Check at every review stage.
5. **No compromise on quality.** Never shortcut for MVP. Always choose the best option. Finish everything perfectly.
6. **Document everything.** Update WORKING-STATE.md, handoff.md, and design docs after every change.
7. **Write detailed plans and todos.** Use TaskCreate to track all work. Keep tasks up to date with TaskUpdate.

## Reference Hierarchy

```
Architecture Decisions (docs/decisions/) → must conform to
  Design Specs (docs/designs/) → must conform to
    Implementation (services/*/src/) → verified by
      Tests (services/*/src/__tests__/)
```

## Key Files

| What | Where |
|------|-------|
| Development Process | `DEVELOPMENT-PROCESS.md` |
| Architecture Decisions | `docs/decisions/001-architecture-decisions.md` |
| Working State | `docs/WORKING-STATE.md` |
| Session Handoff | `.claude/handoff.md` |
| Service Designs | `docs/designs/*.md` |
| User Story Analysis | `docs/USER-STORIES-ANALYSIS-V*.md` |
| Gap Analysis | `docs/GAP-ANALYSIS.md` |

## Tech Stack

- **Frontend:** React 18, TypeScript, Tailwind CSS v4, shadcn/ui
- **Backend:** Hono (TypeScript), Node.js
- **Database:** PostgreSQL 16 + PgBouncer
- **Queue/Cache:** Redis 7 + BullMQ
- **Sandbox:** isolated-vm (JS/TS) + Docker containers (Python/Go)
- **Monorepo:** Turborepo + pnpm workspaces

## Project Structure

```
services/          — 9 microservices (gateway, auth, ingestion, ontology, pipeline, execution, app, logging, plugin)
packages/          — Shared packages (core, sdk, app-sdk, plugin-sdk, cli, frontend, docs)
docker/            — Docker Compose, configs, init scripts
docs/              — Architecture decisions, designs, analyses, quickstarts
tools/             — Build tools (openapi-gen)
tests/             — Cross-service test infrastructure
```

## Session Workflow

1. Read `docs/WORKING-STATE.md` to understand current state
2. Read `.claude/handoff.md` for the last session's context
3. Read `DEVELOPMENT-PROCESS.md` for the pipeline
4. Create tasks for the session's work
5. Execute following the pipeline
6. Update WORKING-STATE.md and handoff.md before ending
