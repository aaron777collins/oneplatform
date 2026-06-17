---
title: "op auth"
description: "Authentication and credential management"
sidebar:
  order: 1
---

# `op auth`

Authentication and credential management

### `login`

Establish credentials for the active profile

**Usage:** `login [options]`

**Options:**

- `--platform <url>` — Platform URL
- `--key <api-key>` — API key (skips interactive prompt)


---

### `logout`

Clear credentials for the current profile

**Usage:** `logout [options]`


---

### `status`

Show current authentication state

**Usage:** `status [options]`


---

### `whoami`

Print current user details

**Usage:** `whoami [options]`


---

### `generate-key`

Generate a new API key

**Usage:** `generate-key [options]`

**Options:**

- `--name <name>` — Human-readable label for the key
- `--scopes <scopes>` — Comma-separated scopes (valid: data:read, data:write, ontology:read, ontology:write, pipelines:read, pipelines:trigger, pipelines:manage, apps:read, apps:deploy, apps:manage, plugins:read, plugins:manage, users:read, users:manage, logs:read, webhooks:manage, execution:read, execution:run, admin)
- `--expires <ISO-date>` — Expiry date (ISO 8601); omit for non-expiring key


---

### `list-keys`

List all API keys for the current user

**Usage:** `list-keys [options]`


---

### `revoke-key`

Revoke an API key

**Usage:** `revoke-key [options] <key-id>`

**Arguments:**

- `<key-id>` — API key ID to revoke


---

### `rotate-key`

Rotate an API key with overlap period

**Usage:** `rotate-key [options] <key-id>`

**Arguments:**

- `<key-id>` — API key ID to rotate

**Options:**

- `--overlap <duration>` — Overlap duration (e.g. 1h, 30m) (default: `1h`)


---

### `emergency-rotate`

Rotate JWT signing secret, invalidating ALL active sessions (admin only)

**Usage:** `emergency-rotate [options]`

