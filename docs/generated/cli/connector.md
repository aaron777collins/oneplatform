---
title: "op connector"
description: "Data connector management (scope: pipelines:manage)"
sidebar:
  order: 7
---

# `op connector`

Data connector management (scope: pipelines:manage)

### `list`

List all connectors

**Usage:** `list [options]`

**Options:**

- `--plugin <plugin-id>` — Filter by plugin ID
- `--status <status>` — Filter by status: enabled|disabled


---

### `create`

Create a new connector

**Usage:** `create [options]`

**Options:**

- `--plugin <plugin-id>` — Plugin ID of the connector plugin
- `--name <name>` — Connector display name
- `--config <config.json>` — Path to JSON configuration file
- `--credentials <credentials.json>` — Path to JSON file containing connector credentials (keep this file secure)
- `--sync-mode <mode>` — Sync mode: full | incremental (default: connector plugin default)
- `--enabled` — Enable the connector immediately (default: true) (default: `true`)
- `--no-enabled` — Create the connector in a disabled state
- `--interactive` — Use interactive prompts for configuration
- `--schedule-cron <expr>` — Cron schedule for automatic syncs, e.g. '0 9 * * 1-5' for weekdays at 9am UTC (5 fields required)


---

### `get`

Get connector details

**Usage:** `get [options] <id>`

**Arguments:**

- `<id>` — Connector ID


---

### `update`

Update a connector

**Usage:** `update [options] <id>`

**Arguments:**

- `<id>` — Connector ID

**Options:**

- `--name <name>` — New display name
- `--config <config.json>` — Path to updated JSON configuration
- `--credentials <credentials.json>` — Path to JSON file with updated credentials (keep this file secure)
- `--sync-mode <mode>` — New sync mode: full | incremental
- `--enabled` — Enable the connector
- `--no-enabled` — Disable the connector
- `--description <text>` — Update the connector description (pass empty string to clear)
- `--schedule-cron <expr>` — Update cron schedule for automatic syncs, e.g. '0 9 * * 1-5' (5 fields required; pass empty string to clear)


---

### `delete`

Delete a connector

**Usage:** `delete [options] <id>`

**Arguments:**

- `<id>` — Connector ID


---

### `test`

Test a connector connection

**Usage:** `test [options] <id>`

**Arguments:**

- `<id>` — Connector ID


---

### `trigger`

Manually trigger a connector run

**Usage:** `trigger [options] <id>`

**Arguments:**

- `<id>` — Connector ID

**Options:**

- `--wait` — Poll until run completes
- `--mode <mode>` — Sync mode override: full | incremental
- `--force` — Force sync even if one is already running

