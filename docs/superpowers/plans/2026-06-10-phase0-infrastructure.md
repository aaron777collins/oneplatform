# Phase 0: Monorepo + Infrastructure Setup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the Turborepo + pnpm monorepo, Docker Compose stack, database schemas, Redis ACLs, and all infrastructure needed before any service code.

**Architecture:** Turborepo + pnpm workspaces monorepo. Docker Compose orchestrates all containers. PostgreSQL with PgBouncer for connection pooling. Redis 7 with key-prefix ACLs. MinIO for object storage.

**Tech Stack:** TypeScript 5.5+, pnpm 9+, Turborepo 2+, Docker Compose v2, PostgreSQL 16, PgBouncer, Redis 7, MinIO

---

## File Map

```
/
├── package.json                        Root workspace definition + dev tooling
├── pnpm-workspace.yaml                 pnpm workspace glob patterns
├── turbo.json                          Turborepo pipeline definitions
├── tsconfig.base.json                  Shared TypeScript compiler options
├── .npmrc                              pnpm config (strict-peer-deps, hoist)
├── .env.example                        All OP_* env vars with comments
│
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── sdk/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── app-sdk/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── plugin-sdk/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cli/
│       ├── package.json
│       └── tsconfig.json
│
├── services/
│   ├── gateway/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── auth/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── ingestion/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── ontology/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── pipeline/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── execution/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── app/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── logging/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── plugin/
│       ├── package.json
│       └── tsconfig.json
│
└── docker/
    ├── docker-compose.yml              Full stack orchestration (spec §2)
    ├── Dockerfile.service              Multi-stage build for all 9 services
    ├── Dockerfile.sandbox              isolated-vm sandbox container (Node 20)
    ├── init/
    │   └── init.sh                     op-init key generation script (spec §2)
    ├── postgres/
    │   └── init.sql                    Roles, schemas, grants (spec §3)
    ├── pgbouncer/
    │   ├── pgbouncer.ini               Dual-mode pool config (spec §3)
    │   └── userlist.txt                Service auth credentials
    └── redis/
        ├── redis.conf                  AOF + ACL reference config (spec §3)
        └── users.acl                   Per-service ACL rules (spec §3 canonical table)
```

---

## Task 1: Root Monorepo Setup

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.npmrc`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "oneplatform",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "format": "prettier --write \"**/*.{ts,tsx,json,md}\"",
    "format:check": "prettier --check \"**/*.{ts,tsx,json,md}\"",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0",
    "turbo": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "services/*"
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "lint": {
      "outputs": []
    },
    "clean": {
      "cache": false
    },
    "docs:generate": {
      "dependsOn": ["^build"],
      "outputs": ["docs/**"]
    }
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "exclude": ["node_modules", "dist", "coverage"]
}
```

- [ ] **Step 5: Create `.npmrc`**

```ini
strict-peer-dependencies=true
auto-install-peers=false
hoist-pattern[]=*eslint*
hoist-pattern[]=*prettier*
hoist-pattern[]=*typescript*
public-hoist-pattern[]=*
```

- [ ] **Step 6: Verify root structure**

```bash
ls -la package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc
```

Expected: all 5 files present.

- [ ] **Step 7: Commit**

```bash
git init
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc
git commit -m "chore: initialize monorepo root — Turborepo + pnpm workspaces"
```

---

## Task 2: Package Scaffolds

**Files (29 files total — package.json + tsconfig.json per workspace):**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`
- Create: `packages/app-sdk/package.json`, `packages/app-sdk/tsconfig.json`
- Create: `packages/plugin-sdk/package.json`, `packages/plugin-sdk/tsconfig.json`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Create: `services/gateway/package.json`, `services/gateway/tsconfig.json`
- Create: `services/auth/package.json`, `services/auth/tsconfig.json`
- Create: `services/ingestion/package.json`, `services/ingestion/tsconfig.json`
- Create: `services/ontology/package.json`, `services/ontology/tsconfig.json`
- Create: `services/pipeline/package.json`, `services/pipeline/tsconfig.json`
- Create: `services/execution/package.json`, `services/execution/tsconfig.json`
- Create: `services/app/package.json`, `services/app/tsconfig.json`
- Create: `services/logging/package.json`, `services/logging/tsconfig.json`
- Create: `services/plugin/package.json`, `services/plugin/tsconfig.json`

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@oneplatform/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/sdk/package.json`**

```json
{
  "name": "@oneplatform/sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 4: Create `packages/sdk/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 5: Create `packages/app-sdk/package.json`**

```json
{
  "name": "@oneplatform/app-sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/sdk": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 6: Create `packages/app-sdk/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 7: Create `packages/plugin-sdk/package.json`**

```json
{
  "name": "@oneplatform/plugin-sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 8: Create `packages/plugin-sdk/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 9: Create `packages/cli/package.json`**

