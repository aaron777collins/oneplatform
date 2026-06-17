---
title: "op user"
description: "User management (scope: users:manage)"
sidebar:
  order: 3
---

# `op user`

User management (scope: users:manage)

### `list`

List users

**Usage:** `list [options]`

**Options:**

- `--tenant <id>` — Filter by tenant ID
- `--limit <n>` — Maximum records to return
- `--status <status>` — Filter by status: active|inactive|all


---

### `invite`

Invite a new user

**Usage:** `invite [options]`

**Options:**

- `--email <email>` — Target email address
- `--role <role>` — Role to assign
- `--send-email` — Trigger invitation email


---

### `get`

Get user details

**Usage:** `get [options] <id>`

**Arguments:**

- `<id>` — User ID


---

### `update`

Update user attributes

**Usage:** `update [options] <id>`

**Arguments:**

- `<id>` — User ID

**Options:**

- `--role <role>` — Assign a role
- `--display-name <name>` — Update display name


---

### `deactivate`

Deactivate a user

**Usage:** `deactivate [options] <id>`

**Arguments:**

- `<id>` — User ID


---

### `import`

Bulk import users from CSV

**Usage:** `import [options]`

**Options:**

- `--file <csv-path>` — Path to CSV file (headers: email,displayName,role)
- `--role <role>` — Default role if CSV row omits role column
- `--dry-run` — Validate and report counts without writing

