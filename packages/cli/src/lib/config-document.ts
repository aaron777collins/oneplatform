/**
 * YAML multi-document config file parser, topological sort, and conflict resolution.
 * Implements the op config import / export / diff / validate logic described in §9.
 *
 * Dependency graph (Kahn's algorithm):
 *   Role       → (none)
 *   Ontology   → (none)
 *   Connector  → Ontology
 *   Pipeline   → Connector, Ontology
 *   App        → Pipeline, Ontology
 *   Webhook    → (none)
 */
import { load as yamlLoad, loadAll as yamlLoadAll, dump as yamlDump } from "js-yaml";

export type ResourceKind = "Role" | "Ontology" | "Connector" | "Pipeline" | "App" | "Webhook";
export type ConflictMode = "fail" | "skip" | "overwrite" | "merge";

export interface ConfigDocument {
  kind: ResourceKind;
  spec: Record<string, unknown>;
}

/** Stable identity key used to detect conflicts: "{Kind}:{spec.name}" */
export function resourceKey(doc: ConfigDocument): string {
  const name = doc.spec["name"] as string | undefined;
  if (!name) throw new Error(`Config document of kind '${doc.kind}' is missing spec.name.`);
  return `${doc.kind}:${name}`;
}

const VALID_RESOURCE_KINDS = new Set<ResourceKind>([
  "Role", "Ontology", "Connector", "Pipeline", "App", "Webhook",
]);

function assertValidKind(kind: string): asserts kind is ResourceKind {
  if (!VALID_RESOURCE_KINDS.has(kind as ResourceKind)) {
    throw new Error(
      `Invalid resource kind '${kind}'. ` +
        `Valid kinds are: ${[...VALID_RESOURCE_KINDS].join(", ")}.`,
    );
  }
}

/** Parse a YAML multi-document string into ConfigDocument[]. */
export function parseConfigDocuments(yaml: string): ConfigDocument[] {
  const docs: ConfigDocument[] = [];
  yamlLoadAll(yaml, (doc) => {
    if (doc && typeof doc === "object") {
      const d = doc as Record<string, unknown>;
      if (typeof d["kind"] !== "string" || typeof d["spec"] !== "object") {
        throw new Error(`Invalid config document: must have 'kind' (string) and 'spec' (object).`);
      }
      // Validate kind before casting — unknown kinds would silently produce wrong
      // dependency edges and incorrect topological sort priority (defaulting to 99),
      // only failing later with a confusing server error.
      assertValidKind(d["kind"]);
      docs.push({ kind: d["kind"], spec: d["spec"] as Record<string, unknown> });
    }
  });
  return docs;
}

/** Serialize ConfigDocument[] to YAML multi-document string. */
export function serializeConfigDocuments(docs: ConfigDocument[]): string {
  return docs.map((d) => yamlDump(d)).join("---\n");
}

// Dependency edges: which kinds must precede which
const DEPS: Partial<Record<ResourceKind, ResourceKind[]>> = {
  Connector: ["Ontology"],
  Pipeline: ["Connector", "Ontology"],
  App: ["Pipeline", "Ontology"],
};

// Priority order for kinds without inter-doc dependencies (Kahn's tiebreaking)
const KIND_PRIORITY: Record<ResourceKind, number> = {
  Role: 0,
  Ontology: 1,
  Connector: 2,
  Pipeline: 3,
  App: 4,
  Webhook: 5,
};

/**
 * Topologically sorts config documents using Kahn's algorithm.
 * Throws with a descriptive cycle path if a circular dependency is detected.
 */
export function topologicalSort(docs: ConfigDocument[]): ConfigDocument[] {
  // Build adjacency: for each doc, find which other docs it depends on
  const keys = docs.map(resourceKey);
  const docByKey = new Map<string, ConfigDocument>();
  for (let i = 0; i < docs.length; i++) {
    const key = keys[i];
    if (key) docByKey.set(key, docs[i] as ConfigDocument);
  }

  // In-degree map and adjacency list
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // key → keys that depend on it

  for (const key of keys) {
    if (key) {
      inDegree.set(key, 0);
      dependents.set(key, []);
    }
  }

  for (const doc of docs) {
    const key = resourceKey(doc);
    const requiredKinds = DEPS[doc.kind] ?? [];
    for (const depKind of requiredKinds) {
      // Find all docs of the required kind
      for (const d2 of docs) {
        if (d2.kind === depKind) {
          const depKey = resourceKey(d2);
          // doc depends on d2: d2 must come before doc
          dependents.get(depKey)?.push(key);
          inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
        }
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }
  // Sort by kind priority for stable output
  queue.sort((a, b) => {
    const docA = docByKey.get(a);
    const docB = docByKey.get(b);
    const pa = docA ? KIND_PRIORITY[docA.kind] : 99;
    const pb = docB ? KIND_PRIORITY[docB.kind] : 99;
    return pa - pb;
  });

  const sorted: ConfigDocument[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const doc = docByKey.get(key);
    if (doc) sorted.push(doc);

    const deps = dependents.get(key) ?? [];
    for (const dep of deps) {
      const newDeg = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) {
        queue.push(dep);
        queue.sort((a, b) => {
          const docA = docByKey.get(a);
          const docB = docByKey.get(b);
          const pa = docA ? KIND_PRIORITY[docA.kind] : 99;
          const pb = docB ? KIND_PRIORITY[docB.kind] : 99;
          return pa - pb;
        });
      }
    }
  }

  if (sorted.length !== docs.length) {
    // Cycle detected — find which keys remain
    const sortedKeys = new Set(sorted.map(resourceKey));
    const remaining = keys.filter((k) => k && !sortedKeys.has(k));
    throw new Error(
      `Circular dependency detected in config file.\n` +
        `Involved resources: ${remaining.join(", ")}\n` +
        `Import aborted. No resources were written.`,
    );
  }

  return sorted;
}

/** Deep-merges b into a (additive only — no field removals). Returns new object. */
export function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a };
  for (const [key, val] of Object.entries(b)) {
    if (
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** Parses a JSON or YAML file content, auto-detecting format. */
export function parseConfigFile(content: string, filePath: string): ConfigDocument[] {
  if (filePath.endsWith(".json")) {
    const data = JSON.parse(content) as unknown;
    if (!Array.isArray(data)) throw new Error("JSON config must be an array of documents.");
    const docs: ConfigDocument[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") {
        throw new Error(`Invalid config document: must have 'kind' (string) and 'spec' (object).`);
      }
      const d = item as Record<string, unknown>;
      if (typeof d["kind"] !== "string" || typeof d["spec"] !== "object") {
        throw new Error(`Invalid config document: must have 'kind' (string) and 'spec' (object).`);
      }
      assertValidKind(d["kind"]);
      docs.push({ kind: d["kind"], spec: d["spec"] as Record<string, unknown> });
    }
    return docs;
  }
  return parseConfigDocuments(content);
}

/** Loads and parses a local config file. */
import { readFileSync } from "node:fs";
export function loadConfigFile(filePath: string): ConfigDocument[] {
  const content = readFileSync(filePath, "utf8");
  return parseConfigFile(content, filePath);
}
