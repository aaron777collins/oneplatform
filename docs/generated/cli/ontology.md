---
title: "op ontology"
description: "Schema management"
sidebar:
  order: 5
---

# `op ontology`

Schema management

### `list`

List all entity types

**Usage:** `list [options]`


---

### `get`

Get a specific entity type schema

**Usage:** `get [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name


---

### `create`

Create a new entity type from schema file or inline options

**Usage:** `create [options]`

**Options:**

- `--file <schema.json>` — Path to JSON schema file (full schema definition)
- `--name <name>` — Entity type display name (enables inline creation without a file)
- `--slug <slug>` — URL slug in kebab-case (derived from --name if omitted)
- `--description <desc>` — Entity description
- `--public` — Make entity publicly readable (default: false)


---

### `update`

Update an entity type schema

**Usage:** `update [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--file <schema.json>` — Path to JSON schema file


---

### `delete`

Delete an entity type

**Usage:** `delete [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--confirm` — Alias for --yes on this subcommand


---

### `validate`

Validate a schema file

**Usage:** `validate [options]`

**Options:**

- `--file <schema.json>` — Path to JSON schema file


---

### `diff`

Show diff between proposed and current schema

**Usage:** `diff [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--file <schema.json>` — Path to JSON schema file


---

### `migrate`

Trigger a schema migration

**Usage:** `migrate [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--wait` — Poll until migration completes
- `--timeout <seconds>` — Max wait duration in seconds


---

### `migration-status`

Get migration status

**Usage:** `migration-status [options] <migration-id>`

**Arguments:**

- `<migration-id>` — Migration ID


---

### `migration-rollback`

Roll back a migration

**Usage:** `migration-rollback [options] <migration-id>`

**Arguments:**

- `<migration-id>` — Migration ID


---

### `export`

Export all entity schemas

**Usage:** `export [options]`

**Options:**

- `--format <fmt>` — Output format: yaml|json (default: `yaml`)
- `--out <path>` — Write to file instead of stdout


---

### `import`

Import entity schemas from file

**Usage:** `import [options]`

**Options:**

- `--file <path>` — Path to schema export file
- `--on-conflict <mode>` — Conflict mode: fail|skip|overwrite (default: `fail`)