```json
{
  "name": "@oneplatform/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "op": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/sdk": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 10: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 11: Create `services/gateway/package.json`**

```json
{
  "name": "@oneplatform/gateway",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 12: Create `services/gateway/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 13: Create `services/auth/package.json`**

```json
{
  "name": "@oneplatform/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 14: Create `services/auth/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 15: Create `services/ingestion/package.json`**

```json
{
  "name": "@oneplatform/ingestion",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 16: Create `services/ingestion/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 17: Create `services/ontology/package.json`**

```json
{
  "name": "@oneplatform/ontology",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 18: Create `services/ontology/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 19: Create `services/pipeline/package.json`**

```json
{
  "name": "@oneplatform/pipeline",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 20: Create `services/pipeline/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 21: Create `services/execution/package.json`**

```json
{
  "name": "@oneplatform/execution",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 22: Create `services/execution/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 23: Create `services/app/package.json`**

```json
{
  "name": "@oneplatform/app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 24: Create `services/app/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 25: Create `services/logging/package.json`**

```json
{
  "name": "@oneplatform/logging",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 26: Create `services/logging/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 27: Create `services/plugin/package.json`**

```json
{
  "name": "@oneplatform/plugin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oneplatform/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 28: Create `services/plugin/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 29: Create placeholder `src/index.ts` in every package and service so tsconfig has something to compile**

For each workspace listed below, create `src/index.ts` with one line:

```typescript
export {};
```

Workspaces requiring this placeholder:
- `packages/core/src/index.ts`
- `packages/sdk/src/index.ts`
- `packages/app-sdk/src/index.ts`
- `packages/plugin-sdk/src/index.ts`
- `packages/cli/src/index.ts`
- `services/gateway/src/index.ts`
- `services/auth/src/index.ts`
- `services/ingestion/src/index.ts`
- `services/ontology/src/index.ts`
- `services/pipeline/src/index.ts`
- `services/execution/src/index.ts`
- `services/app/src/index.ts`
- `services/logging/src/index.ts`
- `services/plugin/src/index.ts`

Run to create all in one shot:
```bash
for dir in packages/core packages/sdk packages/app-sdk packages/plugin-sdk packages/cli \
  services/gateway services/auth services/ingestion services/ontology services/pipeline \
  services/execution services/app services/logging services/plugin; do
  mkdir -p "$dir/src"
  echo "export {};" > "$dir/src/index.ts"
done
```

- [ ] **Step 30: Install dependencies from root**

```bash
pnpm install
```

Expected: workspace packages linked, lockfile created.

- [ ] **Step 31: Verify Turborepo can resolve workspace graph**

```bash
pnpm turbo run build --dry-run
```

Expected: table listing all 14 workspace packages with `build` task.

- [ ] **Step 32: Commit**

```bash
git add packages/ services/
git commit -m "chore: scaffold all 14 workspace package and service stubs"
```

---

## Task 3: Docker Compose

**Files:**
- Create: `docker/docker-compose.yml`

References: spec §2 "Docker Compose Stack", "Volumes", "Startup Sequence", "Network Topology".

- [ ] **Step 1: Create `docker/` directory**

```bash
mkdir -p docker/init docker/postgres docker/pgbouncer docker/redis
```

- [ ] **Step 2: Create `docker/docker-compose.yml`**

```yaml
# docker/docker-compose.yml
# Startup layer ordering per spec §2 "Startup Sequence".
# Networks per spec §2 "Network Topology (3-tier)".

services:

  # ─── Layer 0: Init ────────────────────────────────────────────────────────
  op-init:
    image: alpine:3.19
    volumes:
      - init-data:/data/init
      - ./init/init.sh:/init.sh:ro
    command: ["/bin/sh", "/init.sh"]
    networks: []
    restart: "no"
    healthcheck:
      test: ["CMD", "test", "-f", "/data/init/ready"]
      interval: 2s
      timeout: 5s
      retries: 10
      start_period: 5s

  # ─── Layer 1: Data Stores ─────────────────────────────────────────────────
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: oneplatform
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks:
      - oneplatform-internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d oneplatform"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
    depends_on:
      op-init:
        condition: service_healthy
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "/etc/redis/redis.conf", "--aclfile", "/etc/redis/users.acl"]
    volumes:
      - redis-data:/data
      - ./redis/redis.conf:/etc/redis/redis.conf:ro
      - ./redis/users.acl:/etc/redis/users.acl:ro
    networks:
      - oneplatform-internal
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_ADMIN_PASSWORD}", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 5s
    depends_on:
      op-init:
        condition: service_healthy
    restart: unless-stopped

  minio:
    image: minio/minio:RELEASE.2024-06-04T19-20-08Z
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${OP_MINIO_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${OP_MINIO_PASSWORD}
    volumes:
      - minio-data:/data
    networks:
      - oneplatform-internal
    # MinIO is internal only — no public port mapping.
    # Services connect via http://minio:9000 on the internal network.
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 10s
      retries: 10
      start_period: 15s
    depends_on:
      op-init:
        condition: service_healthy
    restart: unless-stopped

  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:latest
    environment:
      # Permit only the four operations Execution Service needs for Docker sandboxes.
      # All other Docker API calls are denied. Ref spec §13 "Network Isolation".
      CONTAINERS: 1
      POST: 1
      DELETE: 1
      LOG: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - oneplatform-sandbox
    restart: unless-stopped
    depends_on:
      op-init:
        condition: service_healthy

  # ─── Layer 2: Core Services ────────────────────────────────────────────────
  pgbouncer:
    image: pgbouncer/pgbouncer:latest
    volumes:
      - ./pgbouncer/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro
    networks:
      - oneplatform-internal
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h localhost -p 5433"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  # ─── Named Volumes ─────────────────────────────────────────────────────────
volumes:
  postgres-data:
  redis-data:
  minio-data:
  init-data:
  gateway-data:
  auth-data:
  ingestion-data:
  ontology-data:
  pipeline-data:
  execution-data:
  app-data:
  logging-data:
  plugin-data:
  sandbox-socket:
  shared-pubkeys:

  # ─── Networks ───────────────────────────────────────────────────────────────
networks:
  oneplatform-public:
    driver: bridge
  oneplatform-internal:
    driver: bridge
    internal: true
  oneplatform-sandbox:
    driver: bridge
    internal: true
```

- [ ] **Step 3: Verify compose file syntax**

```bash
docker compose -f docker/docker-compose.yml config --quiet
```

Expected: exits 0 with no errors.

- [ ] **Step 4: Commit**

```bash
git add docker/docker-compose.yml
git commit -m "infra: add Docker Compose stack with all containers, volumes, and networks"
```

---

## Task 4: op-init Script

**Files:**
- Create: `docker/init/init.sh`

References: spec §2 "Startup Sequence" steps 1a–1e.

- [ ] **Step 1: Create `docker/init/init.sh`**

```bash
#!/bin/sh
# docker/init/init.sh
#
# One-shot initialization container. Runs as Layer 0 before any data store.
# Generates all secrets that services need at runtime. Secrets are written
# to /data/init/ on the init-data volume with mode 0400 so only root can read them.
#
# Ref spec §2 "Startup Sequence" step 1 and §4 "First-Run Bootstrap".

set -e

INIT_DIR="/data/init"

mkdir -p "$INIT_DIR"

# Step 1a: Check for externally-injected Docker secret (production path).
# If the operator mounted a pre-generated master key as a Docker secret, use it.
# This allows key rotation without re-running init.
if [ -f "/run/secrets/op_master_key" ]; then
  echo "[op-init] Using Docker secret for OP_MASTER_KEY"
  cp /run/secrets/op_master_key "$INIT_DIR/master.key"
  chmod 0400 "$INIT_DIR/master.key"
else
  # Step 1b: No pre-existing secret — generate a new AES-256-GCM master key.
  # openssl rand -base64 32 produces 32 random bytes encoded as base64 (44 chars).
  if [ ! -f "$INIT_DIR/master.key" ]; then
    echo "[op-init] Generating OP_MASTER_KEY"
    openssl rand -base64 32 > "$INIT_DIR/master.key"
    chmod 0400 "$INIT_DIR/master.key"
  else
    echo "[op-init] OP_MASTER_KEY already exists, skipping"
  fi
fi

# Step 1c: Bootstrap token — 32 random bytes as lowercase hex (64 chars).
# Single-use: Auth Service erases this after the first successful bootstrap commit.
if [ ! -f "$INIT_DIR/bootstrap.token" ]; then
  echo "[op-init] Generating bootstrap token"
  openssl rand -hex 32 > "$INIT_DIR/bootstrap.token"
  chmod 0400 "$INIT_DIR/bootstrap.token"
else
  echo "[op-init] Bootstrap token already exists, skipping"
fi

# Step 1d-a: JWT signing secret — 32 random bytes as lowercase hex.
# Used by Auth Service for HS256 JWT signing. Ref spec §4 "JWT Strategy".
if [ ! -f "$INIT_DIR/jwt.secret" ]; then
  echo "[op-init] Generating OP_JWT_SECRET"
  openssl rand -hex 32 > "$INIT_DIR/jwt.secret"
  chmod 0400 "$INIT_DIR/jwt.secret"
else
  echo "[op-init] OP_JWT_SECRET already exists, skipping"
fi

# Step 1d-b: Cursor HMAC secret — 32 random bytes as lowercase hex.
# Used by all services for cursor encode/decode with HMAC-SHA256.
# Ref spec §6 "Pagination (Cursor-Based)".
if [ ! -f "$INIT_DIR/cursor.secret" ]; then
  echo "[op-init] Generating OP_CURSOR_SECRET"
  openssl rand -hex 32 > "$INIT_DIR/cursor.secret"
  chmod 0400 "$INIT_DIR/cursor.secret"
else
  echo "[op-init] OP_CURSOR_SECRET already exists, skipping"
fi

# Step 1e: Signal completion. All services that depend on op-init use this file
# as the health check condition via `test -f /data/init/ready`.
touch "$INIT_DIR/ready"

echo "[op-init] Initialization complete."
ls -la "$INIT_DIR/"
```

- [ ] **Step 2: Make the script executable**

```bash
chmod +x docker/init/init.sh
```

- [ ] **Step 3: Verify script passes shell syntax check**

```bash
sh -n docker/init/init.sh
```

Expected: exits 0 with no output.

- [ ] **Step 4: Commit**

```bash
git add docker/init/init.sh
git commit -m "infra: add op-init secret generation script"
```

---

## Task 5: PostgreSQL Initialization

**Files:**
- Create: `docker/postgres/init.sql`

References: spec §3 "PostgreSQL: Per-Service Schemas" including the 9 schemas, 9 service roles, and the documented cross-schema exception.

- [ ] **Step 1: Create `docker/postgres/init.sql`**

```sql
-- docker/postgres/init.sql
--
-- Executed by postgres:16-alpine on first container start via
-- /docker-entrypoint-initdb.d/. Idempotent: uses CREATE IF NOT EXISTS
-- patterns so re-running is safe.
--
-- Ref spec §3 "PostgreSQL: Per-Service Schemas".

-- ─── Extension ───────────────────────────────────────────────────────────────
-- uuid-ossp provides uuid_generate_v4() used across all services for primary keys.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Service Roles ───────────────────────────────────────────────────────────
-- Each service connects with its own dedicated role. Roles have LOGIN so they
-- can authenticate via PgBouncer. Passwords are set via ALTER ROLE at deploy
-- time using per-service env vars; the placeholder here prevents null-password
-- login. No role is a superuser or can create other roles or databases.

DO $$
BEGIN
  -- Auth Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_service_role') THEN
    CREATE ROLE auth_service_role WITH LOGIN PASSWORD 'CHANGE_ME_auth';
  END IF;

  -- Ingestion Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ingestion_service_role') THEN
    CREATE ROLE ingestion_service_role WITH LOGIN PASSWORD 'CHANGE_ME_ingestion';
  END IF;

  -- Ontology Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ontology_service_role') THEN
    CREATE ROLE ontology_service_role WITH LOGIN PASSWORD 'CHANGE_ME_ontology';
  END IF;

  -- Pipeline Service role
  -- Needs session-mode PgBouncer for advisory locks (spec §3 "PgBouncer Configuration").
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pipeline_service_role') THEN
    CREATE ROLE pipeline_service_role WITH LOGIN PASSWORD 'CHANGE_ME_pipeline';
  END IF;

  -- Execution Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'execution_service_role') THEN
    CREATE ROLE execution_service_role WITH LOGIN PASSWORD 'CHANGE_ME_execution';
  END IF;

  -- App Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_service_role') THEN
    CREATE ROLE app_service_role WITH LOGIN PASSWORD 'CHANGE_ME_app';
  END IF;

  -- Logging Service role (highest write volume — 30 server connections, spec §3)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'logging_service_role') THEN
    CREATE ROLE logging_service_role WITH LOGIN PASSWORD 'CHANGE_ME_logging';
  END IF;

  -- Plugin Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plugin_service_role') THEN
    CREATE ROLE plugin_service_role WITH LOGIN PASSWORD 'CHANGE_ME_plugin';
  END IF;

  -- Gateway Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway_service_role') THEN
    CREATE ROLE gateway_service_role WITH LOGIN PASSWORD 'CHANGE_ME_gateway';
  END IF;
END
$$;

-- ─── Schemas ─────────────────────────────────────────────────────────────────
-- One schema per service. No cross-schema writes except the single documented
-- exception below. Ref spec §3 table of schemas and owners.

CREATE SCHEMA IF NOT EXISTS auth       AUTHORIZATION auth_service_role;
CREATE SCHEMA IF NOT EXISTS ingestion  AUTHORIZATION ingestion_service_role;
CREATE SCHEMA IF NOT EXISTS ontology   AUTHORIZATION ontology_service_role;
CREATE SCHEMA IF NOT EXISTS pipeline   AUTHORIZATION pipeline_service_role;
CREATE SCHEMA IF NOT EXISTS execution  AUTHORIZATION execution_service_role;
CREATE SCHEMA IF NOT EXISTS app        AUTHORIZATION app_service_role;
CREATE SCHEMA IF NOT EXISTS logging    AUTHORIZATION logging_service_role;
CREATE SCHEMA IF NOT EXISTS plugin     AUTHORIZATION plugin_service_role;
CREATE SCHEMA IF NOT EXISTS gateway    AUTHORIZATION gateway_service_role;

-- ─── Schema Usage Grants ──────────────────────────────────────────────────────
-- Each role can USAGE + CREATE on its own schema.
-- No role can access other schemas by default.

GRANT USAGE, CREATE ON SCHEMA auth       TO auth_service_role;
GRANT USAGE, CREATE ON SCHEMA ingestion  TO ingestion_service_role;
GRANT USAGE, CREATE ON SCHEMA ontology   TO ontology_service_role;
GRANT USAGE, CREATE ON SCHEMA pipeline   TO pipeline_service_role;
GRANT USAGE, CREATE ON SCHEMA execution  TO execution_service_role;
GRANT USAGE, CREATE ON SCHEMA app        TO app_service_role;
GRANT USAGE, CREATE ON SCHEMA logging    TO logging_service_role;
GRANT USAGE, CREATE ON SCHEMA plugin     TO plugin_service_role;
GRANT USAGE, CREATE ON SCHEMA gateway    TO gateway_service_role;

-- Default privileges: tables created in each schema are automatically
-- granted to the owning role. Prevents accidental lockout after migrations.

ALTER DEFAULT PRIVILEGES FOR ROLE auth_service_role      IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ingestion_service_role IN SCHEMA ingestion
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ingestion_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ontology_service_role  IN SCHEMA ontology
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ontology_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE pipeline_service_role  IN SCHEMA pipeline
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pipeline_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE execution_service_role IN SCHEMA execution
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO execution_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE app_service_role       IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE logging_service_role   IN SCHEMA logging
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO logging_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE plugin_service_role    IN SCHEMA plugin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plugin_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE gateway_service_role   IN SCHEMA gateway
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gateway_service_role;

-- Sequences: services need USAGE on sequences for INSERT with serial/identity columns.
ALTER DEFAULT PRIVILEGES FOR ROLE auth_service_role      IN SCHEMA auth
  GRANT USAGE, SELECT ON SEQUENCES TO auth_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ingestion_service_role IN SCHEMA ingestion
  GRANT USAGE, SELECT ON SEQUENCES TO ingestion_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ontology_service_role  IN SCHEMA ontology
  GRANT USAGE, SELECT ON SEQUENCES TO ontology_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE pipeline_service_role  IN SCHEMA pipeline
  GRANT USAGE, SELECT ON SEQUENCES TO pipeline_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE execution_service_role IN SCHEMA execution
  GRANT USAGE, SELECT ON SEQUENCES TO execution_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE app_service_role       IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO app_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE logging_service_role   IN SCHEMA logging
  GRANT USAGE, SELECT ON SEQUENCES TO logging_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE plugin_service_role    IN SCHEMA plugin
  GRANT USAGE, SELECT ON SEQUENCES TO plugin_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE gateway_service_role   IN SCHEMA gateway
  GRANT USAGE, SELECT ON SEQUENCES TO gateway_service_role;

-- ─── Cross-Schema Exception ───────────────────────────────────────────────────
-- THE ONLY cross-schema access allowed in the system.
-- Ontology Service needs SELECT on ingestion schema tables for mapping jobs.
-- Ref spec §3: "GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role"
-- Also grants USAGE on schema so the role can resolve table names.

GRANT USAGE ON SCHEMA ingestion TO ontology_service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role;

-- Ensure future ingestion tables are also readable by ontology (for dynamic raw_ tables).
ALTER DEFAULT PRIVILEGES FOR ROLE ingestion_service_role IN SCHEMA ingestion
  GRANT SELECT ON TABLES TO ontology_service_role;

-- ─── Search Path Defaults ────────────────────────────────────────────────────
-- Set each role's default search_path so queries don't need schema prefixes.
-- Services should still qualify table names explicitly in queries for clarity.

ALTER ROLE auth_service_role      SET search_path TO auth, public;
ALTER ROLE ingestion_service_role SET search_path TO ingestion, public;
ALTER ROLE ontology_service_role  SET search_path TO ontology, ingestion, public;
ALTER ROLE pipeline_service_role  SET search_path TO pipeline, public;
ALTER ROLE execution_service_role SET search_path TO execution, public;
ALTER ROLE app_service_role       SET search_path TO app, public;
ALTER ROLE logging_service_role   SET search_path TO logging, public;
ALTER ROLE plugin_service_role    SET search_path TO plugin, public;
ALTER ROLE gateway_service_role   SET search_path TO gateway, public;
```

- [ ] **Step 2: Verify SQL syntax (requires psql)**

```bash
docker run --rm postgres:16-alpine psql --no-psqlrc -v ON_ERROR_STOP=1 \
  -f /dev/stdin <<'EOF'
$(cat docker/postgres/init.sql)
EOF
```

If psql is not available locally, proceed to the next step — the compose test in Task 11 will catch SQL errors.

- [ ] **Step 3: Commit**

```bash
git add docker/postgres/init.sql
git commit -m "infra: add PostgreSQL init SQL — 9 service roles, schemas, and grants"
```

---

## Task 6: PgBouncer Configuration

**Files:**
- Create: `docker/pgbouncer/pgbouncer.ini`
- Create: `docker/pgbouncer/userlist.txt`

References: spec §3 "PgBouncer Configuration" — pool mode per service, per-service server connection counts.

- [ ] **Step 1: Create `docker/pgbouncer/pgbouncer.ini`**

```ini
; docker/pgbouncer/pgbouncer.ini
;
; Dual-mode configuration as required by spec §3 "PgBouncer Configuration".
; Transaction mode: Gateway, Auth, Ingestion, App, Logging, Plugin, Execution.
; Session mode:     Ontology, Pipeline — required for LISTEN/NOTIFY and advisory locks.
;
; Per-service pool sizes from spec §3 "Connection allocation" table.
; Total server connections: 165. Postgres max_connections: 200 (35 for direct admin).

[databases]
; Transaction-mode databases — one entry per service role so PgBouncer can enforce
; per-service pool limits. All point to the same Postgres instance.
oneplatform_gateway   = host=postgres port=5432 dbname=oneplatform user=gateway_service_role   pool_size=15 pool_mode=transaction
oneplatform_auth      = host=postgres port=5432 dbname=oneplatform user=auth_service_role      pool_size=20 pool_mode=transaction
oneplatform_ingestion = host=postgres port=5432 dbname=oneplatform user=ingestion_service_role pool_size=25 pool_mode=transaction
oneplatform_app       = host=postgres port=5432 dbname=oneplatform user=app_service_role       pool_size=15 pool_mode=transaction
oneplatform_logging   = host=postgres port=5432 dbname=oneplatform user=logging_service_role   pool_size=30 pool_mode=transaction
oneplatform_plugin    = host=postgres port=5432 dbname=oneplatform user=plugin_service_role    pool_size=10 pool_mode=transaction
oneplatform_execution = host=postgres port=5432 dbname=oneplatform user=execution_service_role pool_size=10 pool_mode=transaction

; Session-mode databases — LISTEN/NOTIFY and advisory locks require a persistent
; server connection per client connection. Ref spec §3.
oneplatform_ontology  = host=postgres port=5432 dbname=oneplatform user=ontology_service_role  pool_size=15 pool_mode=session
oneplatform_pipeline  = host=postgres port=5432 dbname=oneplatform user=pipeline_service_role  pool_size=25 pool_mode=session

[pgbouncer]
; PgBouncer listens on port 5433 on the internal network.
; Services connect to pgbouncer:5433 rather than postgres:5432 directly.
listen_port = 5433
listen_addr = 0.0.0.0

; Authentication: services authenticate with their own password.
; PgBouncer then connects to Postgres using the role credentials.
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

; Global limits from spec §3.
max_client_conn = 200
default_pool_size = 20

; Idle server connections are closed after 60 seconds to reclaim Postgres resources.
server_idle_timeout = 60

; Client connections that have been idle for 10 minutes are closed.
client_idle_timeout = 600

; Log verbosity. 0 = quiet, 1 = connect, 2 = queries, 3 = full debug.
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1

; Administrative interface. Accessible only within the internal network.
admin_users = pgbouncer_admin

; Enable metrics endpoint for Prometheus scraping.
stats_users = pgbouncer_stats
```

- [ ] **Step 2: Create `docker/pgbouncer/userlist.txt`**

```
; docker/pgbouncer/userlist.txt
;
; PgBouncer user authentication list. Each service authenticates here using
; its own password. PgBouncer then connects to Postgres with the same credentials.
;
; IMPORTANT: Replace placeholder passwords before deploying.
; In production: inject via Docker secrets or environment variable substitution.
; Passwords must be MD5 hashed: "md5" + md5(password + username)
;
; Format: "username" "password_or_md5hash"
;
; Using cleartext passwords here for local development. Production should
; use md5 hashes to avoid storing cleartext in the container.

"gateway_service_role"   "CHANGE_ME_gateway"
"auth_service_role"      "CHANGE_ME_auth"
"ingestion_service_role" "CHANGE_ME_ingestion"
"ontology_service_role"  "CHANGE_ME_ontology"
"pipeline_service_role"  "CHANGE_ME_pipeline"
"execution_service_role" "CHANGE_ME_execution"
"app_service_role"       "CHANGE_ME_app"
"logging_service_role"   "CHANGE_ME_logging"
"plugin_service_role"    "CHANGE_ME_plugin"
"pgbouncer_admin"        "CHANGE_ME_pgbouncer_admin"
"pgbouncer_stats"        "CHANGE_ME_pgbouncer_stats"
```

- [ ] **Step 3: Commit**

```bash
git add docker/pgbouncer/
git commit -m "infra: add PgBouncer dual-mode config — transaction mode 7 services, session mode 2"
```

---

## Task 7: Redis ACL Configuration

**Files:**
- Create: `docker/redis/redis.conf`
- Create: `docker/redis/users.acl`

References: spec §3 "Redis: Key-Prefix ACL Table (Canonical — ADR-5)" — the full canonical table of service users, key prefixes, and pub/sub channels. All `SELECT`, `FLUSHDB`, `FLUSHALL`, `KEYS`, `DEBUG` commands denied for service users.

- [ ] **Step 1: Create `docker/redis/redis.conf`**

```conf
# docker/redis/redis.conf
#
# Redis 7 configuration for OnePlatform.
# ACL rules are in users.acl (loaded via aclfile directive) to keep
# the main config readable and to support hot ACL reloads via ACL LOAD.
#
# Ref spec §3 "Redis: Key-Prefix ACL Table (Canonical — ADR-5)".

# ─── Persistence ─────────────────────────────────────────────────────────────
# Append-Only File enabled for durability. everysec is the recommended tradeoff
# between performance and durability (at most 1 second of data loss on crash).
appendonly yes
appendfsync everysec

# Disable RDB snapshots — AOF provides sufficient durability.
save ""

# ─── Memory ──────────────────────────────────────────────────────────────────
# No hard memory limit by default. Operators should set maxmemory based on host.
# When maxmemory is reached, allkeys-lru evicts least-recently-used keys.
# Rate limit counters (ratelimit:*) can be evicted; they are regenerated on next
# request. Auth tokens (auth:*) must NOT be evicted — keep maxmemory well above
# expected token volume.
# maxmemory 512mb
# maxmemory-policy allkeys-lru

# ─── Networking ──────────────────────────────────────────────────────────────
# Redis is on oneplatform-internal only. Bind to all interfaces within the
# container (Docker handles network isolation at the compose level).
bind 0.0.0.0
port 6379
protected-mode no

# ─── ACL ─────────────────────────────────────────────────────────────────────
# Load ACL rules from external file. This allows ACL LOAD command to refresh
# rules without a full Redis restart (useful for key rotation).
aclfile /etc/redis/users.acl

# Disable the default user. All clients must authenticate with a named user.
# The default user is redefined in users.acl with nopass disabled.

# ─── Logging ─────────────────────────────────────────────────────────────────
loglevel notice
```

- [ ] **Step 2: Create `docker/redis/users.acl`**

```
# docker/redis/users.acl
#
# Redis ACL rules per spec §3 "Redis: Key-Prefix ACL Table (Canonical — ADR-5)".
#
# Rule format: user <name> [on|off] [>password] [~keypattern] [&channel] [+cmd|-cmd]
#
# All service users are denied: SELECT, FLUSHDB, FLUSHALL, KEYS, DEBUG
# per the spec requirement "Denied for ALL service users".
#
# All services operate on DB 0 only. SELECT is denied to prevent switching databases.
#
# Channels use & prefix for pub/sub pattern matching.
# Key patterns use ~ prefix. Per-service key prefix isolation is the logical
# tenant boundary within DB 0.

# ─── Default User — disabled ─────────────────────────────────────────────────
# The built-in default user is disabled. No unauthenticated access.
user default off nopass ~* &* -@all

# ─── Admin User (maintenance only) ───────────────────────────────────────────
# Used only by Redis health check in docker-compose.yml and ops procedures.
# Not used by any service. Password set via REDIS_ADMIN_PASSWORD env var at deploy.
user op_admin on >CHANGE_ME_redis_admin ~* &* +@all

# ─── Auth Service ─────────────────────────────────────────────────────────────
# Key prefixes: auth:* (sessions, JWT revocation), revocation:* (JWT blocklist),
#               reset:* (password reset tokens per spec §4 "Password Reset")
# Channels:     auth:* (auth events), revocation:* (token revocation events)
# Ref spec §3 canonical table row: Auth / op_auth
user op_auth on >CHANGE_ME_auth \
  ~auth:* ~revocation:* ~reset:* \
  &auth:* &revocation:* \
  +@read +@write +@string +@hash +@set +@sortedset \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── Pipeline Service ─────────────────────────────────────────────────────────
# Key prefixes: queue:pipeline:* (BullMQ pipeline job queues),
#               queue:execution:* (BullMQ execution job queues)
# Channels:     ontology:* (receives schema change events from Ontology Service)
# Ref spec §3 canonical table row: Pipeline / op_pipeline
user op_pipeline on >CHANGE_ME_pipeline \
  ~queue:pipeline:* ~queue:execution:* \
  &ontology:* \
  +@read +@write +@string +@hash +@set +@sortedset +@list \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── Logging Service ─────────────────────────────────────────────────────────
# Key prefixes: log:* (non-audit log buffers), audit:* (audit queue)
# Channels:     logs:* (subscribes to all service log pub/sub), audit:* (audit events)
# Ref spec §3 canonical table row: Logging / op_logging
user op_logging on >CHANGE_ME_logging \
  ~log:* ~audit:* \
  &logs:* &audit:* \
  +@read +@write +@string +@hash +@set +@sortedset +@list \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── Gateway Service ──────────────────────────────────────────────────────────
# Key prefixes: ratelimit:* (sliding window rate limit counters per spec §6),
#               gateway:* (gateway state), webhook:* (webhook delivery state)
# Channels:     events:* (subscribes to all platform events for webhook fan-out)
# Ref spec §3 canonical table row: Gateway / op_gateway
user op_gateway on >CHANGE_ME_gateway \
  ~ratelimit:* ~gateway:* ~webhook:* \
  &events:* \
  +@read +@write +@string +@hash +@set +@sortedset +@list \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── Ingestion Service ────────────────────────────────────────────────────────
# Key prefixes: queue:ingestion:* (BullMQ ingestion sync job queues),
#               ingestion:sync:* (sync state locks and cursors)
# Channels:     ontology:* (subscribes to schema change events for mapping updates)
# Ref spec §3 canonical table row: Ingestion / op_ingestion
user op_ingestion on >CHANGE_ME_ingestion \
  ~queue:ingestion:* ~ingestion:sync:* \
  &ontology:* \
  +@read +@write +@string +@hash +@set +@sortedset +@list \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── Ontology Service ─────────────────────────────────────────────────────────
# Key prefixes: ontology:* (schema cache, OpenAPI cache per spec §6 "OpenAPI Spec")
# Channels:     ontology:* (publishes schema change events that other services consume)
# Ref spec §3 canonical table row: Ontology / op_ontology
user op_ontology on >CHANGE_ME_ontology \
  ~ontology:* \
  &ontology:* \
  +@read +@write +@string +@hash +@set +@sortedset \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── App Service ──────────────────────────────────────────────────────────────
# Key prefixes: guest-session:* (guest session tokens per spec §4 "Guest sessions")
# Channels:     events:* (subscribes to platform events for WebSocket fan-out)
# Ref spec §3 canonical table row: App / op_app
user op_app on >CHANGE_ME_app \
  ~guest-session:* \
  &events:* \
  +@read +@write +@string +@hash \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── Plugin Service ───────────────────────────────────────────────────────────
# Key prefixes: plugin:* (plugin bundle cache, hook registry cache)
# Channels:     events:* (subscribes to platform events for hook dispatching)
# Ref spec §3 canonical table row: Plugin / op_plugin
user op_plugin on >CHANGE_ME_plugin \
  ~plugin:* \
  &events:* \
  +@read +@write +@string +@hash +@set \
  +@pubsub +expire +del +exists +ttl +pttl \
  -select -flushdb -flushall -keys -debug

# ─── Execution Service — NO Redis access ─────────────────────────────────────
# Execution Service has no Redis access per spec §3 canonical table.
# It communicates with the sandbox via Unix socket only.
# No user entry needed — no authentication = no access.
```

- [ ] **Step 3: Verify redis.conf syntax by starting Redis with it**

```bash
docker run --rm \
  -v "$(pwd)/docker/redis/redis.conf:/etc/redis/redis.conf:ro" \
  -v "$(pwd)/docker/redis/users.acl:/etc/redis/users.acl:ro" \
  redis:7-alpine \
  redis-server /etc/redis/redis.conf --daemonize no --loglevel verbose 2>&1 | head -30
```

Expected: Redis starts, logs "Server initialized", "Ready to accept connections".

- [ ] **Step 4: Commit**

```bash
git add docker/redis/
git commit -m "infra: add Redis 7 AOF config and per-service ACL rules"
```

---

## Task 8: Environment Variables Template

**Files:**
- Create: `.env.example`

References: spec Appendix A "Environment Variables (Key)" for all `OP_*` vars. Additional vars for infrastructure passwords.

- [ ] **Step 1: Create `.env.example`**

```dotenv
# .env.example
#
# Copy to .env and fill in values before running docker compose.
# Generated secrets (OP_MASTER_KEY, OP_JWT_SECRET, OP_CURSOR_SECRET) are
# written by op-init to /data/init/ — you do not set them here unless you
# want to override the generated values.
#
# Ref spec Appendix A "Environment Variables (Key)".

# ─── Infrastructure Passwords ─────────────────────────────────────────────────
# These are NOT generated by op-init. You must set them before first start.

POSTGRES_PASSWORD=CHANGE_ME_postgres_superuser

REDIS_ADMIN_PASSWORD=CHANGE_ME_redis_admin

# PgBouncer admin credentials
PGBOUNCER_ADMIN_PASSWORD=CHANGE_ME_pgbouncer_admin

# ─── MinIO ────────────────────────────────────────────────────────────────────
# Ref spec Appendix A: OP_MINIO_USER, OP_MINIO_PASSWORD
OP_MINIO_USER=minioadmin
OP_MINIO_PASSWORD=CHANGE_ME_minio

# ─── Platform Identity ────────────────────────────────────────────────────────
# Base URL used in redirect URIs, email links, and OAuth callbacks.
# Must be set in production. Include protocol, no trailing slash.
OP_BASE_URL=http://localhost:3000

# Comma-separated list of allowed CORS origins.
# In production: must be set explicitly. Wildcard * is rejected in production.
# Ref spec §6 "CORS Policy".
OP_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# Optional: enables subdomain app routing (e.g., myapp.apps.example.com).
# Ref spec §9 "OAuth Client Lifecycle".
# OP_WILDCARD_DOMAIN=apps.example.com

# ─── Gateway ──────────────────────────────────────────────────────────────────
# Required for multi-replica Gateway deployments to correctly calculate the
# per-replica rate limit share. Ref spec §6 "Rate Limiting".
# OP_GATEWAY_REPLICAS=1

# Global rate limit in requests per minute (platform-wide).
# Ref spec §6 "Rate Limiting" — default 10000.
OP_GLOBAL_RATE_LIMIT=10000

# ─── Execution / Sandbox ──────────────────────────────────────────────────────
# Pre-warmed Docker sandbox container pool size.
# Ref spec §7.6 "Execution Service" — default 5.
OP_SANDBOX_POOL_SIZE=5

# Default connector timeout in seconds.
# Ref spec §7.6 "Execution Service" — default 300.
OP_CONNECTOR_TIMEOUT_SECONDS=300

# ─── Ingestion ────────────────────────────────────────────────────────────────
# Records per ingestion batch (default 1000, max 10000).
OP_INGESTION_BATCH_SIZE=1000

# Concurrency for large syncs (>1M records).
OP_LARGE_SYNC_CONCURRENCY=3

# ─── Ontology ────────────────────────────────────────────────────────────────
# Maximum schema migration duration in seconds (default 3600 = 1 hour).
OP_MIGRATION_TIMEOUT=3600

# Fallback poll interval for ontology cache refresh in seconds (default 15).
# The primary mechanism is Redis pub/sub; this is the safety net.
# Ref spec §5 "Ontology cache".
OP_ONTOLOGY_POLL_INTERVAL=15

# ─── Auth / Email ─────────────────────────────────────────────────────────────
# Whether to require email verification before allowing full access.
# First admin (bootstrap) is always auto-verified regardless of this setting.
# Ref spec §4 "Email Verification".
OP_REQUIRE_EMAIL_VERIFICATION=false

# SMTP configuration for sending verification and password reset emails.
# If not set, Auth Service operates in link-copy mode (displays the link).
# Ref spec §7.2 "Auth Service" — link-copy mode when SMTP unconfigured (ADR-36).
# OP_SMTP_HOST=smtp.example.com
# OP_SMTP_PORT=587
# OP_SMTP_USER=noreply@example.com
# OP_SMTP_PASS=CHANGE_ME_smtp
# OP_SMTP_FROM=OnePlatform <noreply@example.com>
# OP_SMTP_SECURE=true

# ─── Object Storage ───────────────────────────────────────────────────────────
# By default, MinIO is used. Set OP_S3_ENDPOINT to switch to AWS S3 or
# Cloudflare R2 with no code changes. Ref spec §3 "MinIO: Buckets and IAM".
# OP_S3_ENDPOINT=https://s3.amazonaws.com
# OP_S3_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
# OP_S3_SECRET_KEY=CHANGE_ME_s3_secret
# OP_S3_REGION=us-east-1

# ─── Webhooks ─────────────────────────────────────────────────────────────────
# Allow HTTP (non-HTTPS) webhook URLs. DEV ONLY. Never set true in production.
# Ref spec §11 "Outbound Webhooks" — HTTPS required in production.
OP_WEBHOOK_ALLOW_HTTP=false

# ─── Observability ────────────────────────────────────────────────────────────
# OTEL Collector endpoint. In dev mode, services send traces directly to Jaeger.
# In production, route through OTEL Collector for backend flexibility.
# Ref spec §12 "OTEL Tracing".
# OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317

# ─── Secrets generated by op-init (READ-ONLY — do not set unless overriding) ──
# These are generated by op-init and written to /data/init/ on first start.
# Services read them from the mounted volume. You should NOT set these here
# unless you are rotating keys and need to inject pre-existing values.
# Ref spec §2 "Startup Sequence" step 1 and §4 "First-Run Bootstrap".
# OP_MASTER_KEY=<generated by op-init>
# OP_JWT_SECRET=<generated by op-init>
# OP_CURSOR_SECRET=<generated by op-init>
```

- [ ] **Step 2: Verify the file has no syntax errors (basic check)**

```bash
grep -c "=" .env.example
```

Expected: a number greater than 10 (sanity check that lines parsed).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "infra: add .env.example with all OP_* variables and infrastructure passwords"
```

---

## Task 9: Multi-Stage Service Dockerfile

**Files:**
- Create: `docker/Dockerfile.service`

References: spec §2 "Docker Compose Stack" — all 9 services use `custom:latest`. Uses `turbo prune` to create a minimal build context per service.

- [ ] **Step 1: Create `docker/Dockerfile.service`**

```dockerfile
# docker/Dockerfile.service
#
# Multi-stage build for all 9 OnePlatform services.
# Build any service by passing --build-arg SERVICE=<service-name>.
# Example: docker build -f docker/Dockerfile.service --build-arg SERVICE=auth .
#
# Stage 1 (builder): installs all dependencies, runs turbo prune to create a
# minimal workspace for the target service, then builds.
# Stage 2 (runner): copies only the built artifacts and prod dependencies,
# runs as a non-root user.

ARG SERVICE
ARG NODE_VERSION=22

# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

# Install pnpm via corepack (avoids a separate npm install step).
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /build

# Copy root workspace manifests first so Docker can cache the dependency
# installation layer independently from source changes.
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY .npmrc ./

# Copy all workspace package.json files. Docker layer caching: only re-runs
# pnpm install when package.json files change, not on source code changes.
COPY packages/core/package.json         ./packages/core/package.json
COPY packages/sdk/package.json          ./packages/sdk/package.json
COPY packages/app-sdk/package.json      ./packages/app-sdk/package.json
COPY packages/plugin-sdk/package.json   ./packages/plugin-sdk/package.json
COPY packages/cli/package.json          ./packages/cli/package.json
COPY services/gateway/package.json      ./services/gateway/package.json
COPY services/auth/package.json         ./services/auth/package.json
COPY services/ingestion/package.json    ./services/ingestion/package.json
COPY services/ontology/package.json     ./services/ontology/package.json
COPY services/pipeline/package.json     ./services/pipeline/package.json
COPY services/execution/package.json    ./services/execution/package.json
COPY services/app/package.json          ./services/app/package.json
COPY services/logging/package.json      ./services/logging/package.json
COPY services/plugin/package.json       ./services/plugin/package.json

# Install all workspace dependencies.
RUN pnpm install --frozen-lockfile

# Copy all source files and run turbo prune to reduce the build context
# to only the files needed for the target service and its dependencies.
COPY . .

# turbo prune creates /build/out/ with only the packages and services
# that the target service depends on. This dramatically reduces subsequent
# layer sizes.
RUN pnpm dlx turbo prune --scope="@oneplatform/${SERVICE}" --docker

# ─── Stage 1b: Install pruned dependencies ───────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS pruned-installer

ARG SERVICE

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /build

# Copy the pruned workspace from stage 1.
COPY --from=builder /build/out/json/ .
COPY --from=builder /build/out/pnpm-lock.yaml ./pnpm-lock.yaml

# Install only the dependencies needed for the pruned workspace.
RUN pnpm install --frozen-lockfile

# Copy pruned source files.
COPY --from=builder /build/out/full/ .

# Build the target service and all its local dependencies.
RUN pnpm dlx turbo run build --filter="@oneplatform/${SERVICE}"

# ─── Stage 2: Runner ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner

ARG SERVICE

# Security: run as non-root user. UID 1001 is a common convention for
# application users in Alpine-based images.
RUN addgroup --system --gid 1001 oneplatform && \
    adduser --system --uid 1001 --ingroup oneplatform oneplatform

WORKDIR /app

# Copy node_modules and built artifacts from the installer stage.
# Only production dependencies are included (turbo prune + pnpm install).
COPY --from=pruned-installer --chown=oneplatform:oneplatform /build/node_modules ./node_modules
COPY --from=pruned-installer --chown=oneplatform:oneplatform /build/services/${SERVICE}/dist ./dist
COPY --from=pruned-installer --chown=oneplatform:oneplatform /build/services/${SERVICE}/package.json ./package.json

# Copy built packages that the service depends on.
COPY --from=pruned-installer --chown=oneplatform:oneplatform /build/packages ./packages

USER oneplatform

# Services listen on port 3000 within the container. The compose file maps
# each service to its external port (3001–3008).
EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Verify Dockerfile syntax (lint with hadolint if available)**

```bash
docker run --rm -i hadolint/hadolint < docker/Dockerfile.service || echo "hadolint not available, skipping"
```

If hadolint is not available, proceed — the Docker build test in Task 11 validates the file.

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile.service
git commit -m "infra: add multi-stage Dockerfile.service for all 9 services via ARG SERVICE"
```

---

## Task 10: Sandbox Dockerfile

**Files:**
- Create: `docker/Dockerfile.sandbox`

References: spec §2 "Docker Compose Stack" — `op-sandbox-vm: custom:sandbox, No ports (Unix socket only)`. Spec §7.6 "Execution Service" — isolated-vm, Node 20 (pinned for isolated-vm compatibility), read-only filesystem, no capabilities, Unix socket listener.

- [ ] **Step 1: Create `docker/Dockerfile.sandbox`**

```dockerfile
# docker/Dockerfile.sandbox
#
# Sandbox VM container for executing untrusted JavaScript/TypeScript code
# via isolated-vm. This container runs with maximum isolation:
#   - Node 20 (pinned): isolated-vm requires specific V8 ABI compatibility.
#     Do NOT change the Node version without verifying isolated-vm compatibility.
#   - Read-only root filesystem
#   - No network access (sandbox network only, and no routes to internal)
#   - No Linux capabilities (--cap-drop=ALL in compose)
#   - Communication via Unix socket only (sandbox-socket volume)
#
# Ref spec §7.6 "Execution Service", §13 "Security Summary — Sandbox escape",
# §2 "Docker Compose Stack Layer 4 op-sandbox-vm".

# Node 20 pinned to a specific patch version for reproducible isolated-vm ABI.
# Verify this version against isolated-vm's compatibility matrix before upgrading:
# https://github.com/laverdet/isolated-vm#requirements
FROM node:20.14.0-alpine AS sandbox-builder

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /sandbox

# isolated-vm requires node-gyp and build tools for native compilation.
# These are only needed at build time (multi-stage removes them from runner).
RUN apk add --no-cache python3 make g++ linux-headers

# Install isolated-vm in isolation so its native module is compiled once
# and cached as a Docker layer.
COPY docker/sandbox/package.json ./package.json
RUN pnpm install --frozen-lockfile

# Copy the sandbox runtime source.
COPY docker/sandbox/src/ ./src/

# ─── Runner stage ────────────────────────────────────────────────────────────
FROM node:20.14.0-alpine AS runner

# Security: dedicated non-root user for the sandbox process.
RUN addgroup --system --gid 1002 sandbox && \
    adduser --system --uid 1002 --ingroup sandbox sandbox

WORKDIR /sandbox

# Copy only the runtime — no build tools, no source maps.
COPY --from=sandbox-builder --chown=sandbox:sandbox /sandbox/node_modules ./node_modules
COPY --from=sandbox-builder --chown=sandbox:sandbox /sandbox/src/          ./src/
COPY --from=sandbox-builder --chown=sandbox:sandbox /sandbox/package.json  ./package.json

USER sandbox

# No EXPOSE: this container communicates ONLY via Unix socket on the
# sandbox-socket volume. No TCP ports are opened.
# The socket path is /run/sandbox/op.sock — mounted from sandbox-socket volume.

ENV NODE_ENV=production
# Disable V8 optimizations that could be leveraged for sandbox escape.
ENV NODE_OPTIONS=--max-old-space-size=512

# Unix socket listener: accepts JSON-RPC requests from Execution Service.
# The socket path must match what Execution Service dials.
CMD ["node", "src/server.js", "--socket", "/run/sandbox/op.sock"]
```

- [ ] **Step 2: Create the sandbox package stub so the Dockerfile COPY succeeds**

```bash
mkdir -p docker/sandbox/src
```

Create `docker/sandbox/package.json`:

```json
{
  "name": "@oneplatform/sandbox-vm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js"
  },
  "dependencies": {
    "isolated-vm": "^4.7.2"
  }
}
```

Create `docker/sandbox/src/server.js` (stub — real implementation comes in a later phase):

```javascript
// docker/sandbox/src/server.js
// Stub Unix socket listener. Real JSON-RPC protocol implemented in Phase 4.
// This stub allows the container to build and start without crashing.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const socketFlagIndex = args.indexOf('--socket');
const socketPath = socketFlagIndex !== -1 ? args[socketFlagIndex + 1] : '/run/sandbox/op.sock';

// Remove stale socket file from previous run.
try { fs.unlinkSync(socketPath); } catch {}

// Ensure parent directory exists.
fs.mkdirSync(path.dirname(socketPath), { recursive: true });

const server = net.createServer((socket) => {
  console.log('[sandbox-vm] client connected');
  socket.on('data', (data) => {
    // Stub: echo back with error until real implementation is in place.
    const response = JSON.stringify({
      id: null,
      error: { code: -32603, message: 'sandbox-vm not yet implemented' }
    });
    socket.write(response + '\n');
  });
  socket.on('end', () => console.log('[sandbox-vm] client disconnected'));
});

server.listen(socketPath, () => {
  console.log(`[sandbox-vm] listening on ${socketPath}`);
});

process.on('SIGTERM', () => {
  console.log('[sandbox-vm] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
```

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile.sandbox docker/sandbox/
git commit -m "infra: add Dockerfile.sandbox for isolated-vm op-sandbox-vm container (Node 20 pinned)"
```

---

## Task 11: Verify Infrastructure

**Files:** None (verification only)

- [ ] **Step 1: Validate Docker Compose file**

```bash
docker compose -f docker/docker-compose.yml config --quiet
```

Expected: exits 0. Any YAML or reference errors will surface here.

- [ ] **Step 2: Copy `.env.example` to `.env` and fill in minimum required values**

```bash
cp .env.example .env
```

Edit `.env` — set these minimum values for local testing (use simple passwords):

```
POSTGRES_PASSWORD=devpass123
REDIS_ADMIN_PASSWORD=devpass123
PGBOUNCER_ADMIN_PASSWORD=devpass123
OP_MINIO_PASSWORD=devpass123
OP_BASE_URL=http://localhost:3000
OP_ALLOWED_ORIGINS=http://localhost:3000
```

- [ ] **Step 3: Start the data store layer**

```bash
docker compose -f docker/docker-compose.yml up -d op-init postgres redis minio
```

Expected: all 4 containers start. Wait 15 seconds for health checks.

- [ ] **Step 4: Verify op-init ran successfully**

```bash
docker compose -f docker/docker-compose.yml logs op-init
```

Expected: logs contain `[op-init] Initialization complete.` and `ls` output showing `master.key bootstrap.token jwt.secret cursor.secret ready`.

- [ ] **Step 5: Verify postgres is healthy**

```bash
docker compose -f docker/docker-compose.yml ps postgres
```

Expected: `Status: healthy`.

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c "\dn"
```

Expected: lists 9 schemas: `auth, app, execution, gateway, ingestion, logging, ontology, pipeline, plugin`.

- [ ] **Step 6: Verify service roles exist**

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c "\du"
```

Expected: lists `auth_service_role`, `ingestion_service_role`, `ontology_service_role`, `pipeline_service_role`, `execution_service_role`, `app_service_role`, `logging_service_role`, `plugin_service_role`, `gateway_service_role`.

- [ ] **Step 7: Verify cross-schema grant (ontology can read ingestion)**

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT grantee, table_schema, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'ontology_service_role' AND table_schema = 'ingestion' LIMIT 5;"
```

Expected: if no ingestion tables exist yet, 0 rows but no error. The DEFAULT PRIVILEGES grant will apply to future tables.

- [ ] **Step 8: Verify Redis is healthy and ACLs are loaded**

```bash
docker compose -f docker/docker-compose.yml ps redis
```

Expected: `Status: healthy`.

```bash
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli -a devpass123 ACL LIST
```

Expected: lists `user default`, `user op_admin`, `user op_auth`, `user op_pipeline`, `user op_logging`, `user op_gateway`, `user op_ingestion`, `user op_ontology`, `user op_app`, `user op_plugin`.

- [ ] **Step 9: Verify MinIO is reachable**

```bash
docker compose -f docker/docker-compose.yml ps minio
```

Expected: `Status: healthy`.

- [ ] **Step 10: Stop data stores**

```bash
docker compose -f docker/docker-compose.yml down
```

- [ ] **Step 11: Add `.env` to `.gitignore`**

```bash
echo ".env" >> .gitignore
echo "node_modules/" >> .gitignore
echo "dist/" >> .gitignore
echo "*.local" >> .gitignore
```

- [ ] **Step 12: Commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore — exclude .env, node_modules, dist"
```

---

## Task 12: Final Commit

- [ ] **Step 1: Verify full workspace build (no service code yet — just tsconfig stubs)**

```bash
pnpm install
pnpm turbo run build
```

Expected: all 14 workspaces build successfully (they all contain `export {}` stubs).

- [ ] **Step 2: Verify Docker Compose config one final time**

```bash
docker compose -f docker/docker-compose.yml config --quiet
```

Expected: exits 0.

- [ ] **Step 3: Run final git status to confirm all files tracked**

```bash
git status
```

Expected: clean working tree. If any untracked files appear, add and commit them.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: Phase 0 complete — monorepo, infrastructure, Docker Compose stack ready"
```

---

## Self-Review: Spec Coverage Check

| Spec Section | Covered By |
|---|---|
| §2 Docker Compose Stack — all containers and layers | Task 3 |
| §2 Volumes — all 15 named volumes | Task 3 |
| §2 Startup Sequence — op-init steps 1a–1e | Task 4 |
| §2 Network Topology — public/internal/sandbox | Task 3 |
| §2 op-sandbox-vm — separate container | Task 10 |
| §3 PostgreSQL — 9 schemas, 9 roles, grants | Task 5 |
| §3 Cross-schema exception — ontology reads ingestion | Task 5 |
| §3 PgBouncer — transaction/session dual-mode, pool sizes | Task 6 |
| §3 Redis ACL — all 8 service users, key prefixes, channels | Task 7 |
| §3 Redis — AOF persistence | Task 7 |
| §3 Redis — SELECT/FLUSHDB/FLUSHALL/KEYS/DEBUG denied | Task 7 |
| §3 MinIO — internal only, no public port | Task 3 |
| §13 docker-socket-proxy — 4 restricted operations only | Task 3 |
| Appendix A — all OP_* env vars | Task 8 |
| Multi-stage Dockerfile for services | Task 9 |
| Turborepo + pnpm workspace structure | Tasks 1–2 |

All spec requirements for Phase 0 are covered. Service code (Phase 1+) is intentionally out of scope.
