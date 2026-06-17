---
title: "op app"
description: "App management"
sidebar:
  order: 14
---

# `op app`

App management

### `init`

Scaffold a new app project locally (no platform connection required)

**Usage:** `init [options]`

**Options:**

- `--name <name>` — App display name
- `--slug <slug>` — URL slug (kebab-case; derived from name if omitted)
- `--out <dir>` — Output directory (default: ./<slug>)


---

### `list`

List all apps

**Usage:** `list [options]`

**Options:**

- `--status <status>` — Filter by status: draft|building|deployed|failed


---

### `get`

Get app details

**Usage:** `get [options] <slug>`

**Arguments:**

- `<slug>` — App URL slug


---

### `create`

Create a new app

**Usage:** `create [options]`

**Options:**

- `--name <name>` — Display name
- `--template <template>` — Starter template name
- `--slug <slug>` — URL slug (auto-derived from name if omitted)


---

### `deploy`

Deploy an app. Without --file, triggers a server-side build from the registered source.
With --file, uploads a pre-built bundle (.tar.gz). Bundle must contain: index.html, bundled JS/CSS. Build with: vite build && tar -czf bundle.tar.gz -C dist .

**Usage:** `deploy [options] <slug>`

**Arguments:**

- `<slug>` — App URL slug

**Options:**

- `--file <bundle-path>` — Path to app bundle (.tar.gz). Bundle must contain: index.html, bundled JS/CSS. Build with: vite build && tar -czf bundle.tar.gz -C dist .
- `--env <env>` — Deployment environment: production|preview
- `--wait` — Poll build until complete, stream build logs to stderr


---

### `dev`

Start a local development server against the live platform

**Usage:** `dev [options] <slug>`

**Arguments:**

- `<slug>` — App URL slug

**Options:**

- `--port <n>` — Local server port (default: `3100`)
- `--prefer-local` — Always keep local files on conflict
- `--prefer-remote` — Always use remote files on conflict


---

### `logs`

Get or stream app logs

**Usage:** `logs [options] <slug>`

**Arguments:**

- `<slug>` — App URL slug

**Options:**

- `-f, --follow` — Stream live logs via SSE until Ctrl+C
- `--from <date>` — Start date filter (ISO 8601)
- `--level <level>` — Minimum log level: debug|info|warn|error


---

### `delete`

Delete an app permanently

**Usage:** `delete [options] <slug>`

**Arguments:**

- `<slug>` — App URL slug


---

### `env-set`

Set an environment variable (encrypted at rest)

**Usage:** `env-set [options] <slug> <key> <value>`

**Arguments:**

- `<slug>` — App URL slug
- `<key>` — Variable name
- `<value>` — Variable value


---

### `env-list`

List environment variable names (values masked)

**Usage:** `env-list [options] <slug>`

**Arguments:**

- `<slug>` — App URL slug


---

### `rollback`

Roll back an app to a previous version

**Usage:** `rollback [options] <slug>`

**Arguments:**

- `<slug>` — App URL slug

**Options:**

- `--to <version>` — Version number to roll back to

