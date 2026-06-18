# @oneplatform/cli

Command-line interface for OnePlatform. Invoked as `op`.

## Installation

```sh
# Global install
npm install -g @oneplatform/cli

# Or via pnpm
pnpm add -g @oneplatform/cli
```

Requires Node.js 18+.

## Authentication

### Interactive login

```sh
op auth login --platform https://api.example.com
# Prompts for email and password
```

### Login with an existing API key

```sh
op auth login --platform https://api.example.com --key op_live_abc123
```

### Check authentication status

```sh
op auth status
op auth whoami        # prints user ID, email, tenant, and roles
```

### Logout

```sh
op auth logout
```

### API key management

```sh
# Create a key with specific scopes
op auth generate-key \
  --name "CI deploy key" \
  --scopes "apps:deploy,pipelines:trigger" \
  --expires 2025-12-31

# List all keys for the current user
op auth list-keys

# Revoke a key
op auth revoke-key <key-id>

# Rotate a key (old key remains valid during overlap period)
op auth rotate-key <key-id> --overlap 1h
```

Available scopes: `data:read`, `data:write`, `ontology:read`, `ontology:write`,
`pipelines:read`, `pipelines:trigger`, `pipelines:manage`, `apps:read`,
`apps:deploy`, `apps:manage`, `plugins:read`, `plugins:manage`, `users:read`,
`users:manage`, `logs:read`, `webhooks:manage`, `execution:read`,
`execution:run`, `admin`.

## Global Flags

These flags apply to every command.

| Flag | Env | Description |
|---|---|---|
| `--profile <name>` | `OP_PROFILE` | Credential profile to use |
| `-o, --output <fmt>` | `OP_OUTPUT` | Output format: `table` (default), `json`, `jsonl`, `tsv` |
| `-y, --yes` | | Skip destructive-action confirmations |
| `-q, --quiet` | | Suppress all output except errors |
| `--no-color` | `NO_COLOR` | Disable ANSI colors |
| `-v, --verbose` | `OP_VERBOSE` | Print stack traces and HTTP request details |
| `--timeout <ms>` | `OP_TIMEOUT` | HTTP request timeout in milliseconds |
| `--platform <url>` | `OP_PLATFORM_URL` | Override the platform URL |

## Commands by Category

### Auth and Identity

```sh
op auth login                        # Log in
op auth logout                       # Clear credentials
op auth status                       # Show auth state
op auth whoami                       # Print current user
op auth generate-key --name <n> --scopes <s>  # Create API key
op auth list-keys                    # List API keys
op auth revoke-key <key-id>          # Revoke a key
op auth rotate-key <key-id>          # Rotate a key with overlap
op auth emergency-rotate             # Invalidate ALL sessions (admin)

op profile                           # View/update your own profile
op user list                         # List users (admin)
op user get <id>                     # Get user details (admin)
op user create --email <e>           # Create user (admin)
op user update <id>                  # Update user (admin)
op user delete <id>                  # Delete user (admin)

op role list                         # List role assignments
op role assign <user-id> <role>      # Assign a role
op role revoke <user-id> <role>      # Revoke a role
```

### Data

```sh
# Ontology schema management (scope: ontology:read / ontology:write)
op ontology list                          # List all entity types
op ontology get <entity-type>             # Get entity type schema
op ontology create --name <n>             # Create minimal entity type
op ontology create --file schema.json     # Create from JSON schema file
op ontology update <entity-type> --file schema.json
op ontology delete <entity-type>
op ontology export --out schema.yaml      # Export full schema
op ontology import --file schema.yaml     # Import schema
op ontology diff --file schema.yaml       # Preview schema changes
op ontology validate --file schema.yaml   # Validate schema
op ontology migrate --wait                # Trigger schema migration

# Entity CRUD (scope: data:read / data:write)
op data query <entity-type> --filter '{"status":{"eq":"active"}}' --limit 100
op data get <entity-type> <id>
op data create <entity-type> --file record.json
op data create <entity-type> --file -            # read JSON from stdin
op data update <entity-type> <id> --file patch.json
op data delete <entity-type> <id>
op data import <entity-type> --file records.csv
op data import <entity-type> --file records.jsonl --batch-size 1000 --dry-run
op data export <entity-type> --format csv --out data.csv

# Connectors (scope: pipelines:manage)
op connector list
op connector get <id>
op connector create --plugin <plugin-id> --name <n> --config config.json
op connector update <id> --config config.json
op connector delete <id>
op connector trigger <id> --wait          # Trigger a sync run
op connector trigger <id> --mode full     # Force full sync
op connector test <id>                    # Validate connectivity

# Field mapping rules
op mapping list --connector <id>
op mapping create --connector <id> --file mapping.json
op mapping update <id> --file mapping.json
op mapping delete <id>

# Outbound webhooks (scope: webhooks:manage)
op webhook-out list
op webhook-out create --url https://example.com/hook --events 'data.Product.*'
op webhook-out delete <id>
```

### Pipelines

