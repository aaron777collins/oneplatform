---
title: "op exec"
description: "Direct code execution (scope: execution:run)"
sidebar:
  order: 13
---

# `op exec`

Direct code execution (scope: execution:run)

### `run`

Execute a code file

**Usage:** `run [options]`

**Options:**

- `--lang <lang>` — Execution language: js|ts
- `--file <code-file>` — Path to source file
- `--input <json>` — JSON string passed as execution input
- `--timeout <ms>` — Execution timeout in milliseconds (default: `30000`)
- `--wait` — Wait for completion and stream output (default: true) (default: `true`)


---

### `history`

List past executions

**Usage:** `history [options]`

**Options:**

- `--limit <n>` — Maximum records to return
- `--lang <lang>` — Filter by language
- `--from <date>` — Start date filter (ISO 8601)
- `--to <date>` — End date filter (ISO 8601)


---

### `logs`

Get logs for a specific execution

**Usage:** `logs [options] <execution-id>`

**Arguments:**

- `<execution-id>` — Execution ID

