---
title: "op dlq"
description: "Dead-letter queue management (scope: admin)"
sidebar:
  order: 12
---

# `op dlq`

Dead-letter queue management (scope: admin)

### `list`

List jobs in the dead-letter queue

**Usage:** `list [options]`

**Options:**

- `--queue <queue-name>` — Filter by queue name
- `--limit <n>` — Maximum jobs to return
- `--from <date>` — Start date filter (ISO 8601)
- `--to <date>` — End date filter (ISO 8601)


---

### `replay`

Re-queue a DLQ job for processing

**Usage:** `replay [options] <job-id>`

**Arguments:**

- `<job-id>` — Job ID

**Options:**

- `--queue <queue-name>` — Override destination queue


---

### `discard`

Permanently remove a job from the DLQ

**Usage:** `discard [options] <job-id>`

**Arguments:**

- `<job-id>` — Job ID

