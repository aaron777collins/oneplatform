---
title: CLI Reference
description: Complete reference for the op CLI — the command-line interface for OnePlatform.
sidebar:
  order: 1
---

The `op` CLI is the primary command-line interface for OnePlatform. It covers every
platform operation from initial bootstrap through day-to-day data engineering tasks.

## Installation

```sh
npm install -g @oneplatform/cli
```

## Usage

```
op <command> <subcommand> [options]
```

## Command groups

| Group | Description |
|-------|-------------|
| `op auth` | Login, logout, token management, bootstrap |
| `op connector` | Data source connectors and sync management |
| `op mapping` | Field mapping rules |
| `op data` | Query and export entity records |
| `op ontology` | Entity type and field schema management |
| `op pipeline` | Pipeline definitions |
| `op run` | Pipeline execution |
| `op app` | App lifecycle management |
| `op plugin` | Plugin installation and management |
| `op log` | Log querying and streaming |
| `op service` | Service health and administration |
| `op sdk` | SDK and type generation utilities |
| `op config` | Platform configuration |

## Global options

| Option | Description |
|--------|-------------|
| `--url <url>` | Gateway URL (default: `http://localhost:3000`) |
| `--token <token>` | Bearer token (overrides stored session) |
| `--output json` | Output as JSON instead of formatted tables |
| `--quiet` | Suppress all output except errors |
| `--help` | Show help for any command |

## Getting a token

```sh
op auth login --email admin@example.com
```

The CLI stores the access and refresh tokens in `~/.config/oneplatform/session.json`
and automatically refreshes them before expiry.

---

Full per-command documentation is generated from the CLI source and will appear in
this section after running `pnpm turbo docs:generate && pnpm docs:merge`.
