# OnePlatform — System Analysis & Development Protocol

This document defines the comprehensive protocol for system analysis, issue resolution, example project creation, and ongoing quality assurance. It works in conjunction with [`DEVELOPMENT-PROCESS.md`](../DEVELOPMENT-PROCESS.md), which defines the rigorous development pipeline. **Read `DEVELOPMENT-PROCESS.md` before doing ANY work.**

---

## 1. Guiding Directives (Non-Negotiable)

These directives apply to ALL work — analysis, implementation, testing, documentation, and review. No exceptions.

### 1.1 Quality Standards

| Directive | Detail |
|-----------|--------|
| **No Compromise** | Never shortcut for "MVP". Always choose the best option. Finish everything perfectly. |
| **SOLID Architecture** | Every interface, module, service, and component follows SOLID principles. Verified at every review stage. See `DEVELOPMENT-PROCESS.md` §1.1. |
| **Modular Design** | All components are modular, reusable, and composable. No monolithic blocks. |
| **Plugin / Extensibility** | Everything is extensible via plugins, hooks, and interfaces. Built-in features use the same extension points as third-party. Power users can customize anything. |
| **Low-Code / No-Code First** | Built-in capabilities for essentially everything any user would need. Custom code only for those who want more. |
| **Future-Proof** | Design for the future. Consider every flow a user would want. Don't just solve today's problem. |

### 1.2 Process Standards

| Directive | Detail |
|-----------|--------|
| **Full Dev Flow** | Every change goes through: Propose → Architecture Review → Theoretical Test → Implementation → Practical Test → Code Review → loop until perfect. See `DEVELOPMENT-PROCESS.md` §4-8. |
| **Agents & Sub-Agents** | Always use specialized agents (Architect, Architecture Reviewer, Developer, Tester, Code Reviewer, Explore). Use sub-agents for parallel work. Never do everything in the main context. See `DEVELOPMENT-PROCESS.md` §3. |
| **Detailed Plans & Todos** | Use TaskCreate to track all work. Break work into discrete steps. Keep tasks updated with TaskUpdate. Mark completed as you go. |
| **Detailed Prompts** | Every agent prompt must include: context, specific task, constraints, reference documents, output format, and quality criteria. See `DEVELOPMENT-PROCESS.md` §3.3. |
| **Detailed Responses** | Agents must provide comprehensive, specific responses — not summaries or hand-waves. Include file paths, line numbers, code snippets. |
| **Commit Often, Push Often** | After each logical unit of work (a fix, a feature, a batch of related changes), commit and push. Don't batch everything at the end. |
| **Keep Docs Up to Date** | Update `docs/WORKING-STATE.md`, `.claude/handoff.md`, and relevant design docs alongside code changes. Not as an afterthought — as part of the same work. |
| **Write Handoff Docs Often** | Update `.claude/handoff.md` frequently so any session can pick up where the last left off. Include what was done, what's next, and any blockers. |

---

## 2. System Analysis Protocol

### 2.1 Full Codebase Analysis

When performing a full system analysis, follow this protocol:

#### Phase 1: Build & Test Verification
1. Run `pnpm turbo build` — all packages must compile clean
2. Run `pnpm turbo test` — all tests must pass
3. Run `pnpm turbo lint` (if configured) — no lint errors
4. Document any failures as immediate blockers

#### Phase 2: Multi-Agent Deep Analysis
Fan out specialized analysis agents across all components:

| Target | Agent Count | Focus |
|--------|------------|-------|
| 9 Microservices | 9 agents | Bugs, security, correctness, resource leaks, type safety |
| 7 Shared Packages | 6-7 agents | API contracts, type exports, crypto, middleware bypasses |
| 7 Plugins | 7 agents | Logic errors, SQL injection, resource leaks, schema handling |
| Cross-Cutting Security | 1 agent | Auth bypass, service-to-service auth, sandbox escape, RBAC |
| Cross-Cutting Consistency | 1 agent | API patterns, DB patterns, config consistency, import patterns |

**Total: 24+ parallel analysis agents**

#### Phase 3: Adversarial Verification
- Every CRITICAL and HIGH finding gets an independent verification agent
- Verifier's job is to **refute** the finding — check actual code, look for mitigating factors
- Only findings that survive verification are acted on
- Default to `isReal=false` if uncertain — we only want confirmed bugs

#### Phase 4: Issue Triage & Fix Plan
- Group confirmed findings by severity and component
- Create a detailed fix plan with specific file changes
- Prioritize: CRITICAL → HIGH → MEDIUM → LOW
- Each fix gets its own task in TaskCreate

#### Phase 5: Fix Implementation
- Use Developer agents to implement fixes
- Each fix must be verified by building and testing
- Commit and push after each logical batch of fixes
- Update docs after each batch

### 2.2 What to Look For

**Must Report:**
- Logic errors, wrong conditions, off-by-one errors, incorrect return values
- Missing `await` on async calls, unhandled promise rejections
- SQL injection, command injection, path traversal, SSRF, auth bypass
- Missing auth checks, credential leaks, XSS vulnerabilities
- Race conditions, data integrity issues, incorrect error handling
- Resource leaks: unclosed connections, missing cleanup, unbounded growth
- `as any` casts hiding real type mismatches
- Missing input validation at API boundaries
- Incorrect HTTP status codes, API contract violations

**Do NOT Report:**
- Style preferences or naming conventions
- "Could add more tests" suggestions
- "Consider adding logging" suggestions
- Theoretical performance issues without concrete impact
- Missing features (those go in a separate gap analysis)

---

## 3. Example Project Creation Protocol

