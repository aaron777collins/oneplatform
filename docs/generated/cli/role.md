---
title: "op role"
description: "Role management (scope: users:manage)"
sidebar:
  order: 4
---

# `op role`

Role management (scope: users:manage)

### `list`

List all roles

**Usage:** `list [options]`


---

### `create`

Create a new role

**Usage:** `create [options]`

**Options:**

- `--name <name>` — Role identifier (lowercase, no spaces)
- `--permissions <perm,...>` — Comma-separated permission list


---

### `assign`

Assign a role to a user

**Usage:** `assign [options] <role-name>`

**Arguments:**

- `<role-name>` — Role name

**Options:**

- `--user <user-id>` — User ID


---

### `remove`

Remove a role from a user

**Usage:** `remove [options] <role-name>`

**Arguments:**

- `<role-name>` — Role name

**Options:**

- `--user <user-id>` — User ID

