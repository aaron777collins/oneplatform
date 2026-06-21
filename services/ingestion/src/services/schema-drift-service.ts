import type { Logger } from "@oneplatform/core";
import type { SchemaSnapshotRepository, FieldSchema } from "../repositories/schema-snapshot-repository.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { FieldSchema };

export interface ChangedField {
  name: string;
  /** Type in the previous snapshot. */
  previousType: string;
  /** Type in the incoming schema. */
  currentType: string;
  /** True if nullable status changed (false → true or vice-versa). */
  nullabilityChanged: boolean;
}

/** Result of comparing a new schema against the stored snapshot. */
export interface DriftResult {
  /** Fields present in the new schema but absent from the previous snapshot. */
  added: FieldSchema[];
  /** Fields in the previous snapshot that no longer appear. */
  removed: FieldSchema[];
  /** Fields whose type or nullability differ between snapshots. */
  changed: ChangedField[];
  /** True when at least one of added/removed/changed is non-empty. */
  hasDrift: boolean;
}

/** Single entry returned by the schema-drift API endpoint. */
export interface DriftHistoryEntry {
  snapshotId: string;
  capturedAt: string;
  fields: FieldSchema[];
}

export interface SchemaDriftService {
  /**
   * Extract field schemas from a batch of raw records and capture a new
   * snapshot. Returns the detected drift (empty diff on first run).
   *
   * This MUST NOT throw — failures are logged and an empty DriftResult is
   * returned so the calling sync worker is never blocked by drift detection.
   */
  captureAndDetect(
    connectorId: string,
    records: Array<Record<string, unknown>>,
  ): Promise<DriftResult>;

  /**
   * Compare an incoming schema against the stored snapshot without persisting.
   * Exported separately so it can be unit-tested in isolation.
   */
  detectDrift(previous: FieldSchema[], incoming: FieldSchema[]): DriftResult;

  /**
   * Return the stored schema snapshots for a connector, newest first.
   */
  getHistory(connectorId: string): Promise<DriftHistoryEntry[]>;
}

