/**
 * mapping command group — mapping rule management for data engineers.
 *
 * Mapping rules define how ingested connector data maps to ontology entity fields.
 * All routes live on the Ontology Service under:
 *   GET    /api/v1/ontology/:entityType/mappings
 *   POST   /api/v1/ontology/:entityType/mappings
 *   PATCH  /api/v1/ontology/:entityType/mappings/:ruleId
 *   DELETE /api/v1/ontology/:entityType/mappings/:ruleId
 *
 * Required scopes: ontology:read (list/preview) | ontology:write (create/update/delete)
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Column definitions for table output
// ---------------------------------------------------------------------------

const MAPPING_COLUMNS = [
  { header: "ID", key: "id" },
  { header: "Connector", key: "connectorId" },
  { header: "Source Field", key: "sourceFieldPath" },
  { header: "Target Field", key: "targetFieldId" },
  { header: "Transform", key: "transformType" },
  { header: "Priority", key: "priority" },
  { header: "Active", key: "isActive" },
  { header: "Created", key: "createdAt" },
];

// ---------------------------------------------------------------------------
// Option interfaces
// ---------------------------------------------------------------------------

interface ListOpts {
  connector?: string;
}

interface CreateOpts {
  connector: string;
  sourceField: string;
  targetField: string;
  transformType?: string;
  transform?: string;
  priority?: string;
}

interface UpdateOpts {
  sourceField?: string;
  transformType?: string;
  transform?: string;
  active?: boolean;
  priority?: string;
}

interface PreviewOpts {
  connector: string;
  sample: string;
}

// ---------------------------------------------------------------------------
// Field slug resolution
// ---------------------------------------------------------------------------

// Process-scoped cache keyed on entityType. A single CLI invocation is always
// for one platform/tenant, so we don't need to include credentials in the key.
// The cache is never evicted — it lives only for the duration of this process.
const entitySchemaCache = new Map<string, Array<{ id: string; slug: string; name: string }>>();

/**
 * Resolves a target field identifier to its UUID.
 *
 * Accepts either a UUID (returned as-is) or a field slug/name. When a slug is
 * given the entity schema is fetched and the field is looked up by slug then
 * name. The schema is cached in-process so that bulk mapping creation (e.g.
 * via a shell loop) targeting the same entity type only incurs one GET call.
 */
async function resolveFieldId(
  entityType: string,
  fieldSlugOrId: string,
  ctx: CommandContext,
): Promise<string> {
  // Already a UUID — no resolution needed.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fieldSlugOrId)) {
    return fieldSlugOrId;
  }

  let fields = entitySchemaCache.get(entityType);
  if (!fields) {
    const entity = await ctx.http.get<{
      fields: Array<{ id: string; slug: string; name: string }>;
    }>(`/api/v1/ontology/${encodeURIComponent(entityType)}`);
    fields = entity.fields ?? [];
    entitySchemaCache.set(entityType, fields);
  }

  const field = fields.find(
    (f) => f.slug === fieldSlugOrId || f.name.toLowerCase() === fieldSlugOrId.toLowerCase(),
  );

  if (!field) {
    const available = fields.map((f) => f.slug).join(", ") || "(none)";
    throw new CliError(
      `Field "${fieldSlugOrId}" not found on entity "${entityType}". ` +
      `Run "op ontology get ${entityType}" to list available field slugs. ` +
      `Available: ${available}`,
      EXIT.GENERAL,
    );
  }

  return field.id;
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

async function listAction(entityType: string, opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.connector) query["connectorId"] = opts.connector;

  const resp = await ctx.http.get<{ data: unknown[] }>(
    `/api/v1/ontology/${encodeURIComponent(entityType)}/mappings`,
    query,
  );
  ctx.renderer.render(resp.data, MAPPING_COLUMNS);
}

async function createAction(entityType: string, opts: CreateOpts, ctx: CommandContext): Promise<void> {
  // Validate transform-type/transform combination up front so the error is
  // user-friendly rather than a server 400.
  const validTransformTypes = ["direct", "expression", "constant", "template"] as const;
  type TransformType = (typeof validTransformTypes)[number];

  const rawType = opts.transformType ?? "direct";
  if (!validTransformTypes.includes(rawType as TransformType)) {
    throw new CliError(
      `Invalid --transform-type "${rawType}". Valid values: ${validTransformTypes.join(", ")}.`,
      EXIT.GENERAL,
    );
  }
  const transformType = rawType as TransformType;

  if (transformType !== "direct" && opts.transform === undefined) {
    throw new CliError(
      `--transform is required when --transform-type is "${transformType}".`,
      EXIT.GENERAL,
    );
  }

  // Resolve slug/name to UUID — no-ops if opts.targetField is already a UUID.
  const resolvedTargetFieldId = await resolveFieldId(entityType, opts.targetField, ctx);

  const body: Record<string, unknown> = {
    connectorId: opts.connector,
    sourceFieldPath: opts.sourceField,
    targetFieldId: resolvedTargetFieldId,
    transformType,
    ...(opts.transform !== undefined ? { transform: opts.transform } : {}),
    ...(opts.priority !== undefined ? { priority: parseInt(opts.priority, 10) } : {}),
  };

  const resp = await ctx.http.post<{ id: string; sourceFieldPath: string; transformType: string }>(
    `/api/v1/ontology/${encodeURIComponent(entityType)}/mappings`,
    body,
  );
  ctx.renderer.success(
    `Mapping rule created (ID: ${resp.id}): "${resp.sourceFieldPath}" → ${entityType} [${resp.transformType}].`,
  );
}

