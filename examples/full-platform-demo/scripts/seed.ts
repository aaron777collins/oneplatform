/**
 * Full Platform Demo — Seed Script
 *
 * Seeds the OnePlatform instance with demo data for two tenants:
 *   - Acme Corp (enterprise manufacturing)
 *   - Widget Co (mid-size e-commerce)
 *
 * Each tenant receives users, connectors, ontology entity types, pipelines,
 * apps, and sample entity records. The script is idempotent — running it
 * twice will fail on duplicate names rather than corrupting data. Use
 * scripts/cleanup.sh to reset before re-running.
 *
 * Required environment variables:
 *   OP_BASE_URL — e.g. https://localhost
 *   OP_API_KEY  — admin-scoped API key
 *
 * Optional environment variables:
 *   DEMO_SKIP_CONNECTORS   — "true" to skip connector creation
 *   DEMO_TRIGGER_PIPELINES — "true" to trigger pipelines after seeding
 *
 * Run with: npm run seed
 */

import { createClient } from "@oneplatform/sdk";
import type {
  OnePlatformClient,
  ConnectorInstance,
  OntologySchema,
  Pipeline,
  App,
  CreateConnectorRequest,
  CreatePipelineRequest,
  CreateAppRequest,
  CreateOntologyRequest,
  CreateUserRequest,
} from "@oneplatform/sdk";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = resolve(__dirname, "..", "seed");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env["OP_BASE_URL"];
const API_KEY = process.env["OP_API_KEY"];
const SKIP_CONNECTORS = process.env["DEMO_SKIP_CONNECTORS"] === "true";
const TRIGGER_PIPELINES = process.env["DEMO_TRIGGER_PIPELINES"] === "true";