```sh
# Pipeline management (scope: pipelines:read / pipelines:manage)
op pipeline list
op pipeline list --status active
op pipeline get <id>
op pipeline create --file pipeline.yaml
op pipeline update <id> --file pipeline.yaml
op pipeline delete <id>

# Trigger and monitor runs
op pipeline trigger <id>
op pipeline trigger <id> --input '{"env":"production"}' --wait
op pipeline runs <id>
op pipeline runs <id> --status failed
op pipeline run-status <run-id>
op pipeline run-cancel <run-id>
op pipeline run-logs <run-id>
op pipeline run-logs <run-id> --follow      # stream live logs via SSE
op pipeline run-logs <run-id> --step <step-id> --level warn

# Scheduled runs (scope: pipelines:manage)
op schedule list
op schedule create --pipeline <id> --cron '0 9 * * 1-5'  # weekdays at 9am UTC
op schedule update <id> --cron '0 * * * *'
op schedule delete <id>
op schedule pause <id>
op schedule resume <id>

# Dead-letter queue (scope: admin)
op dlq list
op dlq get <id>
op dlq replay <id>               # Replay a failed record
op dlq replay --all --filter 'type=Product'
op dlq discard <id>

# Ad-hoc execution (scope: execution:run)
op exec run --file script.js
op exec run --file script.js --input '{"debug":true}'
```

### Apps and Plugins

```sh
# Apps (scope: apps:read / apps:deploy / apps:manage)
op app init --name "My Dashboard" --slug my-dashboard  # scaffold locally
op app list
op app list --status deployed
op app get <slug>
op app create --name "My App" --slug my-app
op app deploy <slug>                           # trigger server-side build
op app deploy <slug> --file bundle.tar.gz --wait  # upload pre-built bundle
op app dev <slug> --port 3100                  # local dev server
op app logs <slug>
op app logs <slug> --follow --level info       # stream live logs
op app env-set <slug> <KEY> <value>            # set encrypted env var
op app env-list <slug>
op app rollback <slug>                         # roll back to previous version
op app rollback <slug> --to <version>
op app delete <slug>

# Plugins (scope: plugins:read / plugins:manage)
op plugin list
op plugin list --type connector
op plugin get <id>
op plugin install <plugin-id>@<version>        # install from marketplace
op plugin install --file plugin.tgz            # install from file
op plugin upgrade <id>
op plugin rollback <id>
op plugin uninstall <id>
op plugin enable <id>
op plugin disable <id>
op plugin init --name "My Plugin" --type connector  # scaffold plugin project
op plugin pack                                 # build .tgz bundle
op plugin simulate --plugin ./dist/bundle.js --input payload.json  # test hooks locally
```

### Admin and Tooling

```sh
# Logs and audit trail (scope: admin)
op logs query --service ingestion --level error --from 2024-01-01
op logs tail --service pipeline --level warn    # stream live logs
op logs audit --from 2024-01-01 --to 2024-01-31 --actor user@example.com
op logs export --from 2024-01-01 --to 2024-01-31 --out logs.jsonl

# Platform configuration (scope: admin)
op config export --out platform.yaml
op config export --include-credentials --passphrase <phrase> --out platform.yaml
op config import --file platform.yaml
op config import --file platform.yaml --on-conflict overwrite
op config diff --file platform.yaml            # preview changes (alias for import --dry-run)
op config validate --file platform.yaml        # validate without applying

# Platform health
op status                                      # overall health summary
op service list                                # list services and their status
op service restart <name>                      # restart a service (admin)

# SDK code generation
op sdk generate --lang typescript --out ./src/generated
op sdk generate --lang python --out ./generated

# Utilities
op version                                     # print version info
op completion bash >> ~/.bashrc                # install shell completion
op completion zsh >> ~/.zshrc
```

## Configuration Profiles

Profiles let you switch between multiple OnePlatform instances (e.g.
production and staging) without re-authenticating each time.

```sh
# View current profile
op profile get

# Update profile settings
op profile set --platform https://staging.example.com

# Use a specific profile for one command
op --profile staging data query Product
```

Set `OP_PROFILE` to select a profile for all commands in the current shell
session:

```sh
export OP_PROFILE=staging
op data query Product   # uses staging credentials
```

## Output Formats

```sh
# Default: human-readable table
op data query Product

# JSON — pipe to jq
op data query Product -o json | jq '.[].name'

# JSON Lines — one record per line, suitable for streaming to other tools
op data query Product -o jsonl | wc -l

# TSV — tab-separated values for spreadsheets
op data query Product -o tsv > products.tsv
```

## Environment Variables

| Variable | Description |
|---|---|
| `OP_PLATFORM_URL` | Default platform URL |
| `OP_PROFILE` | Active credential profile name |
| `OP_OUTPUT` | Default output format (`table`, `json`, `jsonl`, `tsv`) |
| `OP_VERBOSE` | Enable verbose HTTP logging (`true` / `1`) |
| `OP_TIMEOUT` | HTTP request timeout in milliseconds |
| `NO_COLOR` | Disable ANSI colours when set to any value |