export interface SchemaDriftServiceDeps {
  snapshotRepo: SchemaSnapshotRepository;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Pure comparison logic (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Compare two field schema arrays and return the structural differences.
 *
 * We index by field name. A field is "changed" when its type or nullable
 * flag differs between snapshots; everything else in FieldSchema is
 * identity-determining (i.e. the name itself).
 */
export function compareSchemasForDrift(
  previous: FieldSchema[],
  incoming: FieldSchema[],
): DriftResult {
  const previousByName = new Map<string, FieldSchema>(
    previous.map((f) => [f.name, f]),
  );
  const incomingByName = new Map<string, FieldSchema>(
    incoming.map((f) => [f.name, f]),
  );

  const added: FieldSchema[] = [];
  const removed: FieldSchema[] = [];
  const changed: ChangedField[] = [];

  for (const [name, field] of incomingByName) {
    const prev = previousByName.get(name);
    if (prev === undefined) {
      added.push(field);
    } else {
      const typeChanged = prev.type !== field.type;
      const nullabilityChanged = prev.nullable !== field.nullable;
      if (typeChanged || nullabilityChanged) {
        changed.push({
          name,
          previousType: prev.type,
          currentType: field.type,
          nullabilityChanged,
        });
      }
    }
  }

  for (const [name, field] of previousByName) {
    if (!incomingByName.has(name)) {
      removed.push(field);
    }
  }

  return {
    added,
    removed,
    changed,
    hasDrift: added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

/**
 * Infer FieldSchema entries from a batch of raw records.
 *
 * We observe every key across all records in the batch. A field is marked
 * nullable when it is absent (or explicitly null) in at least one record.
 * The type is taken from the first non-null observation; if a field is always
 * null across the entire batch its type is "null".
 *
 * This is intentionally shallow: we inspect top-level keys only. Deep
 * inspection of nested objects would make the snapshot storage and comparison
 * logic significantly more complex for marginal gain — callers can opt into
 * that by expanding the type system in a future iteration.
 *
 * TODO(schema-drift): Add recursive mode for nested object/array inspection.
 * When `inferredType === "object"`, recurse into the value and produce a
 * nested FieldSchema[]. For arrays, inspect element types and flag
 * heterogeneous arrays. This will require changes to FieldSchema (adding
 * a `children?: FieldSchema[]` field) and to the snapshot comparison logic
 * in `detectDrift`. Track in backlog as G-180.
 */
export function inferSchema(records: Array<Record<string, unknown>>): FieldSchema[] {
  if (records.length === 0) return [];

  // Collect all field names seen across every record in the batch.
  const allNames = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      allNames.add(key);
    }
  }

  const fields: FieldSchema[] = [];

  for (const name of allNames) {
    let inferredType: string = "null";
    let nullable = false;

    for (const record of records) {
      const value = record[name];

      if (!(name in record) || value === null || value === undefined) {
        nullable = true;
        continue;
      }

      if (inferredType === "null") {
        // First non-null observation — determine the type.
        if (Array.isArray(value)) {
          inferredType = "array";
        } else {
          inferredType = typeof value;
        }
      }
    }

    fields.push({ name, type: inferredType, nullable });
  }

  // Sort by name for deterministic comparison and snapshot storage.
  fields.sort((a, b) => a.name.localeCompare(b.name));

  return fields;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSchemaDriftService(deps: SchemaDriftServiceDeps): SchemaDriftService {
  const { snapshotRepo, logger } = deps;

  async function captureAndDetect(
    connectorId: string,
    records: Array<Record<string, unknown>>,
  ): Promise<DriftResult> {
    // Drift detection must never crash the sync worker. All errors are logged
    // and an empty (no-drift) result is returned so the batch job continues.
    try {
      if (records.length === 0) {
        return { added: [], removed: [], changed: [], hasDrift: false };
      }

      const incomingSchema = inferSchema(records);

      const latestSnapshot = await snapshotRepo.findLatest(connectorId);

      let drift: DriftResult;

      if (latestSnapshot === null) {
        // No previous snapshot — first run for this connector. Capture and
        // return an empty diff; there's nothing to compare against.
        drift = { added: [], removed: [], changed: [], hasDrift: false };
      } else {
        drift = compareSchemasForDrift(latestSnapshot.fields, incomingSchema);
      }

      // Always persist the incoming schema as the new baseline, even when
      // there's no drift. This ensures the snapshot reflects the actual state
      // of the source at this sync rather than going stale if drift was detected
      // but a human decided not to act on it.
      await snapshotRepo.save(connectorId, incomingSchema);

      if (drift.hasDrift) {
        logger.warn("Schema drift detected", {
          connectorId,
          added: drift.added.map((f) => f.name),
          removed: drift.removed.map((f) => f.name),
          changed: drift.changed.map((f) => ({
            name: f.name,
            previousType: f.previousType,
            currentType: f.currentType,
            nullabilityChanged: f.nullabilityChanged,
          })),
        });
        // EE-002: Current behavior is detect + alert (warn log + structured event).
        // Enhancement path for auto-remediation policies:
        //   - "auto-add-fields": automatically extend the ontology entity when
        //     drift.added is non-empty, so new source fields land in the schema
        //     without manual intervention.
        //   - "auto-deprecate-fields": mark fields in drift.removed as deprecated
        //     (soft-delete) rather than leaving them as orphaned columns.
        //   - Policies would be configurable per-connector and enforced here after
        //     the drift.hasDrift check. Implementation requires a policy store and
        //     calls to the Ontology Service's migration API.
      }

      return drift;
    } catch (err) {
      logger.error("Schema drift detection failed — sync will continue", {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { added: [], removed: [], changed: [], hasDrift: false };
    }
  }

  function detectDrift(previous: FieldSchema[], incoming: FieldSchema[]): DriftResult {
    return compareSchemasForDrift(previous, incoming);
  }

  async function getHistory(connectorId: string): Promise<DriftHistoryEntry[]> {
    const snapshots = await snapshotRepo.findRecent(connectorId);
    return snapshots.map((s) => ({
      snapshotId: s.id,
      capturedAt: s.captured_at.toISOString(),
      fields: s.fields,
    }));
  }

  return { captureAndDetect, detectDrift, getHistory };
}
