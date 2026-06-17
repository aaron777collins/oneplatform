---
title: "op plugin"
description: "Plugin management"
sidebar:
  order: 15
---

# `op plugin`

Plugin management

### `list`

List all plugins

**Usage:** `list [options]`

**Options:**

- `--type <type>` — Filter by type: connector|transformer|destination|auth-provider|widget
- `--status <status>` — Filter by status: enabled|disabled|installed


---

### `install`

Install a plugin from file, URL, or registry reference

**Usage:** `install [options] <source>`

**Arguments:**

- `<source>` — Local .oppkg path, HTTPS URL, or registry reference

**Options:**

- `--tenant <id>` — Install for specific tenant (ignored in --dev mode; always uses your own tenant)
- `--dev` — Install in development mode: requires only plugins:manage scope, scoped to your tenant, expires in 7 days


---

### `upgrade`

Upload a new plugin version (replaces the active version)

**Usage:** `upgrade [options] <source>`

**Arguments:**

- `<source>` — Local .oppkg path or HTTPS URL of the updated plugin package

**Options:**

- `--tenant <id>` — Target tenant for the upgrade


---

### `rollback`

Roll back a plugin to its previous version

**Usage:** `rollback [options] <plugin-id>`

**Arguments:**

- `<plugin-id>` — Plugin manifest ID to roll back


---

### `enable`

Enable an installed plugin

**Usage:** `enable [options] <plugin-id>`

**Arguments:**

- `<plugin-id>` — Plugin ID

**Options:**

- `--tenant <id>` — Enable for specific tenant


---

### `disable`

Disable an installed plugin

**Usage:** `disable [options] <plugin-id>`

**Arguments:**

- `<plugin-id>` — Plugin ID

**Options:**

- `--tenant <id>` — Disable for specific tenant


---

### `uninstall`

Uninstall a plugin

**Usage:** `uninstall [options] <plugin-id>`

**Arguments:**

- `<plugin-id>` — Plugin ID


---

### `info`

Show plugin manifest and details

**Usage:** `info [options] <plugin-id>`

**Arguments:**

- `<plugin-id>` — Plugin ID


---

### `create`

Scaffold a new plugin project interactively

**Usage:** `create [options]`


---

### `pack`

Package the current directory into a .oppkg file

**Usage:** `pack [options]`

**Options:**

- `--out <path>` — Output file path
- `--sign <gpg-key-id>` — GPG key ID to sign the package


---

### `validate`

Validate a .oppkg file

**Usage:** `validate [options] <path-to.oppkg>`

**Arguments:**

- `<path-to.oppkg>` — Path to the .oppkg file


---

### `simulate-hook`

Test a plugin hook locally (no server required) or against a running instance with --remote

**Usage:** `simulate-hook [options] <stage>`

**Arguments:**

- `<stage>` — Hook stage, e.g. before:ingestion.receive | after:ingestion.validate | before:ontology.map | before:pipeline.trigger | before:auth.login | before:app.request

**Options:**

- `--plugin <path-or-id>` — Local bundle path (default: ./dist/bundle.js) or Plugin ID when using --remote
- `--input <data.json>` — Path to JSON file containing HookPayload.data
- `--entrypoint <export>` — Named export to invoke (overrides plugin.manifest.json entrypoint)
- `--tenant-id <id>` — Tenant ID for the mock context (default: dev-tenant)
- `--credentials <creds.json>` — Path to JSON file with credential name→value mappings
- `--config <config.json>` — Path to JSON file with plugin instance config values
- `--timeout <ms>` — Execution timeout in milliseconds (default: 30000)
- `--sandbox` — Use isolated-vm for production-accurate sandboxing (requires isolated-vm to be installed)
- `--remote` — Execute on the running OnePlatform server instead of locally (requires --plugin <plugin-id>)

