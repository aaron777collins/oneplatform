---
title: "op schedule"
description: "Cron schedule management (scope: pipelines:manage)"
sidebar:
  order: 11
---

# `op schedule`

Cron schedule management (scope: pipelines:manage)

### `list`

List all schedules

**Usage:** `list [options]`

**Options:**

- `--pipeline <id>` — Filter by pipeline ID
- `--status <status>` — Filter by status: active|paused


---

### `create`

Create a cron schedule for a pipeline

**Usage:** `create [options]`

**Options:**

- `--pipeline <id>` — Pipeline ID
- `--cron <expr>` — Standard 5-field cron expression (minute hour day month weekday). Examples: "0 */6 * * *" (every 6 hours), "30 9 * * 1-5" (weekdays at 09:30)
- `--name <name>` — Display name
- `--timezone <tz>` — IANA timezone string (default: UTC)
- `--input-template <json>` — JSON string of input template parameters passed to each triggered run
- `--disabled` — Create the schedule in a disabled state


---

### `pause`

Pause a schedule

**Usage:** `pause [options] <id>`

**Arguments:**

- `<id>` — Schedule ID


---

### `resume`

Resume a paused schedule

**Usage:** `resume [options] <id>`

**Arguments:**

- `<id>` — Schedule ID


---

### `delete`

Delete a schedule

**Usage:** `delete [options] <id>`

**Arguments:**

- `<id>` — Schedule ID

