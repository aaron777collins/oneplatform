# @oneplatform/cli — L2 Package Design

**Document status:** Approved
**Last updated:** 2026-06-10
**Author:** Platform Architecture
**Supersedes:** CLI summary in L1 design (lines 1623–1683) and ADR-34
**ADRs this document implements:** ADR-22 (SDK/CLI as First-Class Citizens), ADR-23 (Auto-Generated Docs), ADR-34 (CLI Design Specification)

---

## Table of Contents

1. [Package Overview](#1-package-overview)
2. [Command Architecture](#2-command-architecture)
3. [Module Structure](#3-module-structure)
4. [All 20 Command Groups](#4-all-20-command-groups)
5. [Credential Storage](#5-credential-storage)
6. [Profile System](#6-profile-system)
7. [Output Formatting](#7-output-formatting)
8. [HTTP Client](#8-http-client)
9. [Config Export and Import](#9-config-export-and-import)
10. [Interactive Prompts](#10-interactive-prompts)
11. [Error Handling and Exit Codes](#11-error-handling-and-exit-codes)
12. [Security Design](#12-security-design)
13. [Observability](#13-observability)
14. [Distribution](#14-distribution)
15. [Testing Strategy](#15-testing-strategy)
16. [Technology Choices](#16-technology-choices)

---

## 1. Package Overview

### 1.1 Purpose

`@oneplatform/cli` provides the `op` command — a complete, API-first command-line interface for every OnePlatform operation. It is a thin wrapper over the REST API with no privileged access. Every command the CLI executes is available and equivalent through the REST API.

The CLI is a first-class product surface, not an afterthought. It is tested, documented, and versioned with the same rigour as the API itself.

### 1.2 What It Is Not

The CLI does not connect to databases directly, does not speak internal service-to-service protocols, and cannot execute platform code outside the standard API surface. Any operation that requires direct database access (bootstrap reset, emergency re-key) is explicitly labelled as such and routed through the API's admin-only endpoints.

### 1.3 Package Identity

| Property | Value |
|---|---|
| npm package name | `@oneplatform/cli` |
| Binary name | `op` |
| Monorepo path | `packages/cli/` |
| Node.js requirement (npm path) | `>=22.0.0` |
| Bun requirement (build path) | `>=1.1.0` |
| License | BSL-1.1 |
| TypeScript target | `ES2023` |

### 1.4 Distribution Channels

Two distribution channels are provided:

**Standalone binaries** (primary for DevOps/CI): compiled with `bun build --compile`. No Node.js, no npm, no runtime dependency. Distributed via GitHub Releases. Target platforms:

| Binary name | Platform |
|---|---|
| `op-linux-amd64` | Linux x86\_64 |
| `op-linux-arm64` | Linux ARM64 (Graviton, Raspberry Pi) |
| `op-darwin-arm64` | macOS Apple Silicon |
| `op-darwin-amd64` | macOS Intel |
| `op-windows-amd64.exe` | Windows x86\_64 |

**npm package** (primary for Node.js developers):

```
npm install -g @oneplatform/cli
npx @oneplatform/cli <command>         # one-off without install
```

CI version pinning recommendation: use the explicit GitHub Release URL with a pinned version string, not `latest`. This is documented in the CI setup guide.

---

## 2. Command Architecture

### 2.1 Framework: Commander.js

The CLI is built on Commander.js (MIT). Rationale:

- Already selected in the tech stack (ADR tech stack table, row "CLI | Commander.js").
- Mature, zero-dependency, well-typed with `@types/commander` (now bundled).
- Supports nested subcommand hierarchies, help text generation, and completion hooks.
- Smaller bundle than yargs; appropriate for a compiled binary where bundle size matters.

Yargs was considered. It is heavier and its auto-magic (camelCase coercion, implicit options) introduces surprising behaviour in strict CI contexts. Commander.js is explicit about what is registered.

### 2.2 Entry Point

```
packages/cli/
  src/
    index.ts            <- binary entry point: creates root program, registers all groups
```

`index.ts` constructs the root `Command` instance and registers each command group as a nested `Command`. This is the only file that imports every group; every other module is independently testable.

```typescript
// src/index.ts (abbreviated)
import { Command } from "commander";
import { registerAuth }       from "./commands/auth/index.js";
import { registerProfile }    from "./commands/profile/index.js";
// ... 18 more imports

const program = new Command("op")
  .version(CLI_VERSION)
  .description("OnePlatform CLI")
  .addHelpText("after", "\nRun 'op <group> --help' for group-level help.")
  .hook("preAction", globalPreActionHook);   // injects context: credentials, output format

registerAuth(program);
registerProfile(program);
// ... 18 more registrations

program.parse(process.argv);
```

### 2.3 Global Flags

All global flags are registered on the root `program` and parsed before any subcommand runs via the `preAction` hook.

| Flag | Short | Env var | Default | Purpose |
|---|---|---|---|---|
| `--profile <name>` | | `OP_PROFILE` | `activeProfile` | Select credential profile |
| `--output <fmt>` | `-o` | `OP_OUTPUT` | auto (TTY=table, pipe=json) | Force output format |
| `--yes` | `-y` | | false | Skip destructive-action confirmations |
| `--quiet` | `-q` | | false | Suppress all output except errors |
| `--no-color` | | `NO_COLOR` | auto (disabled when non-TTY) | Disable ANSI colors |
| `--verbose` | `-v` | `OP_VERBOSE` | false | Print stack traces, HTTP request details |
| `--timeout <ms>` | | `OP_TIMEOUT` | 30000 | HTTP request timeout in milliseconds |
| `--platform <url>` | | `OP_PLATFORM_URL` | profile value | Override platform URL |

### 2.4 Command Group Registration Pattern

Each command group lives in `src/commands/{group}/index.ts` and exports a single `register` function:

```typescript
// Pattern used by every group
export function registerAuth(program: Command): void {
  const auth = program
    .command("auth")
    .description("Authentication and credential management");

  auth
    .command("login")
    .description("Interactive login or API key setup")
    .option("--platform <url>", "Platform URL")
    .option("--key <api-key>",  "API key (skips interactive prompt)")
    .action(withContext(loginAction));

  auth
    .command("logout")
    .description("Clear credentials for the current profile")
    .action(withContext(logoutAction));

  // ... remaining commands
}
```

`withContext` is a higher-order function that:
1. Reads the resolved configuration (profile, credentials, output format) from global state set by `preAction`.
2. Wraps the action in try/catch, formatting errors for display and setting the correct exit code.
3. Ensures the HTTP client is initialized with the resolved `platformUrl` and credentials.

### 2.5 Action Handlers

Each action lives in a separate file: `src/commands/{group}/{command}.ts`. Actions receive a typed `CommandContext` and return `Promise<void>`. They never call `process.exit` directly — they throw `CliError` and let the `withContext` wrapper handle exit codes.

```typescript
// src/commands/auth/login.ts
import type { CommandContext } from "../../lib/context.js";
import { CliError } from "../../lib/errors.js";

export async function loginAction(
  opts: { platform?: string; key?: string },
  ctx: CommandContext
): Promise<void> {
  const platformUrl = opts.platform ?? ctx.config.platformUrl;
  if (!platformUrl) {
    throw new CliError("No platform URL. Provide --platform or run 'op profile add'.", 1);
  }
  // ... implementation
}
```

### 2.6 Subcommand Hierarchy Summary

```
op
├── auth         login | logout | status | whoami | generate-key | list-keys |
│                revoke-key | rotate-key | emergency-rotate
├── profile      add | list | use | remove
├── user         list | invite | get | update | deactivate | import
├── role         list | create | assign | remove
├── ontology     list | get | create | update | delete | validate | diff |
│                migrate | migration-status | migration-rollback | export | import
├── data         query | get | create | update | delete | import | export
├── connector    list | create | get | update | delete | test | trigger
├── webhook-out  list | create | update | delete | test | logs
├── pipeline     list | get | create | update | delete | trigger | runs |
│                run-status | run-cancel | run-logs
├── schedule     list | create | pause | resume | delete
├── dlq          list | replay | discard
├── exec         run | history | logs
├── app          list | get | create | deploy | dev | logs | delete |
│                env-set | env-list | rollback
├── plugin       list | install | enable | disable | uninstall | info |
│                create | pack | validate | simulate-hook
├── logs         query | tail | audit | export
├── config       export | import | diff | validate
├── status       (+ --watch flag)
├── service      rotate-keys | health
├── sdk          generate
├── version
└── completion   bash | zsh | fish
```

Total: 20 command groups, approximately 95 commands.

---

## 3. Module Structure

```
packages/cli/
├── package.json
├── tsconfig.json
├── tsconfig.build.json         <- excludes tests from compiled output
├── scripts/
│   └── build-binaries.sh       <- calls bun build --compile for all 5 targets
├── src/
│   ├── index.ts                <- entry point
│   ├── commands/
│   │   ├── auth/
│   │   │   ├── index.ts        <- registerAuth(program)
│   │   │   ├── login.ts
│   │   │   ├── logout.ts
│   │   │   ├── status.ts
│   │   │   ├── whoami.ts
│   │   │   ├── generate-key.ts
│   │   │   ├── list-keys.ts
│   │   │   ├── revoke-key.ts
│   │   │   ├── rotate-key.ts
│   │   │   └── emergency-rotate.ts
│   │   ├── profile/
│   │   │   ├── index.ts
│   │   │   ├── add.ts
│   │   │   ├── list.ts
│   │   │   ├── use.ts
│   │   │   └── remove.ts
│   │   ├── user/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── invite.ts
│   │   │   ├── get.ts
│   │   │   ├── update.ts
│   │   │   ├── deactivate.ts
│   │   │   └── import.ts
│   │   ├── role/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── create.ts
│   │   │   ├── assign.ts
│   │   │   └── remove.ts
│   │   ├── ontology/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── get.ts
│   │   │   ├── create.ts
│   │   │   ├── update.ts
│   │   │   ├── delete.ts
│   │   │   ├── validate.ts
│   │   │   ├── diff.ts
│   │   │   ├── migrate.ts
│   │   │   ├── migration-status.ts
│   │   │   ├── migration-rollback.ts
│   │   │   ├── export.ts
│   │   │   └── import.ts
│   │   ├── data/
│   │   │   ├── index.ts
│   │   │   ├── query.ts
│   │   │   ├── get.ts
│   │   │   ├── create.ts
│   │   │   ├── update.ts
│   │   │   ├── delete.ts
│   │   │   ├── import.ts
│   │   │   └── export.ts
│   │   ├── connector/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── create.ts
│   │   │   ├── get.ts
│   │   │   ├── update.ts
│   │   │   ├── delete.ts
│   │   │   ├── test.ts
│   │   │   └── trigger.ts
│   │   ├── webhook-out/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── create.ts
│   │   │   ├── update.ts
│   │   │   ├── delete.ts
│   │   │   ├── test.ts
│   │   │   └── logs.ts
│   │   ├── pipeline/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── get.ts
│   │   │   ├── create.ts
│   │   │   ├── update.ts
│   │   │   ├── delete.ts
│   │   │   ├── trigger.ts
│   │   │   ├── runs.ts
│   │   │   ├── run-status.ts
│   │   │   ├── run-cancel.ts
│   │   │   └── run-logs.ts
│   │   ├── schedule/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── create.ts
│   │   │   ├── pause.ts
│   │   │   ├── resume.ts
│   │   │   └── delete.ts
│   │   ├── dlq/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── replay.ts
│   │   │   └── discard.ts
│   │   ├── exec/
│   │   │   ├── index.ts
│   │   │   ├── run.ts
│   │   │   ├── history.ts
│   │   │   └── logs.ts
│   │   ├── app/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── get.ts
│   │   │   ├── create.ts
│   │   │   ├── deploy.ts
│   │   │   ├── dev.ts          <- file-sync loop, SSE watcher, dev server
│   │   │   ├── logs.ts
│   │   │   ├── delete.ts
│   │   │   ├── env-set.ts
│   │   │   ├── env-list.ts
│   │   │   └── rollback.ts
│   │   ├── plugin/
│   │   │   ├── index.ts
│   │   │   ├── list.ts
│   │   │   ├── install.ts
│   │   │   ├── enable.ts
│   │   │   ├── disable.ts
│   │   │   ├── uninstall.ts
│   │   │   ├── info.ts
│   │   │   ├── create.ts       <- interactive scaffold with inquirer
│   │   │   ├── pack.ts
│   │   │   ├── validate.ts
│   │   │   └── simulate-hook.ts
│   │   ├── logs/
│   │   │   ├── index.ts
│   │   │   ├── query.ts
│   │   │   ├── tail.ts         <- SSE streaming
│   │   │   ├── audit.ts
│   │   │   └── export.ts
│   │   ├── config/
│   │   │   ├── index.ts
│   │   │   ├── export.ts
│   │   │   ├── import.ts       <- YAML parser, topological sort, conflict resolution
│   │   │   ├── diff.ts
│   │   │   └── validate.ts
│   │   ├── status/
│   │   │   ├── index.ts
│   │   │   └── status.ts       <- --watch polling loop
│   │   ├── service/
│   │   │   ├── index.ts
│   │   │   ├── rotate-keys.ts
│   │   │   └── health.ts
│   │   ├── sdk/
│   │   │   ├── index.ts
│   │   │   └── generate.ts
│   │   ├── version/
│   │   │   └── index.ts
│   │   └── completion/
│   │       ├── index.ts
│   │       ├── bash.ts
│   │       ├── zsh.ts
│   │       └── fish.ts
│   └── lib/
│       ├── context.ts          <- CommandContext type, preAction hook, config resolution
│       ├── credentials.ts      <- Credential read/write, keytar, HKDF-SHA256 fallback
│       ├── profiles.ts         <- Profile CRUD, active profile resolution
│       ├── http-client.ts      <- Fetch wrapper around @oneplatform/sdk
│       ├── output.ts           <- table, JSON, JSONL, TSV rendering, color, truncation
│       ├── errors.ts           <- CliError, exit code mapping, user-facing messages
│       ├── prompts.ts          <- inquirer.js wrappers, --yes bypass
│       ├── config-document.ts  <- YAML multi-doc parse, topological sort, conflict modes
│       ├── streaming.ts        <- SSE client for tail/run-logs/app-dev
│       ├── file-sync.ts        <- bidirectional file sync for op app dev
│       └── docs-generator.ts  <- help text → man-page markdown for /docs/cli
└── tests/
    ├── unit/
    │   ├── lib/
    │   │   ├── credentials.test.ts
    │   │   ├── output.test.ts
    │   │   ├── config-document.test.ts
    │   │   └── errors.test.ts
    │   └── commands/
    │       ├── auth/
    │       │   └── login.test.ts
    │       └── ...             <- one test file per command file
    ├── integration/
    │   ├── auth.int.test.ts
    │   ├── pipeline.int.test.ts
    │   └── config-import.int.test.ts
    └── snapshots/
        └── output/             <- golden snapshots for table/JSON rendering
```

---

## 4. All 20 Command Groups

For each command group: the complete command signatures, all flags, and the REST API endpoint each command maps to. All commands inherit the global flags from section 2.3.

### 4.1 `auth` — Authentication and Credential Management

Required scope: no scope required for login/logout/status/whoami; `admin` for emergency-rotate.

---

**`op auth login [--platform <url>] [--key <api-key>]`**

Establish credentials for the active profile. Two modes:

- Without `--key`: opens an interactive prompt asking for platform URL (if not already configured), then prompts for email and password. Calls `POST /api/v1/auth/login` and stores the resulting API key in the credential store.
- With `--key`: validates the provided key against `GET /api/v1/auth/me`, then stores it. No password prompt.

The command writes the `platformUrl` to `~/.config/oneplatform/profiles/{name}.json` and writes the encrypted API key to `~/.config/oneplatform/credentials.json`.

On success: prints `Logged in as {email} on {platformUrl}`.

---

**`op auth logout`**

Maps to: local credential removal only (no API call required; API keys remain valid until explicitly revoked).

Removes the active profile's encrypted credential from `credentials.json`. Prints `Logged out of {platformUrl}`.

---

**`op auth status`**

Maps to: `GET /api/v1/auth/me`

Prints: authentication state (logged in / not logged in), profile name, platform URL, user email, token expiry (if session-based).

---

**`op auth whoami`**

Maps to: `GET /api/v1/auth/me`

Prints: user id, email, display name, tenant id, tenant name, roles, active scopes.

Table output:

```
Field       Value
─────────── ─────────────────────────────────
id          usr_01HX...
email       alice@example.com
tenant      Acme Corp (ten_01HX...)
roles       platform_admin
```

---

**`op auth generate-key --name <name> --scopes <scopes,...> [--expires <ISO-date>]`**

Maps to: `POST /api/v1/auth/api-keys`

Request body: `{ name, scopes: string[], expiresAt?: string }`

Flags:
- `--name` (required): human-readable label for the key
- `--scopes` (required): comma-separated scope list, e.g. `data:read,pipelines:manage`
- `--expires`: ISO 8601 date string; omit for non-expiring key

Outputs the generated key value once — the API returns the raw key only at creation time. The CLI prints a warning: `Store this key securely. It will not be shown again.`

---

**`op auth list-keys`**

Maps to: `GET /api/v1/auth/api-keys`

Table columns: `ID`, `Name`, `Scopes`, `Created`, `Expires`, `Last Used`.

---

**`op auth revoke-key <key-id>`**

Maps to: `DELETE /api/v1/auth/api-keys/{keyId}`

Prompts for confirmation unless `--yes`. Prints `Key {key-id} revoked.`

---

**`op auth rotate-key <key-id> [--overlap <duration>]`**

Maps to: `POST /api/v1/auth/api-keys/{keyId}/rotate`

Flags:
- `--overlap`: duration string (`1h`, `30m`, `24h`); default `1h`. The old key remains valid for this period while consumers migrate to the new key.

Outputs the new key value and the overlap expiry time.

---

**`op auth emergency-rotate`**

Maps to: `POST /api/v1/admin/auth/emergency-rotate`

Requires `admin` scope. This is a destructive operation: it rotates the JWT signing secret, immediately invalidating all active sessions platform-wide. All users must re-authenticate.

Interactive confirmation regardless of `--yes` flag: requires the user to type the word `ROTATE` to confirm. This single command is exempt from `--yes` bypass because the blast radius is platform-wide.

Prints: `Emergency rotation complete. All {N} active sessions have been invalidated.`

### 4.2 `profile` — Multi-Environment Profile Management

No scope required. Operates on local config files only; no API calls except for `op profile add` which optionally validates the key.

---

**`op profile add <name> --platform <url> [--key <api-key>]`**

Creates `~/.config/oneplatform/profiles/{name}.json` and stores credentials. If `--key` is provided, validates it against `GET /api/v1/auth/me` before saving. If omitted, stores the platform URL only and prompts the user to run `op auth login --profile {name}` to add credentials.

Flags:
- `--platform` (required): platform base URL
- `--key`: API key to store encrypted

---

**`op profile list`**

Lists all profiles from `~/.config/oneplatform/profiles/`. Marks the active profile with `*`.

Table columns: `Name`, `Platform URL`, `Active`, `Last Used`.

---

**`op profile use <name>`**

Sets `activeProfile` in `~/.config/oneplatform/config.json`. Prints `Switched to profile '{name}'.`

---

**`op profile remove <name>`**

Deletes `~/.config/oneplatform/profiles/{name}.json` and removes the credential entry for that profile from `credentials.json`. Refuses to remove the active profile without `--yes` confirmation.

### 4.3 `user` — User Management

Required scope: `users:manage`

---

**`op user list [--tenant <id>] [--limit N] [--status active|inactive|all]`**

Maps to: `GET /api/v1/users`

Query params: `tenantId`, `limit`, `status`.

JSONL output for list commands. Table columns: `ID`, `Email`, `Display Name`, `Roles`, `Status`, `Created`.

---

**`op user invite --email <email> --role <role> [--send-email]`**

Maps to: `POST /api/v1/users/invite`

Flags:
- `--email` (required): target email address
- `--role` (required): role name to assign
- `--send-email`: trigger invitation email (default: true in interactive, false in CI)

---

**`op user get <id>`**

Maps to: `GET /api/v1/users/{id}`

Outputs full user record. JSON by default when piped; table in TTY.

---

**`op user update <id> --role <role> [--display-name <name>]`**

Maps to: `PATCH /api/v1/users/{id}`

Flags:
- `--role`: assign a role
- `--display-name`: update display name

---

**`op user deactivate <id>`**

Maps to: `POST /api/v1/users/{id}/deactivate`

Prompts for confirmation unless `--yes`. Prints `User {id} deactivated.`

---

**`op user import --file <csv-path> [--role <default-role>] [--dry-run]`**

Maps to: `POST /api/v1/users/import` (multipart CSV upload)

Flags:
- `--file` (required): path to CSV file with headers `email,displayName,role`
- `--role`: default role if CSV row omits role column
- `--dry-run`: validate CSV and report what would be created, no writes

Output: count of users created / skipped / failed.

### 4.4 `role` — Role Management

Required scope: `users:manage`

---

**`op role list`**

Maps to: `GET /api/v1/roles`

Table columns: `Name`, `Permissions`, `Users`, `Created`.

---

**`op role create --name <name> --permissions <perm,...>`**

Maps to: `POST /api/v1/roles`

Flags:
- `--name` (required): role identifier (lowercase, no spaces)
- `--permissions` (required): comma-separated permission list

---

**`op role assign <role-name> --user <user-id>`**

Maps to: `POST /api/v1/roles/{roleName}/members`

Request body: `{ userId }`

---

**`op role remove <role-name> --user <user-id>`**

Maps to: `DELETE /api/v1/roles/{roleName}/members/{userId}`

Prompts for confirmation unless `--yes`.

### 4.5 `ontology` — Schema Management

Required scope: `ontology:read` (list, get, validate, diff, migration-status, export) or `ontology:write` (create, update, delete, migrate, migration-rollback, import).

---

**`op ontology list`**

Maps to: `GET /api/v1/ontology/entities`

Table columns: `Entity Type`, `Version`, `Fields`, `Last Updated`.

---

**`op ontology get <entity-type>`**

Maps to: `GET /api/v1/ontology/entities/{entityType}`

Full schema JSON/YAML output.

---

**`op ontology create --file <schema.json>`**

Maps to: `POST /api/v1/ontology/entities`

Reads a JSON schema file and posts it. The file format matches the API request body.

---

**`op ontology update <entity-type> --file <schema.json>`**

Maps to: `PUT /api/v1/ontology/entities/{entityType}`

---

**`op ontology delete <entity-type> [--confirm]`**

Maps to: `DELETE /api/v1/ontology/entities/{entityType}`

Requires confirmation prompt. `--confirm` flag is an alias for `--yes` on this subcommand for scripting clarity.

---

**`op ontology validate --file <schema.json>`**

Maps to: `POST /api/v1/ontology/validate`

Validates locally and against the API (checks for dependency conflicts). Prints validation errors to stderr. Exit code 1 on failure, 0 on success.

---

**`op ontology diff <entity-type> --file <schema.json>`**

Maps to: `POST /api/v1/ontology/entities/{entityType}/diff`

Sends the proposed schema; the API returns a structured diff. Output format mirrors `kubectl diff` — `+` for additions, `-` for removals, `~` for modifications.

---

**`op ontology migrate <entity-type> [--wait] [--timeout 300s]`**

Maps to: `POST /api/v1/ontology/entities/{entityType}/migrate`

Flags:
- `--wait`: poll migration status until completion (default: false, returns migration ID)
- `--timeout`: max wait duration when `--wait` is set

With `--wait`, prints progress updates:

```
Migration mig_01HX... started (12,450 rows to migrate)
Progress: 6,225 / 12,450 (50%)
Migration complete in 14.2s
```

---

**`op ontology migration-status <migration-id>`**

Maps to: `GET /api/v1/ontology/migrations/{migrationId}`

---

**`op ontology migration-rollback <migration-id>`**

Maps to: `POST /api/v1/ontology/migrations/{migrationId}/rollback`

Prompts for confirmation unless `--yes`.

---

**`op ontology export [--format yaml|json] [--out <path>]`**

Maps to: `GET /api/v1/ontology/export`

Flags:
- `--format`: output format (default `yaml`)
- `--out`: write to file instead of stdout

---

**`op ontology import --file <path> [--on-conflict fail|skip|overwrite]`**

Maps to: `POST /api/v1/ontology/import`

Reads YAML or JSON schema export file and imports all entities. See section 9 for conflict resolution modes.

### 4.6 `data` — Data CRUD

Required scope: `data:read` (query, get, export) or `data:write` (create, update, delete, import).

---

**`op data query <entity-type> [--filter <json>] [--sort <field>] [--sort-dir asc|desc] [--limit N] [--offset N]`**

Maps to: `GET /api/v1/data/{entityType}`

Query params: `filter` (JSON string), `sort`, `sortDir`, `limit`, `offset`.

`--filter` accepts a JSON object string: `'{"status": "active", "price": {"gt": 100}}'`

JSONL output by default when piped.

---

**`op data get <entity-type> <id>`**

Maps to: `GET /api/v1/data/{entityType}/{id}`

---

**`op data create <entity-type> --file <data.json>`**

Maps to: `POST /api/v1/data/{entityType}`

Reads JSON from file or stdin (`--file -` for stdin).

---

**`op data update <entity-type> <id> --file <data.json>`**

Maps to: `PATCH /api/v1/data/{entityType}/{id}`

Partial update; only fields present in the JSON file are modified.

---

**`op data delete <entity-type> <id>`**

Maps to: `DELETE /api/v1/data/{entityType}/{id}`

Prompts for confirmation unless `--yes`.

---

**`op data import <entity-type> --file <path> [--format csv|json|jsonl] [--batch-size N] [--dry-run]`**

Maps to: `POST /api/v1/data/{entityType}/import` (streaming upload)

Flags:
- `--format`: auto-detected from file extension if omitted
- `--batch-size`: records per batch API call (default 500)
- `--dry-run`: validate and report counts, no writes

Progress output:

```
Importing Product records from products.csv
1,000 / 5,432 records (18%) ...
Import complete: 5,430 created, 2 skipped (validation errors)
```

---

**`op data export <entity-type> [--filter <json>] [--format csv|json|jsonl] [--out <path>]`**

Maps to: `GET /api/v1/data/{entityType}/export`

Streams response to stdout or file.

### 4.7 `connector` — Data Connector Management

Required scope: `pipelines:manage`

---

**`op connector list [--plugin <plugin-id>] [--status active|paused|error]`**

Maps to: `GET /api/v1/connectors`

Table columns: `ID`, `Name`, `Plugin`, `Status`, `Last Run`, `Next Run`.

---

**`op connector create --plugin <plugin-id> --name <name> --config <config.json> [--interactive]`**

Maps to: `POST /api/v1/connectors`

Flags:
- `--plugin` (required): plugin ID of the connector plugin
- `--name` (required): connector display name
- `--config`: path to JSON configuration file. If omitted and `--interactive` is set, launches inquirer prompts generated from the plugin's config schema (fetched from `GET /api/v1/plugins/{id}/config-schema`).
- `--interactive`: use interactive prompts for configuration

---

**`op connector get <id>`**

Maps to: `GET /api/v1/connectors/{id}`

Credentials are masked in output (shown as `[encrypted]`).

---

**`op connector update <id> [--name <name>] [--config <config.json>]`**

Maps to: `PATCH /api/v1/connectors/{id}`

---

**`op connector delete <id>`**

Maps to: `DELETE /api/v1/connectors/{id}`

Prompts for confirmation unless `--yes`.

---

**`op connector test <id>`**

Maps to: `POST /api/v1/connectors/{id}/test`

Runs the connector's `testConnection()` method. Prints success/failure and latency. Exit code 1 on connection failure.

---

**`op connector trigger <id> [--wait]`**

Maps to: `POST /api/v1/connectors/{id}/trigger`

With `--wait`: polls job status until completion, prints progress.

### 4.8 `webhook-out` — Outbound Webhook Management

Required scope: `admin` or service-level API key.

---

**`op webhook-out list`**

Maps to: `GET /api/v1/webhooks/outbound`

Table columns: `ID`, `URL`, `Events`, `Status`, `Deliveries (24h)`, `Failures (24h)`.

---

**`op webhook-out create --url <url> --events <event,...> [--secret <secret>] [--description <text>]`**

Maps to: `POST /api/v1/webhooks/outbound`

Flags:
- `--url` (required): HTTPS endpoint URL
- `--events` (required): comma-separated event types from the event catalog
- `--secret`: HMAC signing secret; if omitted, one is generated and printed once
- `--description`: optional human label

If `--secret` is omitted, the generated secret is printed with a one-time-display warning.

---

**`op webhook-out update <id> [--url <url>] [--events <event,...>] [--enabled true|false]`**

Maps to: `PATCH /api/v1/webhooks/outbound/{id}`

---

**`op webhook-out delete <id>`**

Maps to: `DELETE /api/v1/webhooks/outbound/{id}`

Prompts for confirmation unless `--yes`.

---

**`op webhook-out test <id> [--event-type <type>]`**

Maps to: `POST /api/v1/webhooks/outbound/{id}/test`

Sends a synthetic test payload. Prints the response status and latency. Exit code 1 on non-2xx response from target.

---

**`op webhook-out logs <id> [--limit N] [--status delivered|failed|pending]`**

Maps to: `GET /api/v1/webhooks/outbound/{id}/deliveries`

Table columns: `Delivery ID`, `Event Type`, `Status`, `Status Code`, `Latency`, `Timestamp`, `Retries`.

### 4.9 `pipeline` — Pipeline Management

Required scope: `pipelines:read` (list, get, runs, run-status, run-logs) or `pipelines:manage` (create, update, delete, trigger, run-cancel).

---

**`op pipeline list [--status active|paused|draft]`**

Maps to: `GET /api/v1/pipelines`

Table columns: `ID`, `Name`, `Status`, `Last Run`, `Last Run Status`.

---

**`op pipeline get <id>`**

Maps to: `GET /api/v1/pipelines/{id}`

---

**`op pipeline create --file <pipeline.yaml>`**

Maps to: `POST /api/v1/pipelines`

Reads a YAML pipeline definition file.

---

**`op pipeline update <id> --file <pipeline.yaml>`**

Maps to: `PUT /api/v1/pipelines/{id}`

---

**`op pipeline delete <id>`**

Maps to: `DELETE /api/v1/pipelines/{id}`

Prompts for confirmation unless `--yes`.

---

**`op pipeline trigger <id> [--input <json>] [--wait]`**

Maps to: `POST /api/v1/pipelines/{id}/trigger`

Flags:
- `--input`: JSON string of runtime input parameters
- `--wait`: poll until run completes, stream logs to stderr

With `--wait`, prints the run ID immediately to stdout (so `RUN_ID=$(op pipeline trigger my-pipeline --wait)` works correctly: the run ID is on stdout and progress is on stderr).

---

**`op pipeline runs <id> [--limit N] [--status running|completed|failed|cancelled]`**

Maps to: `GET /api/v1/pipelines/{id}/runs`

Table columns: `Run ID`, `Status`, `Triggered By`, `Started`, `Duration`, `Steps`.

---

**`op pipeline run-status <run-id>`**

Maps to: `GET /api/v1/pipeline-runs/{runId}`

---

**`op pipeline run-cancel <run-id>`**

Maps to: `POST /api/v1/pipeline-runs/{runId}/cancel`

Prompts for confirmation unless `--yes`.

---

**`op pipeline run-logs <run-id> [--follow] [--step <step-id>] [--level debug|info|warn|error]`**

Maps to: `GET /api/v1/pipeline-runs/{runId}/logs` (paginated) or SSE stream when `--follow`

Flags:
- `--follow` / `-f`: stream live logs via SSE until run completes or Ctrl+C
- `--step`: filter to a specific step ID
- `--level`: minimum log level to show

### 4.10 `schedule` — Cron Schedule Management

Required scope: `pipelines:manage`

---

**`op schedule list [--pipeline <id>] [--status active|paused]`**

Maps to: `GET /api/v1/schedules`

Table columns: `ID`, `Name`, `Pipeline`, `Cron`, `Status`, `Next Run`, `Last Run`.

---

**`op schedule create --pipeline <id> --cron <expr> [--name <name>] [--timezone <tz>]`**

Maps to: `POST /api/v1/schedules`

Flags:
- `--pipeline` (required): pipeline ID
- `--cron` (required): standard 5-field cron expression
- `--name`: display name; defaults to `{pipelineName}-schedule`
- `--timezone`: IANA timezone string, e.g. `America/New_York`; default `UTC`

The CLI validates the cron expression locally before sending.

---

**`op schedule pause <id>`**

Maps to: `POST /api/v1/schedules/{id}/pause`

---

**`op schedule resume <id>`**

Maps to: `POST /api/v1/schedules/{id}/resume`

---

**`op schedule delete <id>`**

Maps to: `DELETE /api/v1/schedules/{id}`

Prompts for confirmation unless `--yes`.

### 4.11 `dlq` — Dead-Letter Queue Management

Required scope: `admin`

---

**`op dlq list [--queue <queue-name>] [--limit N] [--from <date>] [--to <date>]`**

Maps to: `GET /api/v1/admin/dlq`

Query params: `queue`, `limit`, `from`, `to`.

Table columns: `Job ID`, `Queue`, `Failure Reason`, `Attempts`, `Failed At`, `Payload Preview`.

---

**`op dlq replay <job-id> [--queue <queue-name>]`**

Maps to: `POST /api/v1/admin/dlq/{jobId}/replay`

Moves the job back to its origin queue for re-processing. Prints the new job ID.

---

**`op dlq discard <job-id>`**

Maps to: `DELETE /api/v1/admin/dlq/{jobId}`

Permanently removes the job from the DLQ. Prompts for confirmation unless `--yes`.

### 4.12 `exec` — Direct Code Execution

Required scope: `execution:run`

---

**`op exec run --lang js|ts|python --file <code-file> [--input <json>] [--timeout <ms>] [--wait]`**

Maps to: `POST /api/v1/exec`

Flags:
- `--lang` (required): execution language
- `--file` (required): path to source file
- `--input`: JSON string passed as the execution input
- `--timeout`: execution timeout in milliseconds; default 30000
- `--wait`: wait for completion and stream output (default: true)

Output is streamed to stdout. Execution metadata (execution ID, duration) printed to stderr.

---

**`op exec history [--limit N] [--lang <lang>] [--from <date>] [--to <date>]`**

Maps to: `GET /api/v1/exec/history`

Table columns: `Execution ID`, `Language`, `Status`, `Duration`, `Started`, `Exit Code`.

---

**`op exec logs <execution-id>`**

Maps to: `GET /api/v1/exec/{executionId}/logs`

### 4.13 `app` — App Management

Required scope: `apps:read` (list, get, logs, env-list) or `apps:deploy` (create, deploy, delete, env-set, rollback) or `apps:dev` (dev).

---

**`op app list [--status draft|building|deployed|failed]`**

Maps to: `GET /api/v1/apps`

Table columns: `Slug`, `Name`, `Status`, `Version`, `Access Mode`, `Last Deployed`.

---

**`op app get <slug>`**

Maps to: `GET /api/v1/apps/{slug}`

---

**`op app create --name <name> [--template <template>] [--slug <slug>]`**

Maps to: `POST /api/v1/apps`

Flags:
- `--name` (required): display name
- `--template`: starter template name (fetched from `GET /api/v1/apps/templates`)
- `--slug`: URL slug; auto-derived from name if omitted

---

**`op app deploy <slug> [--file <bundle-path>] [--env production|preview] [--wait]`**

Maps to: `POST /api/v1/apps/{slug}/deploy`

Flags:
- `--file`: local bundle path; if omitted, triggers a build from the VFS current state
- `--env`: deployment environment
- `--wait`: poll build until complete, stream build logs to stderr

---

**`op app dev <slug> [--port <n>] [--prefer-local] [--prefer-remote]`**

Starts a local development server against the live platform.

Implementation (see `src/commands/app/dev.ts`):
1. Calls `POST /api/v1/apps/{slug}/dev-session` to register the dev redirect URI at `http://localhost:{port}/auth/callback`.
2. Starts a local HTTP server on `--port` (default 3100).
3. Opens a bidirectional file sync loop via `src/lib/file-sync.ts`:
   - Local changes: debounced `PUT /api/v1/apps/{slug}/files/{path}` on file write.
   - Remote changes: SSE stream `GET /api/v1/apps/{slug}/files/events` for remote updates.
   - Conflict resolution: prompts user, or uses `--prefer-local` / `--prefer-remote` for non-interactive mode.
4. On SIGINT or SIGTERM: calls `DELETE /api/v1/apps/{slug}/dev-session` to clean up the dev redirect URI.

Dev redirect URIs have a 24-hour TTL on the server as a safety net for unclean shutdowns.

---

**`op app logs <slug> [--follow] [--from <date>] [--level debug|info|warn|error]`**

Maps to: `GET /api/v1/apps/{slug}/logs` (paginated) or SSE when `--follow`.

---

**`op app delete <slug>`**

Maps to: `DELETE /api/v1/apps/{slug}`

Prompts for confirmation unless `--yes`.

---

**`op app env-set <slug> <key> <value>`**

Maps to: `PUT /api/v1/apps/{slug}/env/{key}`

Value is encrypted at rest server-side. The CLI never stores the value locally.

---

**`op app env-list <slug>`**

Maps to: `GET /api/v1/apps/{slug}/env`

Key names are returned; values are masked as `[encrypted]`.

---

**`op app rollback <slug> [--to <version>]`**

Maps to: `POST /api/v1/apps/{slug}/rollback`

Flags:
- `--to`: version number to roll back to; if omitted, rolls back to the previous version

Prompts for confirmation unless `--yes`. Prints the version being activated.

### 4.14 `plugin` — Plugin Management

Required scope: `plugins:manage` for all admin operations; `plugins:read` for list and info.

---

**`op plugin list [--type connector|transformer|destination|auth-provider|widget] [--status enabled|disabled|installed]`**

Maps to: `GET /api/v1/plugins`

Table columns: `ID`, `Name`, `Type`, `Version`, `Status`, `Publisher`, `Installed`.

---

**`op plugin install <source> [--tenant <id>] [--yes]`**

Maps to: `POST /api/v1/plugins` (multipart upload)

`<source>` accepts:
- Local file path to a `.oppkg` file
- HTTPS URL to a `.oppkg` file (downloaded by the CLI before upload)
- `{publisher}/{name}@{version}` registry reference (future, reserved)

The install flow:
1. If URL: download `.oppkg` to a temp file, verify SHA-256 against the `.oppkg` manifest's `checksum` field.
2. Upload via multipart to `POST /api/v1/plugins`.
3. API returns an approval prompt listing permissions, external URLs, and APIs the plugin requires.
4. CLI renders the approval prompt. `--yes` auto-approves with a warning logged to audit.
5. On approval: API returns the installed plugin's ID and version.

---

**`op plugin enable <plugin-id> [--tenant <id>]`**

Maps to: `POST /api/v1/plugins/{pluginId}/enable`

---

**`op plugin disable <plugin-id> [--tenant <id>]`**

Maps to: `POST /api/v1/plugins/{pluginId}/disable`

---

**`op plugin uninstall <plugin-id>`**

Maps to: `DELETE /api/v1/plugins/{pluginId}`

Performs pre-uninstall checks: warns if active connectors, pipelines, or apps depend on the plugin. Requires `--yes` to proceed despite warnings. Prompts for confirmation unless `--yes`.

---

**`op plugin info <plugin-id>`**

Maps to: `GET /api/v1/plugins/{pluginId}`

Prints: manifest contents, installed version, hook declarations, config schema, dependency list.

---

**`op plugin create`**

Interactive scaffold for a new plugin project. No API call; purely local.

Prompts (via inquirer.js):
1. Plugin name (kebab-case, validated)
2. Publisher identifier
3. Plugin type: `connector`, `transformer`, `destination`, `auth-provider`, `widget`
4. Output directory (default: `./{name}`)

Generates a starter TypeScript project using the `@oneplatform/plugin-sdk` template. The scaffold produces:
- `package.json` with `@oneplatform/plugin-sdk` dependency
- `src/index.ts` implementing the correct interface from plugin-sdk
- `manifest.json` with metadata fields
- `tsconfig.json`
- `op-plugin.config.ts` for `op plugin pack` settings

---

**`op plugin pack [--out <path>] [--sign <gpg-key-id>]`**

Packages the current directory's plugin project into a `.oppkg` file.

No API call; purely local. Steps:
1. Validates `manifest.json` schema.
2. Runs `bun build` to produce the plugin bundle.
3. Computes SHA-256 of the bundle.
4. Writes `{name}-{version}.oppkg` (ZIP containing `manifest.json`, `bundle.js`, `checksum.sha256`).
5. If `--sign`: GPG-signs the `.oppkg` and appends `.sig` file.

---

**`op plugin validate <path-to.oppkg>`**

Validates the `.oppkg` file structure and manifest schema. Also calls `POST /api/v1/plugins/validate` for server-side validation (permission checks, sandbox compatibility). Exit code 0 on valid, 1 on any error.

---

**`op plugin simulate-hook <stage> --plugin <plugin-id> --input <data.json> [--timeout <ms>]`**

Maps to: `POST /api/v1/plugins/{pluginId}/simulate`

Runs the plugin's hook for `<stage>` with the provided input data in a server-side sandbox. Streams execution output and prints the result. Useful for testing plugin logic against real platform data without a full pipeline run.

`<stage>` values: `pull`, `transform`, `push`, `authenticate`, `render`.

### 4.15 `logs` — Log Management

Required scope: `admin` for all logs; scoped service access for `logs:read:{service}`.

---

**`op logs query [--service <name>] [--level debug|info|warn|error] [--from <date>] [--to <date>] [--trace-id <id>] [--limit N]`**

Maps to: `GET /api/v1/logs`

All flags are optional. Defaults: last 15 minutes, all services, `info` level and above.

JSONL output by default when piped for easy `jq` processing.

---

**`op logs tail [--service <name>] [--level <level>] [--trace-id <id>]`**

Maps to: SSE stream `GET /api/v1/logs/stream`

Prints logs in a human-readable format to stdout until Ctrl+C. Color-codes by level when TTY:
- `DEBUG`: grey
- `INFO`: white
- `WARN`: yellow
- `ERROR`: red

---

**`op logs audit [--from <date>] [--to <date>] [--actor <user-id>] [--action <action>] [--resource <resource>]`**

Maps to: `GET /api/v1/logs/audit`

Query params: `from`, `to`, `actorId`, `action`, `resourceType`, `resourceId`.

Table columns: `Timestamp`, `Actor`, `Action`, `Resource`, `IP`, `Result`.

---

**`op logs export --from <date> --to <date> [--service <name>] [--format jsonl|csv] [--out <path>]`**

Maps to: `GET /api/v1/logs/export` (streaming download)

`--from` and `--to` are required. Streams to stdout or file.

### 4.16 `config` — Platform Configuration Export and Import

Required scope: `admin`

See section 9 for full implementation details of the YAML format, topological ordering, and conflict resolution.

---

**`op config export [--format yaml|json] [--include-credentials --passphrase <pass>] [--out <path>] [--kinds Role,Ontology,...]`**

Maps to: `GET /api/v1/admin/config/export`

Flags:
- `--format`: output format (default `yaml`)
- `--include-credentials`: export encrypted credential values (requires `--passphrase`)
- `--passphrase`: passphrase for AES-256-GCM encryption of credential values
- `--out`: file path; defaults to stdout
- `--kinds`: comma-separated list of resource kinds to export; defaults to all

Default: credentials excluded, only credential key names are exported.

---

**`op config import --file <path> [--on-conflict fail|skip|overwrite|merge] [--dry-run] [--passphrase <pass>]`**

Maps to: `POST /api/v1/admin/config/import`

Flags:
- `--file` (required): path to YAML or JSON config export file
- `--on-conflict`: conflict resolution mode (default `fail`)
- `--dry-run`: full import process with dependency resolution and conflict detection, no writes
- `--passphrase`: required if the export file contains encrypted credentials

Dry-run output mirrors `kubectl diff`:

```
+ Role: data-analyst (create)
  Ontology:Product (no change)
~ Ontology:Order (update — 2 fields added)
+ Pipeline:sync-orders (create)
  App:order-dashboard (no change)
```

---

**`op config diff --file <path>`**

Identical to `op config import --dry-run`. Exists as an alias for discoverability — it is the most common pre-import workflow.

---

**`op config validate --file <path>`**

Validates the config file structure, `kind` values, required fields, and internal references (e.g., pipeline references an existing connector). No API call for pure schema validation; calls `POST /api/v1/admin/config/validate` for cross-reference checks that require platform state.

Exit code 0 on valid, 1 on any error. Prints all errors, not just the first.

### 4.17 `status` — Platform Health

No scope required for basic status; `admin` for detailed service internals.

---

**`op status [--watch] [--interval <seconds>]`**

Maps to: `GET /api/v1/health` (public) and `GET /api/v1/admin/health/detailed` (admin-scoped)

Flags:
- `--watch`: refresh in place every `--interval` seconds until Ctrl+C
- `--interval`: refresh interval in seconds (default 5)

Output in TTY mode:

```
OnePlatform v1.2.3  —  https://platform.example.com

Services
  gateway         healthy  (42ms)
  auth            healthy  (8ms)
  ontology        healthy  (12ms)
  ingestion       healthy  (15ms)
  pipeline        healthy  (9ms)
  execution       healthy  (11ms)
  app             healthy  (18ms)
  plugin          healthy  (7ms)
  logging         healthy  (10ms)

Infrastructure
  postgres        healthy
  redis           healthy
  minio           healthy

Last checked: 2026-06-10T14:30:00Z
```

Degraded services are printed in yellow; unhealthy in red. Exit code 1 if any service is unhealthy.

### 4.18 `service` — Service Administration

Required scope: `admin`

---

**`op service rotate-keys [--service <name>] [--overlap <duration>]`**

Maps to: `POST /api/v1/admin/services/rotate-keys`

Flags:
- `--service`: specific service name; if omitted, rotates all inter-service signing keys
- `--overlap`: overlap period during which both old and new keys are accepted (default `5m`)

Implements ADR-19's key rotation: generates a new Ed25519 keypair, publishes the new public key, gracefully restarts the service. All other services accept both old and new public keys for the overlap duration.

Requires explicit `--yes` or interactive confirmation with the service name typed.

---

**`op service health`**

Maps to: `GET /api/v1/admin/health/detailed`

Prints detailed health: response times per endpoint, queue depths (BullMQ job counts per queue), Redis memory usage, Postgres connection pool usage, recent error rates.

### 4.19 `sdk` — SDK Code Generation

No scope required (uses the caller's auth to fetch their tenant's OpenAPI spec).

---

**`op sdk generate [--out <path>] [--lang typescript|python|go]`**

Generates an ontology-typed SDK client for the current tenant.

Steps:
1. Fetch `GET /api/v1/openapi.json` (tenant-specific, includes auto-generated entity routes).
2. Run `@hey-api/openapi-ts` against the downloaded spec.
3. Write output to `--out` (default: `./oneplatform.gen.ts` for TypeScript).

Flags:
- `--out`: output file path
- `--lang`: target language (default `typescript`; `python` and `go` reserved for future versions)

### 4.20 `version`

No scope required. No authentication required.

---

**`op version`**

Prints:

```
op v1.2.3
Platform: v1.2.3 (API v1)
Build: bun/1.1.20 linux/amd64
```

Fetches platform version from `GET /api/v1/version` if credentials are available; falls back to "unknown" if not authenticated.

### 4.21 `completion` — Shell Completion

---

**`op completion bash`**

Prints the bash completion script to stdout. Users add it to `.bashrc`:

```bash
source <(op completion bash)
```

---

**`op completion zsh`**

Prints the zsh completion script. Users add it to `.zshrc`:

```zsh
source <(op completion zsh)
```

---

**`op completion fish`**

Prints the fish completion script. Users save it to `~/.config/fish/completions/op.fish`.

All completion scripts are generated from Commander.js command definitions at build time (not at runtime) using `@commander-js/extra-typings` completion generation. The generated scripts are embedded as string constants in the completion command handlers.

---

## 5. Credential Storage

### 5.1 File Layout

```
~/.config/oneplatform/
├── config.json                    <- activeProfile pointer
│   { "activeProfile": "default" }
├── credentials.json               <- encrypted per-profile credentials (mode 600)
└── profiles/
    ├── default.json               <- profile metadata
    └── production.json
```

`credentials.json` format:

```json
{
  "default": {
    "platformUrl": "https://platform.example.com",
    "apiKey": "encrypted:AES256GCM:base64ciphertext",
    "keyDerivation": "keychain",
    "encryptedAt": "2026-06-10T14:00:00Z"
  },
  "staging": {
    "platformUrl": "https://staging.example.com",
    "apiKey": "encrypted:AES256GCM:base64ciphertext",
    "keyDerivation": "machine-id",
    "encryptedAt": "2026-06-10T14:00:00Z"
  }
}
```

`keyDerivation` values: `"keychain"` (keytar primary), `"machine-id"` (HKDF fallback).

### 5.2 Encryption Strategy

Three-tier strategy, evaluated in order:

**Tier 1 — System keychain (primary)**

keytar (MIT) bridges to the OS credential store:
- macOS: Keychain (Security framework)
- Linux: GNOME Keyring / libsecret
- Windows: Windows Credential Manager

The AES-256-GCM encryption key for `credentials.json` is stored in the OS keychain under the service name `oneplatform-cli` with account name equal to the profile name. The `credentials.json` file stores only the AES-256-GCM ciphertext — the encryption key never touches disk.

Encryption:
```
IV = crypto.randomBytes(12)
key = keytar.getPassword("oneplatform-cli", profileName)  // 32-byte key from keychain
ciphertext = AES-256-GCM(key, IV, plaintext)
stored = "encrypted:AES256GCM:" + base64(IV + ciphertext + authTag)
```

**Tier 2 — Machine-derived key (fallback)**

Used when `keytar` is unavailable (headless servers, minimal CI images, Docker containers without D-Bus). The machine-derived key is computed as:

```
machineId = readFile("/etc/machine-id")           // Linux
          | ioreg IOPlatformUUID                   // macOS
          | registry MachineGuid                   // Windows
key = HKDF-SHA256(ikm=machineId, salt="oneplatform-cli-v1", info="credential-key", length=32)
```

On first credential write in fallback mode, the CLI prints to stderr:

```
WARNING: Credentials stored with machine-derived key (keytar not available).
Moving credentials.json to a different machine will make credentials unrecoverable.
For better security, install libsecret (Linux) to enable system keychain storage.
```

**Tier 3 — Environment variable override**

`OP_API_KEY` and `OP_PLATFORM_URL` bypass `credentials.json` entirely. The credential file is not read or written when both are set. This is the recommended CI mode.

```bash
export OP_API_KEY="op_live_..."
export OP_PLATFORM_URL="https://platform.example.com"
op pipeline trigger my-pipeline
```

### 5.3 File Permission Enforcement

On every CLI startup, `src/lib/credentials.ts` checks the mode of `credentials.json`. If permissions are more permissive than `600` (e.g., world-readable), the CLI prints a warning to stderr but does not block operation. The warning includes the command to fix it:

```
WARNING: credentials.json has insecure permissions (644).
Fix with: chmod 600 ~/.config/oneplatform/credentials.json
```

On credential file creation, permissions are set to `600` via `fs.chmodSync`.

### 5.4 keytar Availability Detection

keytar requires native bindings. In the compiled Bun binary, keytar is bundled via the Bun FFI layer. Availability is checked at runtime:

```typescript
async function isKeytarAvailable(): Promise<boolean> {
  try {
    await import("keytar");
    return true;
  } catch {
    return false;   // native binding unavailable
  }
}
```

The detection result is cached for the process lifetime.

---

## 6. Profile System

### 6.1 Profile File Schema

`~/.config/oneplatform/profiles/{name}.json`:

```typescript
interface Profile {
  name: string;
  platformUrl: string;
  tenantId?: string;           // cached from last login; used for display only
  defaultOutput?: "json" | "table" | "tsv";
  timeout?: number;            // HTTP timeout in ms; default 30000
  insecureTls?: boolean;       // allow self-signed certs; default false
}
```

### 6.2 Precedence Rules

For any configuration value, resolution order (highest priority first):

1. Command-line flag (e.g., `--platform`, `--output`, `--timeout`)
2. Environment variable (`OP_PLATFORM_URL`, `OP_API_KEY`, `OP_OUTPUT`, `OP_TIMEOUT`, `OP_PROFILE`)
3. Active profile configuration (`~/.config/oneplatform/profiles/{activeProfile}.json`)
4. Built-in defaults

The `preAction` hook in `src/lib/context.ts` resolves all values before any command action runs:

```typescript
async function globalPreActionHook(thisCommand: Command, actionCommand: Command): Promise<void> {
  const profileName = thisCommand.opts().profile
    ?? process.env.OP_PROFILE
    ?? readActiveProfile();
  const profile = loadProfile(profileName);
  const creds = await loadCredentials(profileName);
  const ctx: CommandContext = {
    config: resolveConfig(thisCommand.opts(), process.env, profile),
    credentials: creds,
    output: resolveOutputFormat(thisCommand.opts(), process.env, profile),
    http: createHttpClient(ctx.config, ctx.credentials),
  };
  actionCommand.setOptionValueWithSource("_ctx", ctx, "env");
}
```

### 6.3 `CommandContext` Type

```typescript
interface CommandContext {
  config: {
    platformUrl: string;
    timeout: number;
    insecureTls: boolean;
    verbose: boolean;
  };
  credentials: {
    apiKey: string | null;    // null when not authenticated
    source: "keychain" | "machine-id" | "env" | "none";
  };
  output: OutputFormat;       // "table" | "json" | "jsonl" | "tsv"
  quiet: boolean;
  noColor: boolean;
  yes: boolean;
  http: HttpClient;
}
```

---

## 7. Output Formatting

### 7.1 Format Selection

| Condition | Default format |
|---|---|
| stdout is a TTY | `table` |
| stdout is a pipe | `json` for single-object commands; `jsonl` for list commands |
| `--output json` | `json` (all commands) |
| `--output table` | `table` (all commands) |
| `--output tsv` | `tsv` (all commands) |
| `--quiet` | no stdout output, only exit code |

Detection: `process.stdout.isTTY === true` for TTY detection. The `NO_COLOR` environment variable (standard convention) and `--no-color` flag both disable ANSI codes.

### 7.2 Table Format

- Header row in uppercase, separated from data by a line of `─` characters.
- Columns auto-sized to the widest value, capped at 60 characters.
- Values longer than 60 characters are truncated with `...` suffix.
- ANSI color: status values color-coded (green=healthy/completed, yellow=warning/paused, red=error/failed).
- Rendered via a table library (`cli-table3`, MIT) — handles unicode column width correctly.

Example:

```
ID              NAME              STATUS     LAST RUN
─────────────── ───────────────── ────────── ──────────────────────
pip_01HX3A...   sync-products     active     2026-06-10T14:00:00Z
pip_01HX3B...   process-orders    paused     2026-06-10T08:30:00Z
```

### 7.3 JSON Format

Standard compact JSON. Single resource: one JSON object. List: a JSON array.

```json
[
  {"id": "pip_01HX3A...", "name": "sync-products", "status": "active"},
  {"id": "pip_01HX3B...", "name": "process-orders", "status": "paused"}
]
```

### 7.4 JSONL Format

For list commands when piped (auto) or when `--output jsonl`. One JSON object per line, no trailing newline. Streaming-friendly for `jq` and `awk` processing.

```
{"id": "pip_01HX3A...", "name": "sync-products", "status": "active"}
{"id": "pip_01HX3B...", "name": "process-orders", "status": "paused"}
```

### 7.5 TSV Format

Tab-separated, no header row. Column order matches the table column order.

```
pip_01HX3A...	sync-products	active	2026-06-10T14:00:00Z
pip_01HX3B...	process-orders	paused	2026-06-10T08:30:00Z
```

### 7.6 Output Module

All rendering is encapsulated in `src/lib/output.ts`:

```typescript
interface OutputRenderer {
  table(columns: ColumnDef[], rows: Record<string, unknown>[]): void;
  json(data: unknown): void;
  jsonl(data: unknown[]): void;
  tsv(columns: ColumnDef[], rows: Record<string, unknown>[]): void;
  render(data: unknown | unknown[], columns?: ColumnDef[]): void;
  error(message: string): void;   // always to stderr
  warn(message: string): void;    // always to stderr
  info(message: string): void;    // stderr in quiet mode, stdout otherwise
  success(message: string): void; // suppressed in quiet mode
}
```

`render()` is the standard entry point. It dispatches to the correct format based on the context's `output` field and whether `data` is an array or single object.

---

## 8. HTTP Client

### 8.1 Wrapper Layer

`src/lib/http-client.ts` wraps `@oneplatform/sdk`. The CLI does not make raw `fetch` calls — it always goes through the SDK client. This ensures consistent auth injection, retry logic, and error classification.

```typescript
interface HttpClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
  postMultipart<T>(path: string, form: FormData): Promise<T>;
  stream(path: string, query?: Record<string, unknown>): AsyncIterable<string>;
}
```

`stream()` is used by `op logs tail`, `op pipeline run-logs --follow`, and `op app dev` to consume SSE streams.

### 8.2 Auth Injection

The HTTP client is constructed with the resolved credentials at context creation time. API key is sent as:

```
Authorization: Bearer op_live_{key}
```

The SDK's auth injection handles this automatically. The CLI never manually sets `Authorization` headers.

### 8.3 Retry Policy

Inherited from `@oneplatform/sdk` defaults:
- Retryable status codes: 429, 500, 502, 503, 504
- 3 retries, exponential backoff with jitter
- 429: respects `Retry-After` header (seconds or HTTP date)
- Non-retryable 4xx (400, 401, 403, 404, 409, 422): thrown immediately

CLI-specific additions on top of SDK retry:
- On 429 with `--quiet` suppressed, print to stderr: `Rate limited by server. Retrying in {N}s...`
- After 3 failed retries on 429: exit with code 2 (rate limit error)

### 8.4 Timeout

Configured per-context from `--timeout` flag, `OP_TIMEOUT` env var, or profile `timeout` field. Default 30,000 ms. Passed to the SDK client constructor.

On timeout: the CLI prints `Request timed out after {N}ms.` to stderr and exits with code 3.

### 8.5 TLS

The `insecureTls: true` profile field (and `--insecure-tls` flag) sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for the process. This is documented as a development-only option and prints a warning on every command invocation.

---

## 9. Config Export and Import

### 9.1 YAML Multi-Document Format

Config files use YAML multi-document format: multiple documents separated by `---`, each with a `kind` and `spec` field.

```yaml
kind: Role
spec:
  name: data-analyst
  permissions:
    - data:read
    - ontology:read
---
kind: Ontology
spec:
  name: Product
  version: 3
  fields:
    - { name: sku, type: string, required: true }
    - { name: price, type: number, required: true }
---
kind: Connector
spec:
  name: shopify-source
  plugin: com.example.shopify-connector
  config:
    shop: myshop.myshopify.com
    apiVersion: "2024-01"
---
kind: Pipeline
spec:
  name: sync-products
  trigger:
    type: schedule
    cron: "0 * * * *"
  steps:
    - { type: connector, connector: shopify-source }
---
kind: App
spec:
  name: product-dashboard
  accessMode: platform-user
---
kind: Webhook
spec:
  url: https://hooks.slack.com/services/...
  events: ["pipeline.failed", "ingestion.failed"]
```

Supported `kind` values: `Role`, `Ontology`, `Connector`, `Pipeline`, `App`, `Webhook`.

Resources are identified by a stable key: `{kind}:{spec.name}` (e.g., `Ontology:Product`). Internal database IDs never appear in config files.

### 9.2 Credential Handling in Exports

**Default (no credentials):** Connector config fields marked as credential type (`"secret": true` in the plugin's config schema) are exported as `[credential key name]` only. The actual values are excluded.

**With credentials:** `--include-credentials --passphrase <pass>` encrypts credential values using AES-256-GCM with a key derived from the passphrase via HKDF-SHA256. Encrypted values are stored as `"encrypted:{base64-ciphertext}"` in the `spec.config` fields.

**Import with encrypted credentials:** `--passphrase <pass>` is required. The CLI decrypts values before sending to the API.

**Import without passphrase (encrypted file):** Credential fields are imported as empty strings. A warning is printed for each affected resource. Administrators must re-enter credentials via `op connector update`.

### 9.3 Topological Ordering (Import)

Before any writes, `src/lib/config-document.ts` builds a dependency graph and topologically sorts it using Kahn's algorithm:

```
Dependency rules:
  Connector  →  Ontology (for schema mapping)
  Pipeline   →  Connector, Ontology
  App        →  Pipeline, Ontology
  Webhook    →  (no dependencies)
  Role       →  (no dependencies)
  Ontology   →  (no dependencies)

Import order (Kahn's topological sort):
  1. Role       (no dependencies)
  2. Ontology   (no dependencies)
  3. Connector  (depends on Ontology)
  4. Pipeline   (depends on Connector + Ontology)
  5. App        (depends on Pipeline + Ontology)
  6. Webhook    (no dependencies, listed last by convention)
```

Circular dependency detection: if Kahn's algorithm does not exhaust all nodes (i.e., remaining nodes have unsatisfied dependencies), a cycle exists. The CLI reports the full cycle path and exits before any writes:

```
Error: circular dependency detected in config file
Cycle: Pipeline:sync-orders -> Connector:orders-source -> Pipeline:sync-orders
Import aborted. No resources were written.
```

### 9.4 Conflict Resolution Modes

| Mode | Behaviour on existing resource | Use case |
|---|---|---|
| `fail` (default) | Abort import, report all conflicts before any writes | Safe default; review before committing |
| `skip` | Leave existing unchanged, continue with remaining | Idempotent re-run; `kind:spec.name` stable key makes this safe |
| `overwrite` | Replace existing resource completely (full PUT) | Declarative config push; replicate env to env |
| `merge` | Deep-merge spec fields (additive only; no field removals) | Additive migration; safe for partial updates |

`fail` mode collects all conflicts before exiting, not just the first:

```
Error: import conflicts detected (--on-conflict fail)
  Ontology:Product — already exists (version 3)
  Pipeline:sync-products — already exists
Run with --on-conflict skip|overwrite|merge to handle conflicts.
Import aborted. No resources were written.
```

### 9.5 Dry-Run

`--dry-run` performs the full import process — dependency resolution, circular dependency detection, conflict detection, schema validation — without any writes to the platform. Output mirrors `kubectl diff`:

```
+ Role:data-analyst          (create)
  Ontology:Product           (no change)
~ Ontology:Order             (update — 2 fields added)
+ Pipeline:sync-orders       (create)
  App:order-dashboard        (no change)

Summary: 2 to create, 1 to update, 2 unchanged.
Run without --dry-run to apply.
```

`op config diff --file <path>` is an alias for `op config import --file <path> --dry-run`. It exists as a separate discoverable command.

### 9.6 Idempotency

Importing the same config file twice with `--on-conflict skip` is a no-op. The stable key `{kind}:{spec.name}` ensures that re-running the same config is safe in all environments.

---

## 10. Interactive Prompts

### 10.1 inquirer.js

Interactive prompts use `inquirer` (MIT). Prompts are only displayed when:
- `process.stdin.isTTY === true` (interactive terminal)
- `--yes` flag is NOT set for confirmation prompts

If stdin is not a TTY and `--yes` is not set for a command that requires confirmation, the CLI prints to stderr:

```
This command requires confirmation. Run with --yes to confirm in non-interactive mode.
```

Then exits with code 1.

### 10.2 Destructive-Action Confirmation Pattern

Standard pattern for destructive operations (delete, deactivate, revoke, discard, rollback):

```typescript
async function confirmDestructive(
  message: string,
  ctx: CommandContext
): Promise<void> {
  if (ctx.yes) return;          // --yes bypasses, except emergency-rotate
  if (!process.stdin.isTTY) {
    throw new CliError(
      `${message}\nRun with --yes to confirm in non-interactive mode.`,
      1
    );
  }
  const { confirmed } = await inquirer.prompt([{
    type: "confirm",
    name: "confirmed",
    message,
    default: false,
  }]);
  if (!confirmed) {
    throw new CliError("Aborted.", 0);  // exit 0: user chose not to proceed
  }
}
```

`op auth emergency-rotate` is exempt from `--yes` bypass. It requires typing `ROTATE`:

```typescript
const { typed } = await inquirer.prompt([{
  type: "input",
  name: "typed",
  message: "This will invalidate ALL active sessions. Type ROTATE to confirm:",
}]);
if (typed !== "ROTATE") {
  throw new CliError("Aborted. You must type ROTATE to confirm.", 1);
}
```

### 10.3 Interactive Flows

Commands with complex interactive flows use inquirer step sequences:

**`op auth login` (interactive mode)**:
1. Prompt: Platform URL (skip if already in profile)
2. Prompt: Email
3. Prompt: Password (masked)
4. Call `POST /api/v1/auth/login`
5. Store API key from response
6. Print success

**`op plugin create`**:
1. Prompt: Plugin name (validated: lowercase kebab-case)
2. Prompt: Publisher (validated: reverse-domain, e.g. `com.example`)
3. Prompt: Plugin type (select: connector / transformer / destination / auth-provider / widget)
4. Prompt: Output directory (default `./{name}`)
5. Confirm scaffold

**`op connector create --interactive`**:
1. Fetch plugin's config schema from `GET /api/v1/plugins/{id}/config-schema`
2. Iterate over schema fields, generating appropriate inquirer question types (text, password for `"secret": true`, select for enum, number for numeric fields)
3. Assemble config object and post

---

## 11. Error Handling and Exit Codes

### 11.1 Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General error (validation failure, not found, user aborted, permission denied) |
| `2` | Rate limit exceeded (429 with max retries exhausted) |
| `3` | Network/timeout error |
| `4` | Authentication error (401: not logged in, token expired) |
| `5` | Authorization error (403: insufficient scope) |
| `6` | Server error (5xx, max retries exhausted) |
| `127` | Command not found (Commander.js default for unknown commands) |

### 11.2 CliError

All action handlers throw `CliError` (not `Error`) for user-facing failures:

```typescript
class CliError extends Error {
  constructor(
    public readonly message: string,
    public readonly exitCode: number = 1,
    public readonly cause?: Error
  ) {
    super(message);
  }
}
```

The `withContext` wrapper in `src/lib/context.ts` catches `CliError` and calls `process.exit(err.exitCode)`. Other uncaught errors exit with code 1.

### 11.3 Error Message Rules

All user-facing error messages:
- Start with a capital letter.
- Describe what went wrong, not how the code failed.
- Include a remediation hint where possible.
- Are written to stderr.
- Never include a stack trace unless `--verbose` is set.

Examples:

```
Error: Not authenticated. Run 'op auth login' to log in.
Error: Pipeline 'pip_01HX3A' not found.
Error: Insufficient permissions. This command requires the 'pipelines:manage' scope.
Error: Rate limit exceeded after 3 retries. Wait and try again.
Error: credentials.json not found. Run 'op auth login' to set up credentials.
```

With `--verbose`:

```
Error: Pipeline 'pip_01HX3A' not found.

Stack trace:
  NotFoundError: Resource not found
    at HttpClient.get (src/lib/http-client.ts:42)
    at getPipelineAction (src/commands/pipeline/get.ts:18)
    ...

HTTP request:
  GET https://platform.example.com/api/v1/pipelines/pip_01HX3A
  Status: 404 Not Found
  Response: {"error": {"code": "PIPELINE_NOT_FOUND", "message": "..."}}
```

### 11.4 API Error Translation

HTTP status codes are translated to user-facing messages:

| HTTP Status | Exit Code | Message Template |
|---|---|---|
| 400 | 1 | `Validation error: {field}: {message}` |
| 401 | 4 | `Not authenticated. Run 'op auth login' to log in.` |
| 403 | 5 | `Insufficient permissions. This command requires the '{scope}' scope.` |
| 404 | 1 | `{ResourceType} '{id}' not found.` |
| 409 | 1 | `Conflict: {message}` |
| 422 | 1 | `{message}` (server-provided validation message) |
| 429 | 2 | `Rate limit exceeded after {N} retries. Wait and try again.` |
| 500–504 | 6 | `Server error ({status}). Platform may be degraded. Try again.` |

The API error response body (`{ error: { code, message, details? } }`) is parsed and the `message` field is used in the CLI error output.

---

## 12. Security Design

### 12.1 Credential Security

- `credentials.json` is created with mode `600`. Mode checked on every startup.
- API keys are never logged, never printed (except at key generation time with a one-time warning).
- `--verbose` does not log API key values in HTTP request details; the `Authorization` header is masked as `Bearer op_live_[redacted]`.
- Sensitive flag values (`--passphrase`, `--secret`) are masked in shell history by accepting them via prompt when omitted, reducing accidental exposure through `~/.bash_history`.
- `credentials.json` is excluded from backup suggestions and `.gitignore` templates.

### 12.2 Passphrase Handling

`op config export --include-credentials --passphrase` and `op config import --passphrase` accept the passphrase via flag. If the flag is omitted, the CLI prompts interactively (masked input). The passphrase value is zero-filled from memory after the cryptographic operation:

```typescript
// Passphrase is a Buffer, zero-filled after use
const key = hkdf("sha256", passphrase, salt, "oneplatform-config-v1", 32);
passphrase.fill(0);
```

### 12.3 TLS Verification

TLS verification is on by default. `--insecure-tls` (or profile field `insecureTls: true`) is the only mechanism to disable it and prints a warning on every invocation:

```
WARNING: TLS certificate verification is disabled (--insecure-tls). Do not use in production.
```

### 12.4 Scope Enforcement

Scope requirements documented in section 4 are enforced server-side. The CLI does not perform client-side scope checks — the API returns a 403 with a clear scope requirement, which the CLI translates to a user-friendly message (section 11.4).

### 12.5 Secrets in Environment Variables

`OP_API_KEY` is read from the environment but never echoed to stdout. If `--verbose` is enabled, it is printed as `OP_API_KEY=[set]` in the configuration dump, not its value.

---

## 13. Observability

### 13.1 Documentation Generation

`src/lib/docs-generator.ts` generates a man-page-style Markdown reference from Commander.js command definitions. This is the source of `/docs/cli` in the platform UI (ADR-23).

The generator:
1. Iterates all registered commands depth-first.
2. Extracts: command name, description, arguments, options, examples (from `.addHelpText("after", ...)` blocks).
3. Renders as structured Markdown.
4. Run via `turbo run docs:generate` in CI.

### 13.2 Verbose Mode

`--verbose` adds to stderr:
- Full HTTP request/response (URL, method, status, response body truncated to 2000 chars).
- Configuration resolution trace (which source provided each value: flag, env var, profile, default).
- Stack traces on errors.
- Credential source (keychain, machine-id, env var) without value.

### 13.3 Exit Code in CI

Every command exits with a well-defined code from section 11.1. CI scripts should check `$?` rather than parsing output. This is documented in the CI guide.

---

## 14. Distribution

### 14.1 Standalone Binaries

Built via Bun's `--compile` flag (no Node.js runtime required):

```bash
# scripts/build-binaries.sh
bun build --compile --target bun-linux-x64     src/index.ts --outfile dist/op-linux-amd64
bun build --compile --target bun-linux-arm64   src/index.ts --outfile dist/op-linux-arm64
bun build --compile --target bun-darwin-arm64  src/index.ts --outfile dist/op-darwin-arm64
bun build --compile --target bun-darwin-x64    src/index.ts --outfile dist/op-darwin-amd64
bun build --compile --target bun-windows-x64   src/index.ts --outfile dist/op-windows-amd64.exe
```

SHA-256 checksums generated alongside:

```bash
sha256sum dist/op-* > dist/checksums.sha256
```

Both binaries and `checksums.sha256` are published to GitHub Releases on every version tag.

**Install script** (documented in ops guide):

```bash
# Linux/macOS one-liner
curl -fsSL https://github.com/oneplatform/oneplatform/releases/download/v{VERSION}/op-linux-amd64 \
  -o /usr/local/bin/op && chmod +x /usr/local/bin/op
```

Checksum verification (recommended):

```bash
sha256sum -c <(curl -fsSL .../checksums.sha256 | grep op-linux-amd64)
```

### 14.2 npm Package

`packages/cli/package.json`:

```json
{
  "name": "@oneplatform/cli",
  "version": "1.0.0",
  "description": "OnePlatform CLI (op)",
  "bin": {
    "op": "./dist/index.js"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "files": [
    "dist/",
    "README.md"
  ],
  "scripts": {
    "build": "tsc --project tsconfig.build.json",
    "build:binaries": "bash scripts/build-binaries.sh",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "docs:generate": "tsx src/lib/docs-generator.ts"
  }
}
```

The npm `dist/index.js` output is built with `tsc` (not Bun) for npm compatibility. The TypeScript target is `ES2023` with `module: "node16"`.

**Shebang handling**: `dist/index.js` has `#!/usr/bin/env node` as the first line. `tsc` does not add this — it is prepended by the build script.

### 14.3 Version Tagging

CI builds binaries and publishes to GitHub Releases on every `v*.*.*` git tag. The npm package is published via `npm publish` from CI at the same time. Versions are always in sync.

### 14.4 Turborepo Integration

`packages/cli/turbo.json` (inherits from root):

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["@oneplatform/sdk#build"],
      "outputs": ["dist/**"]
    },
    "build:binaries": {
      "dependsOn": ["build"],
      "outputs": ["dist/op-*"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "docs:generate": {
      "dependsOn": ["build"],
      "outputs": ["../../docs/generated/cli/**"]
    }
  }
}
```

The CLI build depends on `@oneplatform/sdk#build` because the SDK types must be compiled before the CLI can typecheck.

---

## 15. Testing Strategy

### 15.1 Unit Tests

Location: `tests/unit/`

Framework: Vitest (MIT)

**Command action tests** (`tests/unit/commands/{group}/{command}.test.ts`):
- One test file per action file.
- Actions are tested in isolation with a mocked `HttpClient`.
- HTTP mock provided by a `MockHttpClient` implementing the `HttpClient` interface.
- Assertions: correct API endpoint called, correct request body/query params, correct output rendered, correct exit code on error.

Example:

```typescript
// tests/unit/commands/pipeline/trigger.test.ts
import { triggerAction } from "../../../../src/commands/pipeline/trigger.js";
import { MockHttpClient } from "../../../helpers/mock-http-client.js";
import { createTestContext } from "../../../helpers/context.js";

test("trigger posts to correct endpoint and outputs run id", async () => {
  const http = new MockHttpClient();
  http.mockPost("/api/v1/pipelines/pip_01/trigger", { data: { runId: "run_01" } });
  const ctx = createTestContext({ http });
  const output: string[] = [];
  ctx.output.success = (msg) => output.push(msg);

  await triggerAction({ wait: false }, "pip_01", ctx);

  expect(http.calls).toEqual([
    { method: "POST", path: "/api/v1/pipelines/pip_01/trigger", body: {} }
  ]);
  expect(output).toContain("Pipeline triggered. Run ID: run_01");
});
```

**Library unit tests** (`tests/unit/lib/`):
- `credentials.test.ts`: encryption roundtrip, HKDF derivation, permission check, keytar unavailability fallback.
- `output.test.ts`: table truncation at 60 chars, ANSI color toggling, JSONL line-per-row output.
- `config-document.test.ts`: topological sort correctness (all 6 kinds in correct order), circular dependency detection, conflict mode logic, credential encryption/decryption.
- `errors.test.ts`: HTTP status to exit code mapping, error message formatting.

### 15.2 Snapshot Tests

Location: `tests/snapshots/output/`

For every list command, a snapshot test renders the output against fixture data and asserts it matches the stored snapshot. This catches accidental table format regressions.

Framework: Vitest's built-in snapshot support (`toMatchSnapshot()`).

Snapshot update process: `vitest run --update-snapshots` regenerates all snapshots. This is not run automatically in CI — snapshot updates require human review.

### 15.3 Integration Tests

Location: `tests/integration/`

Configuration: `vitest.integration.config.ts` — sets `testTimeout` to 60,000 ms.

Integration tests run against a local Docker Compose stack (`docker compose -f compose.test.yml up`). They test the full round-trip: CLI command → HTTP request → API → database → response → output.

**Scope**: a subset of high-value commands:
- `auth`: login, logout, whoami, generate-key, revoke-key.
- `pipeline`: create, trigger, runs, run-status, run-cancel.
- `config`: export, import (with each conflict mode), diff, validate.
- `ontology`: create, migrate, migration-status.

Integration tests are not run in the standard `pnpm test` task; they require the `OP_TEST_PLATFORM_URL` and `OP_TEST_API_KEY` environment variables.

### 15.4 Golden Output Tests

`tests/unit/commands/*/` also include golden output tests for the exact text printed by each command. These use a captured-stdout helper and assert the complete output string. They serve as regression tests for help text and output format.

### 15.5 Error Path Tests

Every command has tests for its error paths:
- 401 response → exit code 4, correct message.
- 403 response → exit code 5, correct message including the required scope.
- 404 response → exit code 1, correct resource-not-found message.
- 429 with max retries → exit code 2.
- Network timeout → exit code 3.
- Non-TTY stdin without `--yes` on destructive command → exit code 1.

### 15.6 CI Coverage

The Turborepo CI pipeline runs:
1. `turbo run build` — typecheck and compile.
2. `turbo run test` — unit + snapshot tests.
3. `turbo run docs:generate` — assert doc generation succeeds and output matches committed docs (drift detection).
4. `turbo run build:binaries` — compile all 5 standalone binaries (on the release branch only).

Integration tests run in a separate CI job with the test Docker Compose stack.

---

## 16. Technology Choices

### 16.1 Commander.js (CLI Framework)

**Decision**: Commander.js v12 (MIT)
**Rationale**: Selected in the tech stack table (ADR-22). Mature, zero-dependency, well-typed, smaller bundle than yargs. Explicit option registration fits the strict CI style requirements. Supports nested subcommands and help text generation cleanly.
**Alternative considered**: yargs — heavier, implicit camelCase coercion creates surprises in strict contexts.

### 16.2 keytar (Credential Storage)

**Decision**: keytar v7 (MIT)
**Rationale**: The only well-maintained npm library that bridges to OS credential stores on all three platforms (macOS Keychain, GNOME Keyring, Windows Credential Manager). The HKDF fallback removes the hard dependency for headless environments.
**Alternative considered**: custom file-only AES encryption — weaker security (key on disk, even if HKDF-derived from machine-id).

### 16.3 inquirer.js (Interactive Prompts)

**Decision**: inquirer v10 (MIT, ESM-only)
**Rationale**: The standard for Node.js CLI interactive prompts. Supports select, input, password (masked), confirm, checkbox. ESM-only in v10 is compatible with the CLI's ESM output.
**Alternative considered**: @inquirer/prompts (same project, modular v10 successor) — acceptable alternative; inquirer v10 is used for familiarity.

### 16.4 cli-table3 (Table Rendering)

**Decision**: cli-table3 v0.6 (MIT)
**Rationale**: Handles unicode column width correctly (important for names containing non-ASCII characters). Auto-sizing with a configurable max-width cap. Used by major CLIs (AWS CLI, Heroku CLI).
**Alternative considered**: terminal-table — less maintained, no unicode width handling.

### 16.5 js-yaml (YAML Parsing)

**Decision**: js-yaml v4 (MIT)
**Rationale**: The standard YAML library in the Node.js ecosystem. v4 supports multi-document parsing (`loadAll`), required for the config export/import format. Safe by default (no `!!js/function` execution).

### 16.6 Bun Build (Standalone Binaries)

**Decision**: `bun build --compile`
**Rationale**: The monorepo already uses Bun as the package manager and test runner. `bun build --compile` produces a single-file executable with no external runtime dependency, solving the Node.js requirement barrier for DevOps engineers on minimal CI images (ADR-34 rationale).
**Alternative considered**: `pkg` (Vercel) — archived; `nexe` — does not support modern ES modules cleanly.

### 16.7 TypeScript Configuration

**Decision**: TypeScript 5.x, `target: "ES2023"`, `moduleResolution: "node16"`, `strict: true`
**Rationale**: ES2023 is supported by Node.js 22 LTS and Bun 1.x. Strict mode catches the class of null/undefined bugs that are common in CLI option handling. `node16` module resolution ensures correct handling of `.js` extension imports in the ESM output.

### 16.8 @oneplatform/sdk Dependency

**Decision**: The CLI depends on `@oneplatform/sdk` as an internal workspace package.
**Rationale**: The SDK provides auth injection, retry logic, pagination iterators, and the OpenAPI-typed request/response types. Reusing the SDK ensures the CLI and external SDK users experience identical API behaviour. The CLI is a consumer of the SDK, not a separate HTTP implementation.

This creates a build dependency: `@oneplatform/sdk` must be compiled before `@oneplatform/cli`. Turborepo's task dependency graph enforces this order.
