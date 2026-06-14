/**
 * Merges per-service OpenAPI JSON files into a single static base spec.
 *
 * Each service generates services/{name}/dist/openapi/{service}.json via its
 * docs:generate script. The merger reads all of these files and combines them
 * into docs/generated/openapi/merged.json which is the static base spec served
 * at /api/v1/openapi/base.json.
 *
 * WHY run outside Turbo as a root shell step:
 *   This is a fan-in step that reads from multiple packages and writes to the
 *   root docs/ directory. Turbo does not permit output paths traversing outside
 *   a package boundary (../../), so the merger must run as a plain shell step
 *   after turbo docs:generate completes. See design doc Section 7.
 *
 * Error conditions that abort the merge:
 *   - Path conflicts: two services declaring the same path (indicates a routing
 *     conflict that must be resolved before publishing a combined spec).
 *   - Schema name conflicts with different content: same .describe() name, different
 *     shape. Identical schemas are deduplicated silently.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

type JsonObject = Record<string, unknown>;

interface ServiceSpec {
  /** Service name derived from the filename. */
  service: string;
  /** Parsed OpenAPI document. */
  doc: JsonObject;
}

async function readServiceSpecs(servicesRoot: string): Promise<ServiceSpec[]> {
  let serviceNames: string[];
  try {
    serviceNames = await readdir(servicesRoot);
  } catch (err) {
    throw new Error(
      `[openapi-gen/merger] Cannot read services root "${servicesRoot}": ${String(err)}`,
    );
  }

  const specs: ServiceSpec[] = [];
  for (const name of serviceNames) {
    const openapiDir = join(servicesRoot, name, "dist", "openapi");
    let files: string[];
    try {
      files = await readdir(openapiDir);
    } catch {
      // This service has not generated its OpenAPI spec yet — skip silently.
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(openapiDir, file);
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch (err) {
        throw new Error(`[openapi-gen/merger] Cannot read "${filePath}": ${String(err)}`);
      }
      let doc: JsonObject;
      try {
        doc = JSON.parse(raw) as JsonObject;
      } catch (err) {
        throw new Error(`[openapi-gen/merger] Invalid JSON in "${filePath}": ${String(err)}`);
      }
      specs.push({ service: name, doc });
    }
  }

  return specs;
}

/**
 * Merges paths from all service specs into a single paths object.
 * Throws if two services declare the same path — this is a routing conflict.
 */
function mergePaths(
  specs: ServiceSpec[],
): [Record<string, unknown>, Record<string, string>] {
  const merged: Record<string, unknown> = {};
  // Maps each path to the service that owns it, for the x-service-map extension
  const serviceMap: Record<string, string> = {};

  for (const { service, doc } of specs) {
    const paths = (doc["paths"] as Record<string, unknown> | undefined) ?? {};
    for (const [path, pathItem] of Object.entries(paths)) {
      if (path in merged) {
        throw new Error(
          `[openapi-gen/merger] Path conflict: "${path}" is declared by both ` +
            `"${serviceMap[path]}" and "${service}". Resolve the routing conflict ` +
            "before merging.",
        );
      }
      merged[path] = pathItem;
      serviceMap[path] = service;
    }
  }

  return [merged, serviceMap];
}

/**
 * Merges component schemas from all service specs.
 * Identical schemas (same name, same shape) are deduplicated silently.
 * Schemas with the same name but different shape throw — callers must use
 * globally unique .describe() names.
 */
function mergeSchemas(specs: ServiceSpec[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const { service, doc } of specs) {
    const components = (doc["components"] as JsonObject | undefined) ?? {};
    const schemas = (components["schemas"] as Record<string, unknown> | undefined) ?? {};

    for (const [name, schema] of Object.entries(schemas)) {
      if (name in merged) {
        const existingJson = JSON.stringify(merged[name]);
        const incomingJson = JSON.stringify(schema);
        if (existingJson !== incomingJson) {
          throw new Error(
            `[openapi-gen/merger] Schema name conflict: "${name}" appears in ` +
              `"${service}" with a different shape than the previously registered ` +
              "version. Use a globally unique .describe() name in openapi-meta.ts.",
          );
        }
        // Identical content — deduplicate silently
      } else {
        merged[name] = schema;
      }
    }
  }

  return merged;
}

/**
 * Merges tags from all service specs, deduplicating by name.
 */
function mergeTags(specs: ServiceSpec[]): Array<{ name: string; description: string }> {
  const seen = new Map<string, { name: string; description: string }>();
  for (const { doc } of specs) {
    const tags = (doc["tags"] as Array<{ name: string; description: string }> | undefined) ?? [];
    for (const tag of tags) {
      if (!seen.has(tag.name)) {
        seen.set(tag.name, tag);
      }
    }
  }
  return Array.from(seen.values());
}

/**
 * Collects the security schemes from all specs, deduplicating by name.
 * In practice all services use the same two schemes (BearerAuth, ApiKeyAuth)
 * but we collect them all to be safe.
 */
function mergeSecuritySchemes(specs: ServiceSpec[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const { doc } of specs) {
    const components = (doc["components"] as JsonObject | undefined) ?? {};
    const schemes =
      (components["securitySchemes"] as Record<string, unknown> | undefined) ?? {};
    for (const [name, scheme] of Object.entries(schemes)) {
      merged[name] = scheme;
    }
  }
  return merged;
}

export interface MergerOptions {
  /** Absolute or CWD-relative path to the services/ directory. */
  servicesRoot: string;
  /** Output path for merged.json. Parent directory is created if needed. */
  outPath: string;
}

/**
 * Reads all per-service OpenAPI JSON files, merges them, and writes the result.
 *
 * The merged document adds an x-service-map extension that maps each path to
 * its owning service — useful for debugging and for the docs site's navigation.
 */
export async function mergeSpecs(options: MergerOptions): Promise<void> {
  const { servicesRoot, outPath } = options;

  const specs = await readServiceSpecs(servicesRoot);
  if (specs.length === 0) {
    throw new Error(
      "[openapi-gen/merger] No service OpenAPI specs found. " +
        `Run 'pnpm turbo docs:generate' first. Searched in: ${servicesRoot}`,
    );
  }

  const [mergedPaths, serviceMap] = mergePaths(specs);
  const mergedSchemas = mergeSchemas(specs);
  const mergedTags = mergeTags(specs);
  const mergedSecuritySchemes = mergeSecuritySchemes(specs);

  const merged: JsonObject = {
    openapi: "3.0.3",
    info: {
      title: "OnePlatform API",
      description:
        "Complete OnePlatform API covering all platform services. " +
        "For tenant-specific paths (ontology-defined entity routes), " +
        "authenticate and call GET /api/v1/openapi.json.",
      version: "1.0.0",
    },
    servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
    tags: mergedTags,
    paths: mergedPaths,
    components: {
      schemas: mergedSchemas,
      securitySchemes: mergedSecuritySchemes,
    },
    "x-service-map": serviceMap,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(merged, null, 2), "utf-8");
  console.log(
    `[openapi-gen/merger] Merged ${specs.length} service spec(s) → ${outPath}`,
  );
}
