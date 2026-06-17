---
title: "op data"
description: "Data CRUD operations"
sidebar:
  order: 6
---

# `op data`

Data CRUD operations

### `query`

Query records of an entity type

**Usage:** `query [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--filter <json>` — JSON filter object
- `--sort <field>` — Sort field
- `--sort-dir <dir>` — Sort direction: asc|desc
- `--limit <n>` — Maximum records to return
- `--cursor <token>` — Pagination cursor from a previous response (replaces --offset)


---

### `get`

Get a single record

**Usage:** `get [options] <entity-type> <id>`

**Arguments:**

- `<entity-type>` — Entity type name
- `<id>` — Record ID


---

### `create`

Create a new record

**Usage:** `create [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--file <data.json>` — JSON file (use '-' for stdin)


---

### `update`

Partially update a record

**Usage:** `update [options] <entity-type> <id>`

**Arguments:**

- `<entity-type>` — Entity type name
- `<id>` — Record ID

**Options:**

- `--file <data.json>` — JSON file with fields to update


---

### `delete`

Delete a record

**Usage:** `delete [options] <entity-type> <id>`

**Arguments:**

- `<entity-type>` — Entity type name
- `<id>` — Record ID


---

### `import`

Bulk import records from file

**Usage:** `import [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--file <path>` — Path to CSV, JSON, or JSONL file
- `--format <fmt>` — Format: csv|json|jsonl (auto-detected from extension)
- `--batch-size <n>` — Records per batch call (default: `500`)
- `--dry-run` — Validate and report counts without writing


---

### `export`

Export records to file or stdout

**Usage:** `export [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Entity type name

**Options:**

- `--filter <json>` — JSON filter object
- `--format <fmt>` — Format: csv|json|jsonl
- `--out <path>` — Write to file instead of stdout

