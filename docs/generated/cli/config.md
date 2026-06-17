---
title: "op config"
description: "Platform configuration export/import (scope: admin)"
sidebar:
  order: 17
---

# `op config`

Platform configuration export/import (scope: admin)

### `export`

Export platform configuration to YAML/JSON

**Usage:** `export [options]`

**Options:**

- `--format <fmt>` — Output format: yaml|json (default: `yaml`)
- `--include-credentials` — Include encrypted credential values (requires --passphrase)
- `--passphrase <pass>` — Passphrase for credential encryption
- `--out <path>` — Write to file instead of stdout
- `--kinds <kinds>` — Comma-separated resource kinds to export (default: all)


---

### `import`

Import platform configuration from YAML/JSON file

**Usage:** `import [options]`

**Options:**

- `--file <path>` — Path to config export file
- `--on-conflict <mode>` — Conflict resolution: fail|skip|overwrite|merge (default: `fail`)
- `--dry-run` — Perform full validation without any writes
- `--passphrase <pass>` — Required if config contains encrypted credentials


---

### `diff`

Preview changes from a config file (alias for import --dry-run)

**Usage:** `diff [options]`

**Options:**

- `--file <path>` — Path to config export file


---

### `validate`

Validate a config file structure and cross-references

**Usage:** `validate [options]`

**Options:**

- `--file <path>` — Path to config export file

