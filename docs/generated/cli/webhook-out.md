---
title: "op webhook-out"
description: "Outbound webhook management (scope: admin)"
sidebar:
  order: 9
---

# `op webhook-out`

Outbound webhook management (scope: admin)

### `list`

List all outbound webhooks

**Usage:** `list [options]`


---

### `create`

Create an outbound webhook

**Usage:** `create [options]`

**Options:**

- `--url <url>` — HTTPS endpoint URL
- `--events <event,...>` — Comma-separated event types
- `--secret <secret>` — HMAC signing secret (generated if omitted)
- `--description <text>` — Human-readable label


---

### `update`

Update an outbound webhook

**Usage:** `update [options] <id>`

**Arguments:**

- `<id>` — Webhook ID

**Options:**

- `--url <url>` — New endpoint URL
- `--events <event,...>` — New comma-separated event types
- `--enabled <bool>` — Enable or disable: true|false


---

### `delete`

Delete an outbound webhook

**Usage:** `delete [options] <id>`

**Arguments:**

- `<id>` — Webhook ID


---

### `test`

Send a test payload to a webhook

**Usage:** `test [options] <id>`

**Arguments:**

- `<id>` — Webhook ID

**Options:**

- `--event-type <type>` — Synthetic event type to send


---

### `logs`

Show delivery log for a webhook

**Usage:** `logs [options] <id>`

**Arguments:**

- `<id>` — Webhook ID

**Options:**

- `--limit <n>` — Maximum deliveries to show
- `--status <status>` — Filter by status: delivered|failed|pending

