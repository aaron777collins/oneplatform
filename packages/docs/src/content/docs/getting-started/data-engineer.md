---
title: Data Engineer Quickstart
description: Connect a data source, define an ontology, map fields, and run your first sync.
sidebar:
  order: 2
---

Connect a data source, define an ontology, map fields, and run your first sync.

## Prerequisites

- OnePlatform stack running (see [Platform Admin Quickstart](/getting-started/platform-admin))
- `@oneplatform/cli` installed globally: `npm install -g @oneplatform/cli`
- Credentials for your source system (e.g., a Postgres connection string or API key)

## Setup (3 commands)

```sh
# 1. Log in with your data-engineer account
op auth login --email dataengineer@example.com

# 2. Verify your scopes include connectors:manage and ontology:write
op auth whoami

# 3. Check that the stack is healthy
op service health
```

## First working example

### Step 1: Define an ontology entity

```sh
# Create an entity type for customers
op ontology create --name "Customer" --slug "customer" --description "A platform customer record"
```

Or from a full JSON schema:

```sh
op ontology create --file schema/customer.json
```

Expected output:

```
Created entity type: customer (id: <uuid>)
Fields: 0
```

### Step 2: Create a connector

```sh
# Create a Postgres connector
op connector create \
  --name "Production DB" \
  --type postgres \
  --credentials '{"host":"db.example.com","port":5432,"database":"prod","user":"reader","password":"<secret>"}' \
  --sync-mode incremental
```

Expected output:

```
Created connector: production-db (id: <uuid>)
Status: pending
```

### Step 3: Create a mapping rule

```sh
# Map a source field to the customer entity
# --target-field accepts a UUID or the field slug
op mapping create \
  --connector production-db \
  --entity-type customer \
  --source-field "email_address" \
  --target-field "email"
```

### Step 4: Run the first sync

```sh
# Trigger a manual sync
op connector trigger production-db

# Monitor sync progress
op connector get production-db --watch
```

Expected output after completion:

```
Sync complete: 1,247 records processed in 8.3s
Next scheduled: (none — trigger manually or set --schedule-cron)
```

### Step 5: Query the synced data

```sh
# List synced customer records
op data query customer --limit 5
```

## Schedule automatic syncs

```sh
op connector update production-db \
  --schedule-cron "0 2 * * *"   # daily at 2am UTC
```

## Next steps

- [App Developer Quickstart](/getting-started/app-developer) — build a UI on your data
- `op ontology --help` — full schema management commands
- `op mapping --help` — advanced mapping options including transforms
- `op data --help` — query, filter, and export entity data
