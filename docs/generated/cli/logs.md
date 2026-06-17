---
title: "op logs"
description: "Log management (scope: admin)"
sidebar:
  order: 16
---

# `op logs`

Log management (scope: admin)

### `query`

Query log entries

**Usage:** `query [options]`

**Options:**

- `--service <name>` — Filter by service name
- `--level <level>` — Minimum log level: debug|info|warn|error
- `--from <date>` — Start date filter (ISO 8601)
- `--to <date>` — End date filter (ISO 8601)
- `--trace-id <id>` — Filter by trace ID
- `--limit <n>` — Maximum records to return


---

### `tail`

Stream live logs via SSE

**Usage:** `tail [options]`

**Options:**

- `--service <name>` — Filter by service name
- `--level <level>` — Minimum log level
- `--trace-id <id>` — Filter by trace ID


---

### `audit`

Query audit log entries

**Usage:** `audit [options]`

**Options:**

- `--from <date>` — Start date filter (ISO 8601)
- `--to <date>` — End date filter (ISO 8601)
- `--actor <user-id>` — Filter by actor user ID
- `--action <action>` — Filter by action type
- `--resource <resource>` — Filter by resource type


---

### `export`

Export logs to file

**Usage:** `export [options]`

**Options:**

- `--from <date>` — Start date filter (ISO 8601)
- `--to <date>` — End date filter (ISO 8601)
- `--service <name>` — Filter by service name
- `--format <fmt>` — Output format: jsonl|csv
- `--out <path>` — Write to file instead of stdout