async function updateAction(
  entityType: string,
  ruleId: string,
  opts: UpdateOpts,
  ctx: CommandContext,
): Promise<void> {
  const body: Record<string, unknown> = {};

  if (opts.sourceField !== undefined) body["sourceFieldPath"] = opts.sourceField;
  if (opts.transformType !== undefined) body["transformType"] = opts.transformType;
  // --transform "" clears the expression; pass null to the API to represent clearing.
  if (opts.transform !== undefined) body["transform"] = opts.transform === "" ? null : opts.transform;
  if (opts.active !== undefined) body["isActive"] = opts.active;
  if (opts.priority !== undefined) body["priority"] = parseInt(opts.priority, 10);

  if (Object.keys(body).length === 0) {
    throw new CliError("No update fields provided. Use --help to see available options.", EXIT.GENERAL);
  }

  await ctx.http.patch(
    `/api/v1/ontology/${encodeURIComponent(entityType)}/mappings/${encodeURIComponent(ruleId)}`,
    body,
  );
  ctx.renderer.success(`Mapping rule ${ruleId} updated.`);
}

async function deleteAction(
  entityType: string,
  ruleId: string,
  _opts: Record<string, never>,
  ctx: CommandContext,
): Promise<void> {
  await confirmDestructive(`Delete mapping rule '${ruleId}' from entity '${entityType}'?`, ctx.yes);
  await ctx.http.delete(
    `/api/v1/ontology/${encodeURIComponent(entityType)}/mappings/${encodeURIComponent(ruleId)}`,
  );
  ctx.renderer.success(`Mapping rule ${ruleId} deleted.`);
}

async function previewAction(entityType: string, opts: PreviewOpts, ctx: CommandContext): Promise<void> {
  // Load sample data — must be an array of raw connector records.
  let sampleRecords: unknown[];
  try {
    const raw = JSON.parse(readFileSync(opts.sample, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new CliError("--sample file must contain a JSON array of records.", EXIT.GENERAL);
    }
    sampleRecords = raw;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Failed to parse --sample file: ${String(err)}`, EXIT.GENERAL);
  }

  // The ontology service's internal /infer endpoint accepts sample records
  // and returns the inferred schema. We reuse that as a preview of how
  // the active mapping rules would transform this data.
  const resp = await ctx.http.post<{
    inferredFields: Array<{ sourceField: string; targetField: string; confidence: number }>;
  }>(
    `/api/v1/ontology/${encodeURIComponent(entityType)}/mappings/preview`,
    {
      connectorId: opts.connector,
      sample: sampleRecords,
    },
  );
  ctx.renderer.json(resp);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMapping(program: Command): void {
  const mapping = program
    .command("mapping")
    .description("Mapping rule management — configure how connector data maps to ontology entities (scope: ontology:read | ontology:write)");

  mapping
    .command("list")
    .description("List mapping rules for an entity type")
    .argument("<entity-type>", "Ontology entity type slug (e.g. customer)")
    .option("--connector <connector-id>", "Filter by connector ID")
    .action(withContext<[string, ListOpts]>(listAction));

  mapping
    .command("create")
    .description("Create a new mapping rule")
    .argument("<entity-type>", "Ontology entity type slug")
    .requiredOption("--connector <connector-id>", "Connector ID whose data this rule applies to")
    .requiredOption("--source-field <path>", "Dot-path into the connector record, e.g. contact.email")
    .requiredOption("--target-field <field-id>", "UUID or slug of the target ontology entity field (slug is resolved to UUID automatically)")
    .option(
      "--transform-type <type>",
      "How to map the value: direct|expression|constant|template (default: direct)",
    )
    .option(
      "--transform <value>",
      "Expression/constant/template value. Required when --transform-type is not 'direct'.",
    )
    .option("--priority <n>", "Execution priority (0 = lowest, default: 0)")
    .action(withContext<[string, CreateOpts]>(createAction));

  mapping
    .command("update")
    .description("Update a mapping rule by ID")
    .argument("<entity-type>", "Ontology entity type slug")
    .argument("<rule-id>", "Mapping rule UUID")
    .option("--source-field <path>", "New source field dot-path")
    .option("--transform-type <type>", "New transform type: direct|expression|constant|template")
    .option("--transform <value>", "New transform expression/constant/template (pass empty string to clear)")
    .option("--active", "Enable the rule")
    .option("--no-active", "Disable the rule")
    .option("--priority <n>", "New priority value")
    .action(withContext<[string, string, UpdateOpts]>(updateAction));

  mapping
    .command("delete")
    .description("Delete a mapping rule by ID")
    .argument("<entity-type>", "Ontology entity type slug")
    .argument("<rule-id>", "Mapping rule UUID")
    .action(withContext<[string, string, Record<string, never>]>(deleteAction));

  mapping
    .command("preview")
    .description("Preview how active mapping rules would transform sample connector data")
    .argument("<entity-type>", "Ontology entity type slug")
    .requiredOption("--connector <connector-id>", "Connector ID to resolve mapping rules for")
    .requiredOption("--sample <records.json>", "Path to JSON file containing an array of sample records")
    .action(withContext<[string, PreviewOpts]>(previewAction));
}
