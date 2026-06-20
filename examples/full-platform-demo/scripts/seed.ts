/**
 * Seed script for the OnePlatform Full Platform Demo.
 *
 * Creates tenants, users, connectors, entity types, pipelines, and apps
 * using the @oneplatform/sdk. Resources are created in dependency order:
 *
 *   1. Tenants
 *   2. Users (depend on tenants)
 *   3. Connectors (depend on tenants)
 *   4. Entity types / ontology (depend on tenants)
 *   5. Pipelines (depend on connectors and entity types)
 *   6. Apps (depend on entity types)
 *
 * Usage:
 *   npx tsx scripts/seed.ts
 *
 * Environment:
 *   OP_BASE_URL  — Platform base URL (default: https://localhost)
 *   OP_API_KEY   — Admin API key with full scopes
 */

import { createClient } from "@oneplatform/sdk";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedDir = resolve(__dirname, "..", "seed");

const BASE_URL = process.env.OP_BASE_URL ?? "https://localhost";
const API_KEY = process.env.OP_API_KEY;

if (!API_KEY) {
  console.error("Error: OP_API_KEY environment variable is required.");
  console.error("Generate an admin API key from the platform UI or use the bootstrap key.");
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function loadSeedFile<T>(filename: string): T {
  const path = resolve(seedDir, filename);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as T;
}

function log(phase: string, message: string): void {
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`[${timestamp}] [${phase}] ${message}`);
}

