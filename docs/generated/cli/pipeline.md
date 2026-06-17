---
title: "op pipeline"
description: "Pipeline management"
sidebar:
  order: 10
---

# `op pipeline`

Pipeline management

### `list`

List all pipelines

**Usage:** `list [options]`

**Options:**

- `--status <status>` — Filter by status: active|paused|draft


---

### `get`

Get pipeline details

**Usage:** `get [options] <id>`

**Arguments:**

- `<id>` — Pipeline ID


---

### `create`

Create a pipeline from YAML file

**Usage:** `create [options]`

**Options:**

- `--file <pipeline.yaml>` — Path to pipeline YAML definition


---

### `update`

Update a pipeline from YAML file

**Usage:** `update [options] <id>`

**Arguments:**

- `<id>` — Pipeline ID

**Options:**

- `--file <pipeline.yaml>` — Path to pipeline YAML definition


---

### `delete`

Delete a pipeline

**Usage:** `delete [options] <id>`

**Arguments:**

- `<id>` — Pipeline ID


---

### `trigger`

Manually trigger a pipeline run

**Usage:** `trigger [options] <id>`

**Arguments:**

- `<id>` — Pipeline ID

**Options:**

- `--input <json>` — JSON string of runtime input parameters
- `--wait` — Poll until run completes (run ID still printed to stdout)


---

### `runs`

List runs for a pipeline

**Usage:** `runs [options] <id>`

**Arguments:**

- `<id>` — Pipeline ID

**Options:**

- `--limit <n>` — Maximum runs to return
- `--status <status>` — Filter: running|completed|failed|cancelled


---

### `run-status`

Get status of a specific run

**Usage:** `run-status [options] <run-id>`

**Arguments:**

- `<run-id>` — Pipeline run ID


---

### `run-cancel`

Cancel a running pipeline run

**Usage:** `run-cancel [options] <run-id>`

**Arguments:**

- `<run-id>` — Pipeline run ID


---

### `run-logs`

Get or stream logs for a pipeline run

**Usage:** `run-logs [options] <run-id>`

**Arguments:**

- `<run-id>` — Pipeline run ID

**Options:**

- `-f, --follow` — Stream live logs via SSE until run completes or Ctrl+C
- `--step <step-id>` — Filter to a specific step ID
- `--level <level>` — Minimum log level: debug|info|warn|error

