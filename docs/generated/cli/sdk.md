---
title: "op sdk"
description: "SDK code generation"
sidebar:
  order: 20
---

# `op sdk`

SDK code generation

### `generate`

Generate an ontology-typed SDK client for the current tenant

**Usage:** `generate [options]`

**Options:**

- `--out <path>` — Output file path
- `--lang <lang>` — Target language: typescript (python/go reserved) (default: `typescript`)


---

### `generate-types`

Generate TypeScript type declarations from ontology entity schemas.
Writes op-types.d.ts that augments @oneplatform/app-sdk with
EntityTypeMap entries for type-safe useQuery<EntityTypeMap["customer"]>() calls.

**Usage:** `generate-types [options]`

**Options:**

- `--out <path>` — Output file path (default: op-types.d.ts)

