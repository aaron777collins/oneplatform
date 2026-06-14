---
title: Plugin Developer Quickstart
description: Create a OnePlatform plugin, simulate a hook locally, package it, and install it.
sidebar:
  order: 4
---

Create a OnePlatform plugin, simulate a hook locally, package it, and install it.

## Prerequisites

- OnePlatform stack running (see [Platform Admin Quickstart](/getting-started/platform-admin))
- Node.js 20+ and npm 10+
- `@oneplatform/cli` installed globally: `npm install -g @oneplatform/cli`
- Account with `plugins:manage` scope (dev-mode install does not require platform-admin)

## Setup (3 commands)

```sh
# 1. Log in
op auth login --email developer@example.com

# 2. Scaffold a new plugin (interactive prompts)
op plugin create

# 3. Enter the plugin directory and install dependencies
cd my-plugin && npm install
```

## First working example

After `op plugin create`, the interactive prompts ask for:
- **Name**: My Plugin
- **Slug**: my-plugin
- **Type**: transformer (connector, transformer, or hook)
- **Description**: Transforms records during ingestion

The scaffold creates:

```
my-plugin/
  src/
    index.ts         # Plugin entry point with hook handler
    index.test.ts    # Vitest test using mock context
  plugin.manifest.json
  tsconfig.json
  package.json
```

### Step 1: Implement a hook

Edit `src/index.ts` to add logic to the `before:ingestion.receive` hook:

```ts
import { definePlugin } from "@oneplatform/plugin-sdk";

export default definePlugin({
  hooks: {
    "before:ingestion.receive": async (event, ctx) => {
      // Normalize email to lowercase before records are stored
      if (typeof event.data.email === "string") {
        event.data.email = event.data.email.toLowerCase();
      }
      ctx.log.info("Email normalized", { email: event.data.email });
      return event;
    },
  },
});
```

### Step 2: Test the hook locally

```sh
# Build the plugin
npm run build

# Create a sample input file
cat > data.json << 'EOF'
{ "email": "CUSTOMER@Example.COM", "name": "Test User" }
EOF

# Simulate the hook without deploying
op plugin simulate-hook before:ingestion.receive --input data.json
```

Expected output:

```json
{
  "email": "customer@example.com",
  "name": "Test User"
}
```

### Step 3: Run the tests

```sh
npm test
```

Tests use `createMockContext` from `@oneplatform/plugin-sdk/testing` for isolated
unit testing without a running platform instance.

### Step 4: Package the plugin

```sh
# Creates my-plugin-1.0.0.oppkg in the current directory
npm run pack
```

The `.oppkg` file is a ZIP archive containing `dist/bundle.js` and `plugin.manifest.json`.

### Step 5: Install the plugin (dev mode)

```sh
# Install in dev mode — requires only plugins:manage scope (not platform-admin).
# Dev-mode installations are tenant-scoped and expire after 7 days.
op plugin install ./my-plugin-1.0.0.oppkg --dev
```

Expected output:

```
Installed: my-plugin v1.0.0 (dev mode — expires in 7 days)
Plugin ID: <uuid>
```

Verify the plugin is active:

```sh
op plugin list
```

## Iterating during development

```sh
# Watch mode: rebuilds on every file change
npm run dev

# Re-simulate after changes (no redeploy needed for local testing)
op plugin simulate-hook before:ingestion.receive --input data.json

# Reinstall to the platform after significant changes
op plugin install ./my-plugin-1.0.0.oppkg --dev
```

## Next steps

- `op plugin --help` — upgrade, rollback, list, and remove plugins
- [SDK Reference — plugin-sdk](/sdk/plugin-sdk) — simulate-hook internals and full plugin API
- `plugin.manifest.json` — hooks, permissions, and connector type declarations
- [App Developer Quickstart](/getting-started/app-developer) — build a UI to visualize plugin output