### 3.1 Objectives
- Create comprehensive example projects using ALL frameworks and systems OnePlatform supports
- Demonstrate ALL features — connectors, pipelines, apps, plugins, ontology, execution, logging
- Low-code/no-code user stories must cover essentially everything anyone would need
- Power users get custom extensibility for when they want more
- Every user flow must work end-to-end

### 3.2 User Personas & Flows

Every example project must demonstrate flows for these personas:

| Persona | Key Flows |
|---------|-----------|
| **Low-Code User** | Visual pipeline builder, drag-and-drop app builder, template-based setup, no code required |
| **Data Engineer** | Connector setup, schema mapping, pipeline orchestration, data quality monitoring |
| **Platform Admin** | Bootstrap, user management, RBAC, tenant management, monitoring, backups |
| **App Developer** | SDK usage, custom components, API integration, testing |
| **Plugin Developer** | Plugin SDK, custom connectors, custom auth providers, marketplace publishing |
| **Security Engineer** | Auth configuration, RBAC policies, audit logs, credential management |
| **DevOps Engineer** | Docker deployment, Helm charts, monitoring, scaling, CI/CD |
| **API Consumer** | REST API, SDK client, CLI usage, webhook integration |
| **Business Analyst** | Dashboard creation, report building, data exploration, SQL queries |
| **Integration Specialist** | Multi-system connectivity, webhook flows, event-driven architectures |
| **Drag-and-Drop UI User** | Visual editor, template selection, component library, no-code app creation |

### 3.3 Example Project Requirements

Each example project must:
1. Be a self-contained, runnable project in the `examples/` directory
2. Include a README with setup instructions
3. Include all configuration files needed to run
4. Demonstrate integration with multiple OnePlatform services
5. Include both low-code (visual/template) and code-first approaches
6. Follow SOLID principles and the plugin architecture
7. Be modular — each feature can be used independently
8. Include error handling and edge case coverage
9. Work without writing custom code (for low-code users)
10. Be extensible for power users who want custom behavior

### 3.4 Built-In Capabilities (Low-Code / No-Code)

The platform must provide built-in support for these without requiring custom code:

| Category | Built-In Capabilities |
|----------|----------------------|
| **Data Sources** | REST API, PostgreSQL, MySQL, CSV, Webhook, CDC, Kafka, NATS |
| **Transformations** | Field mapping, filtering, aggregation, join, split, merge, lookup, expression evaluation |
| **Destinations** | Database write, API POST, webhook, file export, email notification |
| **Pipeline Patterns** | ETL, ELT, CDC replication, event processing, scheduled sync, real-time streaming |
| **App Templates** | CRUD admin, form builder, dashboard, data explorer, report builder, workflow tracker |
| **UI Components** | Tables, charts, forms, modals, tabs, cards, lists, filters, search, pagination |
| **Auth** | Local, OIDC, LDAP, API keys, service tokens |
| **Monitoring** | Health checks, metrics, alerting, audit logs, execution history |

---

## 4. Reference Documents

This protocol works in conjunction with the following documents. **All must be consulted.**

| Document | Purpose | Path |
|----------|---------|------|
| **Development Process** | Full pipeline, agent types, quality gates, implementation patterns | `DEVELOPMENT-PROCESS.md` |
| **Architecture Decisions** | 36 ADRs — the L0 reference for all design choices | `docs/decisions/001-architecture-decisions.md` |
| **Working State** | Current development state — read FIRST when resuming | `docs/WORKING-STATE.md` |
| **Session Handoff** | Last session's context, what was done, what's next | `.claude/handoff.md` |
| **Service Designs** | L2 service-level designs for all 9 services | `docs/designs/*.md` |
| **Gap Analysis** | 127 gaps across 9 categories (all closed) | `docs/GAP-ANALYSIS.md` |
| **User Story Analyses** | V2-V6 friction point analyses (634 findings, all resolved) | `docs/USER-STORIES-ANALYSIS-V*.md` |
| **Operations** | Day-to-day platform operations | `docs/OPERATIONS.md` |
| **Monitoring** | Observability and alerting setup | `docs/MONITORING.md` |
| **Troubleshooting** | Common issues and debug procedures | `docs/TROUBLESHOOTING.md` |

---

## 5. Session Workflow

Every session must follow this workflow:

1. **Read** `docs/WORKING-STATE.md` to understand current state
2. **Read** `.claude/handoff.md` for the last session's context
3. **Read** `DEVELOPMENT-PROCESS.md` for the full pipeline
4. **Read** this document for the analysis and quality protocol
5. **Create tasks** for the session's work using TaskCreate
6. **Execute** following the full dev flow (Propose → Review → Test → loop)
7. **Use agents and sub-agents** for all work — never do everything in main context
8. **Commit and push** after each logical unit of work
9. **Update** `docs/WORKING-STATE.md` and `.claude/handoff.md` after each significant change
10. **Write detailed prompts** for every agent — context, task, constraints, references, format, quality criteria
11. **Write detailed responses** — file paths, line numbers, code snippets, reasoning

---

## 6. Quality Gates

No work is considered complete until ALL of these pass:

- [ ] All packages build clean (`pnpm turbo build`)
- [ ] All tests pass (`pnpm turbo test`)
- [ ] No CRITICAL or HIGH issues remain
- [ ] Code review approved (no RED blockers)
- [ ] Documentation updated (WORKING-STATE.md, handoff.md)
- [ ] Changes committed and pushed
- [ ] Example projects (if applicable) demonstrate all features
- [ ] Low-code flows work without custom code
- [ ] All user persona flows verified
