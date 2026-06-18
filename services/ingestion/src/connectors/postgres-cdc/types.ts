/**
 * Internal types for the PostgreSQL CDC connector.
 *
 * These are not exported from the plugin-sdk — they are implementation
 * details of the built-in connector that lives inside the ingestion service.
 */

// ---------------------------------------------------------------------------
// pgoutput protocol message types
//
// PostgreSQL logical replication with pgoutput emits a binary protocol.
// The pg driver's replication API surfaces these as typed message objects.
// We define only the subset we decode; unknown message types are silently
// skipped (the protocol is forward-compatible by design).
// ---------------------------------------------------------------------------

export type PgOutputMessageType =
  | "begin"
  | "commit"
  | "relation"
  | "insert"
  | "update"
  | "delete"
  | "truncate"
  | "type"
  | "origin"
  | "message";

/** Relation (schema) message — sent before the first DML on a newly-seen table. */
export interface RelationMessage {
  type: "relation";
  relationId: number;
  schema: string;
  name: string;
  replicaIdentity: "default" | "nothing" | "full" | "index";
  columns: RelationColumn[];
}

export interface RelationColumn {
  flags: number;
  name: string;
  typeId: number;
  typeMod: number;
}

/** BEGIN message — marks the start of a transaction. */
export interface BeginMessage {
  type: "begin";
  lsn: string;
  commitTime: bigint; // microseconds since 2000-01-01
  xid: number;
}

/** COMMIT message — marks the end of a transaction. */
export interface CommitMessage {
  type: "commit";
  flags: number;
  lsn: string;
  endLsn: string;
  commitTime: bigint; // microseconds since 2000-01-01
}

/** INSERT message. */
export interface InsertMessage {
  type: "insert";
  relationId: number;
  new: TupleData;
}

/** UPDATE message. */
export interface UpdateMessage {
  type: "update";
  relationId: number;
  old?: TupleData; // present when replica identity = FULL or identity index
  new: TupleData;
}

/** DELETE message. */
export interface DeleteMessage {
  type: "delete";
  relationId: number;
  old?: TupleData; // present when replica identity = FULL or identity index
  key?: TupleData; // present when replica identity = DEFAULT (primary key only)
}

/** Column values in a tuple. */
export interface TupleData {
  columns: TupleColumn[];
}

export interface TupleColumn {
  type: "text" | "binary" | "null" | "unchanged-toast";
  value: string | null;
}

// ---------------------------------------------------------------------------
// Internal connector state
// ---------------------------------------------------------------------------

/** Cached relation schema keyed by relationId from the pgoutput stream. */
export interface CachedRelation {
  schema: string;
  name: string;
  /** Fully-qualified table name, e.g. "public.orders" */
  qualifiedName: string;
  columns: RelationColumn[];
}

/**
 * Connection configuration validated by connect().
 * All fields are required; the connector rejects configs with missing values
 * rather than silently falling back to defaults.
 */
export interface PostgresCdcConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /**
   * Logical replication slot name. Must already exist or will be created
   * with pgoutput. The name must match [a-z0-9_]{1,63}.
   */
  slotName: string;
  /** PostgreSQL publication name. Must exist in the source database. */
  publicationName: string;
  /** Connection timeout in milliseconds. Defaults to 10_000. */
  connectTimeoutMs?: number;
}