function logError(phase: string, message: string, error: unknown): void {
  const timestamp = new Date().toISOString().substring(11, 19);
  const errorMsg = error instanceof Error ? error.message : String(error);
  console.error(`[${timestamp}] [${phase}] ERROR: ${message}: ${errorMsg}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Seed functions
// ────────────────────────────────────────────────────────────────────────────

interface TenantSeed {
  id: string;
  name: string;
  slug: string;
  description: string;
  plan: string;
  settings: Record<string, unknown>;
  contactEmail: string;
}

interface UserSeed {
  tenantId: string;
  email: string;
  displayName: string;
  role: string;
  department: string;
  title: string;
  password: string;
  active: boolean;
}

interface ConnectorSeed {
  tenantId: string;
  id: string;
  name: string;
  type: string;
  description: string;
  config: Record<string, unknown>;
  schedule: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

interface EntityFieldSeed {
  name: string;
  type: string;
  required: boolean;
  referenceTo?: string;
}

interface EntitySeed {
  tenantId: string;
  name: string;
  displayName: string;
  description: string;
  primaryKey: string;
  fields: EntityFieldSeed[];
}

interface PipelineSeed {
  tenantId: string;
  id: string;
  name: string;
  description: string;
  trigger: Record<string, unknown>;
  steps: Record<string, unknown>[];
  errorHandling: Record<string, unknown>;
  enabled: boolean;
}

interface AppSeed {
  tenantId: string;
  id: string;
  name: string;
  description: string;
  type: string;
  config: Record<string, unknown>;
  access: Record<string, unknown>;
  enabled: boolean;
}

async function seedTenants(
  client: ReturnType<typeof createClient>,
  tenants: TenantSeed[]
): Promise<void> {
  log("tenants", `Creating ${tenants.length} tenant(s)...`);

  for (const tenant of tenants) {
    try {
      await client.data.entity("_tenants").create({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        description: tenant.description,
        plan: tenant.plan,
        settings: tenant.settings,
        contactEmail: tenant.contactEmail,
      });
      log("tenants", `  Created: ${tenant.name} (${tenant.slug})`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("409")) {
        log("tenants", `  Already exists: ${tenant.name} (${tenant.slug})`);
      } else {
        logError("tenants", `Failed to create ${tenant.name}`, error);
      }
    }
  }
}

// Sentinel value written in users.json to make clear the field is a placeholder.
// The seed script replaces it with a cryptographically random password at
// runtime so no real credentials ever land in source control.
const GENERATED_PASSWORD_SENTINEL = "<GENERATED_BY_SEED_SCRIPT>";

function resolveUserPassword(rawPassword: string): string {
  if (rawPassword === GENERATED_PASSWORD_SENTINEL) {
    // 16 random bytes → 32 lowercase hex chars. Long enough for any password
    // policy while being easy to copy-paste from seed output.
    return randomBytes(16).toString("hex");
  }
  return rawPassword;
}

async function seedUsers(
  client: ReturnType<typeof createClient>,
  users: UserSeed[]
): Promise<void> {
  log("users", `Creating ${users.length} user(s)...`);

  for (const user of users) {
    try {
      const password = resolveUserPassword(user.password);
      await client.users.create({
        email: user.email,
        displayName: user.displayName,
        password,
        role: user.role,
        tenantId: user.tenantId,
        metadata: {
          department: user.department,
          title: user.title,
        },
        active: user.active,
      });
      log("users", `  Created: ${user.displayName} (${user.email}) -> ${user.role}`);
      if (user.password === GENERATED_PASSWORD_SENTINEL) {
        log("users", `    Generated password: ${password}  (save this — it will not be shown again)`);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("409")) {
        log("users", `  Already exists: ${user.displayName} (${user.email})`);
      } else {
        logError("users", `Failed to create ${user.displayName}`, error);
      }
    }
  }
}

async function seedConnectors(
  client: ReturnType<typeof createClient>,
  connectors: ConnectorSeed[]
): Promise<void> {
  log("connectors", `Creating ${connectors.length} connector(s)...`);

  for (const connector of connectors) {
    try {
      await client.connectors.create({
        id: connector.id,
        name: connector.name,
        type: connector.type,
        description: connector.description,
        config: connector.config,
        schedule: connector.schedule,
        tenantId: connector.tenantId,
      });
      log("connectors", `  Created: ${connector.name} (${connector.id})`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("409")) {
        log("connectors", `  Already exists: ${connector.name} (${connector.id})`);
      } else {
        logError("connectors", `Failed to create ${connector.name}`, error);
      }
    }
  }
}

async function seedEntities(
  client: ReturnType<typeof createClient>,
  entities: EntitySeed[]
): Promise<void> {
  log("entities", `Creating ${entities.length} entity type(s)...`);

  for (const entity of entities) {
    try {
      await client.ontologies.createEntityType({
        name: entity.name,
        displayName: entity.displayName,
        description: entity.description,
        primaryKey: entity.primaryKey,
        fields: entity.fields,
        tenantId: entity.tenantId,
      });
      log("entities", `  Created: ${entity.displayName} (${entity.tenantId})`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("409")) {
        log("entities", `  Already exists: ${entity.displayName} (${entity.tenantId})`);
      } else {
        logError("entities", `Failed to create ${entity.displayName}`, error);
      }
    }
  }
}

async function seedPipelines(
  client: ReturnType<typeof createClient>,
  pipelines: PipelineSeed[]
): Promise<void> {
  log("pipelines", `Creating ${pipelines.length} pipeline(s)...`);

  for (const pipeline of pipelines) {
    try {
      await client.pipelines.create({
        id: pipeline.id,
        name: pipeline.name,
        description: pipeline.description,
        trigger: pipeline.trigger,
        steps: pipeline.steps,
        errorHandling: pipeline.errorHandling,
        enabled: pipeline.enabled,
        tenantId: pipeline.tenantId,
      });
      log("pipelines", `  Created: ${pipeline.name} (${pipeline.id})`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("409")) {
        log("pipelines", `  Already exists: ${pipeline.name} (${pipeline.id})`);
      } else {
        logError("pipelines", `Failed to create ${pipeline.name}`, error);
      }
    }
  }
}

async function seedApps(
  client: ReturnType<typeof createClient>,
  apps: AppSeed[]
): Promise<void> {
  log("apps", `Creating ${apps.length} app(s)...`);

  for (const app of apps) {
    try {
      await client.apps.create({
        id: app.id,
        name: app.name,
        description: app.description,
        type: app.type,
        config: app.config,
        access: app.access,
        enabled: app.enabled,
        tenantId: app.tenantId,
      });
      log("apps", `  Created: ${app.name} (${app.id})`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("409")) {
        log("apps", `  Already exists: ${app.name} (${app.id})`);
      } else {
        logError("apps", `Failed to create ${app.name}`, error);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("");
  console.log("=".repeat(60));
  console.log("  OnePlatform Full Demo — Seed Script");
  console.log("=".repeat(60));
  console.log(`  Platform URL: ${BASE_URL}`);
  console.log(`  Seed data:    ${seedDir}`);
  console.log("=".repeat(60));
  console.log("");

  // Create the SDK client
  const client = createClient({
    baseUrl: BASE_URL,
    auth: { apiKey: API_KEY },
    timeout: 30_000,
  });

  try {
    // Verify connectivity
    log("init", "Verifying platform connectivity...");
    const whoami = await client.ping();
    log("init", `Authenticated as: ${whoami.email ?? whoami.userId ?? "admin"}`);

    // Load seed data
    const tenants = loadSeedFile<TenantSeed[]>("tenants.json");
    const users = loadSeedFile<UserSeed[]>("users.json");
    const connectors = loadSeedFile<ConnectorSeed[]>("connectors.json");
    const entities = loadSeedFile<EntitySeed[]>("entities.json");
    const pipelines = loadSeedFile<PipelineSeed[]>("pipelines.json");
    const apps = loadSeedFile<AppSeed[]>("apps.json");

    // Seed in dependency order
    await seedTenants(client, tenants);
    await seedUsers(client, users);
    await seedConnectors(client, connectors);
    await seedEntities(client, entities);
    await seedPipelines(client, pipelines);
    await seedApps(client, apps);

    console.log("");
    console.log("=".repeat(60));
    console.log("  Seeding complete!");
    console.log("");
    console.log("  Summary:");
    console.log(`    Tenants:    ${tenants.length}`);
    console.log(`    Users:      ${users.length}`);
    console.log(`    Connectors: ${connectors.length}`);
    console.log(`    Entities:   ${entities.length}`);
    console.log(`    Pipelines:  ${pipelines.length}`);
    console.log(`    Apps:       ${apps.length}`);
    console.log("");
    console.log("  Next steps:");
    console.log("    - Open the platform UI: https://localhost");
    console.log("    - View Grafana dashboards: http://localhost:3100");
    console.log("    - View Jaeger traces: http://localhost:16686");
    console.log("=".repeat(60));
    console.log("");
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
