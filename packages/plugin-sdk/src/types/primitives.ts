/**
 * Core primitive types shared across all plugin interfaces.
 * These are pure TypeScript declarations — they emit zero JavaScript.
 */

// JSON Schema Draft 7 subset. Used for configSchema, outputSchema, inputSchema fields.
// Deliberately typed as Record<string, unknown> — full JSON Schema typing is out of scope
// for this SDK. Plugin authors use standard JSON Schema tooling (ajv, etc.) for authoring.
export type JSONSchema = Record<string, unknown>;

// A single record from an external data source, as produced by a Connector
// or consumed by a Transformer or Destination.
export interface DataRecord {
  // The record's stable identifier in the external system.
  // Used for deduplication and incremental sync (upsert by sourceId).
  sourceId: string;

  // The record's raw field values. Keys are arbitrary strings from the source.
  data: Record<string, unknown>;

  // Optional provenance metadata. Connectors should populate these when available.
  metadata?: {
    createdAt?: string; // ISO 8601 from source system
    updatedAt?: string; // ISO 8601 from source system
    deletedAt?: string; // ISO 8601. Non-null signals a soft-delete event.
    checksum?: string; // Content hash for change detection (e.g., MD5 of JSON)
  };
}

// A record that has been mapped to an ontology entity type.
// Produced by the Ontology Service after a raw DataRecord passes through mapping.
export interface MappedRecord {
  sourceId: string;
  entityType: string; // Platform ontology entity type (e.g., "Customer")
  data: Record<string, unknown>; // Ontology-typed, validated field values
  operation: "upsert" | "delete";
}