if (!BASE_URL || !API_KEY) {
  console.error(
    "Error: OP_BASE_URL and OP_API_KEY environment variables are required.\n" +
      "\n" +
      "  cp .env.example .env\n" +
      "  # Edit .env and set OP_BASE_URL and OP_API_KEY\n" +
      "  npm run seed\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load seed data files
// ---------------------------------------------------------------------------

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
  tenantSlug: string;
  email: string;
  displayName: string;
  roles: string[];
}

interface ConnectorSeed {
  tenantSlug: string;
  name: string;
  pluginId: string;
  config: Record<string, unknown>;
  syncMode: "full" | "incremental";
  isEnabled: boolean;
  scheduleCron: string | null;
  description: string;
}

interface EntityFieldSeed {
  name: string;
  type: string;
  required: boolean;
  indexed: boolean;
  description: string | null;
}

interface EntityRelationshipSeed {
  name: string;
  targetEntity: string;
  cardinality: "one" | "many";
}

interface EntitySeed {
  tenantSlug: string;
  name: string;
  displayName: string;
  fields: EntityFieldSeed[];
  relationships: EntityRelationshipSeed[];
  sampleRecords: Record<string, unknown>[];
}

interface PipelineStepSeed {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

interface PipelineDefinitionSeed {
  version: 1;
  entryStepId: string;
  steps: PipelineStepSeed[];
  options?: Record<string, unknown>;
}

interface PipelineSeed {
  tenantSlug: string;
  name: string;
  description: string;
  connectorName: string;
  definition: PipelineDefinitionSeed;
  isActive: boolean;
}

interface AppFileSeed {
  [path: string]: string;
}

interface AppSeed {
  tenantSlug: string;
  name: string;
  slug: string;
  description: string;
  accessMode: "platform-user" | "public";
  files: AppFileSeed;
}

function loadJson<T>(filename: string): T {
  const content = readFileSync(resolve(SEED_DIR, filename), "utf-8");
  return JSON.parse(content) as T;
}

const tenants = loadJson<TenantSeed[]>("tenants.json");
const users = loadJson<UserSeed[]>("users.json");
const connectors = loadJson<ConnectorSeed[]>("connectors.json");
const entities = loadJson<EntitySeed[]>("entities.json");
const pipelines = loadJson<PipelineSeed[]>("pipelines.json");
const apps = loadJson<AppSeed[]>("apps.json");

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const client: OnePlatformClient = createClient({
  baseUrl: BASE_URL,
  auth: { apiKey: API_KEY },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Log a step with indentation for readability. */
function log(indent: number, message: string): void {
  const prefix = "  ".repeat(indent);
  console.log(`${prefix}${message}`);
}

/** Retry wrapper for transient failures during seeding. */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) {
        throw new Error(`${label}: failed after ${maxAttempts} attempts: ${message}`);
      }
      const backoffMs = attempt * 1000;
      log(2, `${label}: attempt ${attempt} failed (${message}), retrying in ${backoffMs}ms...`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  // TypeScript requires a return, but this line is unreachable.
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

async function seedUsers(tenantSlug: string): Promise<void> {
  const tenantUsers = users.filter((u) => u.tenantSlug === tenantSlug);
  if (tenantUsers.length === 0) {
    log(1, "No users to seed for this tenant.");
    return;
  }

  log(1, `Seeding ${tenantUsers.length} users...`);
  for (const user of tenantUsers) {
    const request: CreateUserRequest = {
      email: user.email,
      displayName: user.displayName,
      roles: user.roles,
    };
    await withRetry(`User ${user.email}`, () => client.users.create(request));
    log(2, `Created user: ${user.displayName} <${user.email}> [${user.roles.join(", ")}]`);
  }
}

async function seedConnectors(
  tenantSlug: string,
): Promise<Map<string, ConnectorInstance>> {
  const result = new Map<string, ConnectorInstance>();
  const tenantConnectors = connectors.filter((c) => c.tenantSlug === tenantSlug);

  if (tenantConnectors.length === 0 || SKIP_CONNECTORS) {
    if (SKIP_CONNECTORS) {
      log(1, "Skipping connectors (DEMO_SKIP_CONNECTORS=true).");
    } else {
      log(1, "No connectors to seed for this tenant.");
    }
    return result;
  }

  log(1, `Seeding ${tenantConnectors.length} connectors...`);
  for (const conn of tenantConnectors) {
    const request: CreateConnectorRequest = {
      name: conn.name,
      pluginId: conn.pluginId,
      config: conn.config,
      syncMode: conn.syncMode,
      isEnabled: conn.isEnabled,
      scheduleCron: conn.scheduleCron ?? undefined,
    };
    const created = await withRetry(
      `Connector ${conn.name}`,
      () => client.connectors.create(request),
    );
    result.set(conn.name, created);
    log(2, `Created connector: ${created.id} (${created.name}) [${conn.syncMode}]`);
  }

  return result;
}

async function seedEntities(
  tenantSlug: string,
): Promise<Map<string, OntologySchema>> {
  const result = new Map<string, OntologySchema>();
  const tenantEntities = entities.filter((e) => e.tenantSlug === tenantSlug);

  if (tenantEntities.length === 0) {
    log(1, "No entity types to seed for this tenant.");
    return result;
  }

  log(1, `Seeding ${tenantEntities.length} ontology entity types...`);
  for (const entity of tenantEntities) {
    // Create the ontology schema (entity type definition).
    const ontologyRequest: CreateOntologyRequest = {
      name: entity.name,
      displayName: entity.displayName,
      fields: entity.fields,
      relationships: entity.relationships,
    };
    const schema = await withRetry(
      `Ontology ${entity.name}`,
      () => client.ontologies.create(ontologyRequest),
    );
    result.set(entity.name, schema);
    log(2, `Created entity type: ${schema.id} (${schema.name}) — ${entity.fields.length} fields`);

    // Insert sample records if provided.
    if (entity.sampleRecords.length > 0) {
      log(2, `Inserting ${entity.sampleRecords.length} sample records for ${entity.name}...`);
      const entityResource = client.data.entity(entity.name);
      for (const record of entity.sampleRecords) {
        await withRetry(
          `Record in ${entity.name}`,
          () => entityResource.create(record),
        );
      }
      log(3, `Inserted ${entity.sampleRecords.length} records.`);
    }
  }

  return result;
}

async function seedPipelines(
  tenantSlug: string,
  connectorMap: Map<string, ConnectorInstance>,
): Promise<Pipeline[]> {
  const result: Pipeline[] = [];
  const tenantPipelines = pipelines.filter((p) => p.tenantSlug === tenantSlug);

  if (tenantPipelines.length === 0) {
    log(1, "No pipelines to seed for this tenant.");
    return result;
  }

  log(1, `Seeding ${tenantPipelines.length} pipelines...`);
  for (const pipelineSeed of tenantPipelines) {
    // Resolve connector references in step definitions.
    // Steps that reference a connector by name need the runtime connector ID.
    const resolvedSteps = pipelineSeed.definition.steps.map((step) => {
      const resolved = { ...step };
      if ("connectorRef" in resolved && typeof resolved["connectorRef"] === "string") {
        const connectorName = resolved["connectorRef"] as string;
        const connector = connectorMap.get(connectorName);
        if (connector) {
          resolved["connectorId"] = connector.id;
        } else {
          log(3, `Warning: connector "${connectorName}" not found — step "${step.id}" may fail at runtime.`);
        }
        delete resolved["connectorRef"];
      }
      return resolved;
    });

    const request: CreatePipelineRequest = {
      name: pipelineSeed.name,
      description: pipelineSeed.description,
      definition: {
        ...pipelineSeed.definition,
        steps: resolvedSteps,
      },
      isActive: pipelineSeed.isActive,
    };

    const created = await withRetry(
      `Pipeline ${pipelineSeed.name}`,
      () => client.pipelines.create(request),
    );
    result.push(created);
    log(2, `Created pipeline: ${created.id} (${created.name}) — ${resolvedSteps.length} steps`);
  }

  return result;
}

async function seedApps(tenantSlug: string): Promise<App[]> {
  const result: App[] = [];
  const tenantApps = apps.filter((a) => a.tenantSlug === tenantSlug);

  if (tenantApps.length === 0) {
    log(1, "No apps to seed for this tenant.");
    return result;
  }

  log(1, `Seeding ${tenantApps.length} apps...`);
  for (const appSeed of tenantApps) {
    // Create the app definition.
    const request: CreateAppRequest = {
      name: appSeed.name,
      slug: appSeed.slug,
      description: appSeed.description,
      accessMode: appSeed.accessMode,
    };
    const created = await withRetry(
      `App ${appSeed.name}`,
      () => client.apps.create(request),
    );
    result.push(created);
    log(2, `Created app: ${created.id} (${created.slug}) [${appSeed.accessMode}]`);

    // Upload files to the app's virtual file system.
    const fileEntries = Object.entries(appSeed.files);
    if (fileEntries.length > 0) {
      log(2, `Uploading ${fileEntries.length} files...`);
      for (const [filePath, content] of fileEntries) {
        await withRetry(
          `File ${filePath} in ${appSeed.slug}`,
          () =>
            client.apps.writeFile(created.id, filePath, {
              content,
              fileVersion: 0, // 0 = create new file
            }),
        );
        log(3, `Uploaded: ${filePath} (${content.length} bytes)`);
      }
    }
  }

  return result;
}

async function triggerAllPipelines(createdPipelines: Pipeline[]): Promise<void> {
  if (!TRIGGER_PIPELINES || createdPipelines.length === 0) {
    return;
  }

  log(0, "");
  log(0, "Triggering pipelines...");
  for (const pipeline of createdPipelines) {
    try {
      const run = await client.pipelines.trigger(pipeline.id);
      log(1, `Triggered: ${pipeline.name} -> run ${run.id} (${run.status})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(1, `Warning: Could not trigger ${pipeline.name}: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("OnePlatform Full Demo — Seed Script");
  console.log("=".repeat(60));
  console.log("");

  // Verify connectivity.
  log(0, "Verifying connection...");
  const identity = await client.ping();
  log(1, `Connected as ${identity.email} (tenant: ${identity.tenantId})`);
  log(1, `Roles: ${identity.roles.join(", ")}`);
  console.log("");

  const allPipelines: Pipeline[] = [];

  // Seed each tenant sequentially. Within each tenant, resources are created
  // in dependency order: users -> entities -> connectors -> pipelines -> apps.
  for (const tenant of tenants) {
    console.log("-".repeat(60));
    log(0, `Tenant: ${tenant.name} (${tenant.slug})`);
    log(0, `  Plan: ${tenant.plan}`);
    log(0, `  ${tenant.description}`);
    console.log("");

    // 1. Users — no dependencies.
    await seedUsers(tenant.slug);
    console.log("");

    // 2. Ontology entity types — no dependencies, but must exist before
    //    pipeline steps that reference entityType.
    const entityMap = await seedEntities(tenant.slug);
    console.log("");

    // 3. Connectors — no platform dependencies, but pipeline steps reference
    //    connector IDs so connectors must be created before pipelines.
    const connectorMap = await seedConnectors(tenant.slug);
    console.log("");

    // 4. Pipelines — depend on connectors (by ID) and entities (by name).
    const tenantPipelines = await seedPipelines(tenant.slug, connectorMap);
    allPipelines.push(...tenantPipelines);
    console.log("");

    // 5. Apps — depend on entity types being present (the app code queries them).
    await seedApps(tenant.slug);
    console.log("");

    log(0, `Tenant ${tenant.name} seeded successfully.`);
    log(1, `Users:      ${users.filter((u) => u.tenantSlug === tenant.slug).length}`);
    log(1, `Entities:   ${entityMap.size}`);
    log(1, `Connectors: ${connectorMap.size}`);
    log(1, `Pipelines:  ${tenantPipelines.length}`);
    log(1, `Apps:       ${apps.filter((a) => a.tenantSlug === tenant.slug).length}`);
    console.log("");
  }

  // Optionally trigger all pipelines.
  await triggerAllPipelines(allPipelines);

  // Summary
  console.log("=".repeat(60));
  console.log("Seeding complete.");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Open the platform UI at " + BASE_URL);
  console.log("  2. Log in as admin@acmecorp.example.com to explore Acme Corp");
  console.log("  3. Log in as admin@widgetco.example.com to explore Widget Co");
  console.log("  4. View Grafana dashboards at http://localhost:3100");
  console.log("  5. View Jaeger traces at http://localhost:16686");
  console.log("");
  console.log("To remove all demo data:");
  console.log("  npm run cleanup");
  console.log("=".repeat(60));

  client.destroy();
}

main().catch((err: unknown) => {
  console.error("");
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  client.destroy();
  process.exit(1);
});
