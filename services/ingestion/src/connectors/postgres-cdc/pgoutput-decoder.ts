/**
 * pgoutput binary protocol decoder.
 *
 * Converts raw Buffer messages from the PostgreSQL logical replication stream
 * into typed message objects. Only the message types we act on are decoded;
 * unknown type bytes produce null and are silently skipped by the consumer.
 *
 * Protocol reference:
 *   https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html
 *
 * All integers in the protocol are big-endian. Timestamps are microseconds
 * since the PostgreSQL epoch (2000-01-01 00:00:00 UTC), NOT the Unix epoch.
 */

import type {
  RelationMessage,
  BeginMessage,
  CommitMessage,
  InsertMessage,
  UpdateMessage,
  DeleteMessage,
  TupleData,
  TupleColumn,
} from "./types.js";

// PostgreSQL epoch in milliseconds (for converting to JS Date / ISO strings)
const PG_EPOCH_MS = Date.UTC(2000, 0, 1);

/**
 * Convert a PostgreSQL microsecond timestamp (relative to 2000-01-01) into an
 * ISO 8601 string suitable for CdcEvent.timestamp.
 */
export function pgTimestampToIso(pgMicros: bigint): string {
  const ms = PG_EPOCH_MS + Number(pgMicros / 1000n);
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Tuple decoder — shared by INSERT / UPDATE / DELETE
// ---------------------------------------------------------------------------

function decodeTuple(buf: Buffer, offset: number): { tuple: TupleData; nextOffset: number } {
  const columnCount = buf.readUInt16BE(offset);
  offset += 2;

  const columns: TupleColumn[] = [];
  for (let i = 0; i < columnCount; i++) {
    const kind = buf.toString("utf8", offset, offset + 1);
    offset += 1;

    if (kind === "n") {
      // NULL
      columns.push({ type: "null", value: null });
    } else if (kind === "u") {
      // Unchanged TOAST value
      columns.push({ type: "unchanged-toast", value: null });
    } else if (kind === "t") {
      // Text datum
      const len = buf.readInt32BE(offset);
      offset += 4;
      const value = buf.toString("utf8", offset, offset + len);
      offset += len;
      columns.push({ type: "text", value });
    } else if (kind === "b") {
      // Binary datum
      const len = buf.readInt32BE(offset);
      offset += 4;
      const value = buf.subarray(offset, offset + len).toString("base64");
      offset += len;
      columns.push({ type: "binary", value });
    } else {
      // Unknown kind — skip by treating as null. This makes the decoder
      // forward-compatible with future PostgreSQL protocol revisions.
      columns.push({ type: "null", value: null });
    }
  }

  return { tuple: { columns }, nextOffset: offset };
}

// ---------------------------------------------------------------------------
// Message type decoders
// ---------------------------------------------------------------------------

function decodeRelation(buf: Buffer): RelationMessage {
  let offset = 1; // skip the message type byte
  const relationId = buf.readUInt32BE(offset); offset += 4;
  const schemaEnd = buf.indexOf(0, offset);
  const schema = buf.toString("utf8", offset, schemaEnd); offset = schemaEnd + 1;
  const nameEnd = buf.indexOf(0, offset);
  const name = buf.toString("utf8", offset, nameEnd); offset = nameEnd + 1;
  const replicaIdentityByte = buf.readUInt8(offset); offset += 1;

  const replicaIdentityMap: Record<number, "default" | "nothing" | "full" | "index"> = {
    100: "default", // 'd'
    110: "nothing", // 'n'
    102: "full",    // 'f'
    105: "index",   // 'i'
  };
  const replicaIdentity = replicaIdentityMap[replicaIdentityByte] ?? "default";

  const columnCount = buf.readUInt16BE(offset); offset += 2;
  const columns = [];
  for (let i = 0; i < columnCount; i++) {
    const flags = buf.readUInt8(offset); offset += 1;
    const colNameEnd = buf.indexOf(0, offset);
    const colName = buf.toString("utf8", offset, colNameEnd); offset = colNameEnd + 1;
    const typeId = buf.readUInt32BE(offset); offset += 4;
    const typeMod = buf.readInt32BE(offset); offset += 4;
    columns.push({ flags, name: colName, typeId, typeMod });
  }

  return { type: "relation", relationId, schema, name, replicaIdentity, columns };
}

function decodeBegin(buf: Buffer): BeginMessage {
  let offset = 1;
  const lsnHigh = buf.readUInt32BE(offset); offset += 4;
  const lsnLow = buf.readUInt32BE(offset); offset += 4;
  const lsn = `${lsnHigh.toString(16).toUpperCase().padStart(8, "0")}/${lsnLow.toString(16).toUpperCase().padStart(8, "0")}`;
  const commitTimeMicros = buf.readBigUInt64BE(offset); offset += 8;
  const xid = buf.readUInt32BE(offset);
  return { type: "begin", lsn, commitTime: commitTimeMicros, xid };
}

function decodeCommit(buf: Buffer): CommitMessage {
  let offset = 1;
  const flags = buf.readUInt8(offset); offset += 1;
  const lsnHigh = buf.readUInt32BE(offset); offset += 4;
  const lsnLow = buf.readUInt32BE(offset); offset += 4;
  const lsn = `${lsnHigh.toString(16).toUpperCase().padStart(8, "0")}/${lsnLow.toString(16).toUpperCase().padStart(8, "0")}`;
  const endLsnHigh = buf.readUInt32BE(offset); offset += 4;
  const endLsnLow = buf.readUInt32BE(offset); offset += 4;
  const endLsn = `${endLsnHigh.toString(16).toUpperCase().padStart(8, "0")}/${endLsnLow.toString(16).toUpperCase().padStart(8, "0")}`;
  const commitTime = buf.readBigUInt64BE(offset);
  return { type: "commit", flags, lsn, endLsn, commitTime };
}

function decodeInsert(buf: Buffer): InsertMessage {
  let offset = 1;
  const relationId = buf.readUInt32BE(offset); offset += 4;
  offset += 1; // 'N' marker for the new tuple
  const { tuple: newTuple } = decodeTuple(buf, offset);
  return { type: "insert", relationId, new: newTuple };
}

function decodeUpdate(buf: Buffer): UpdateMessage {
  let offset = 1;
  const relationId = buf.readUInt32BE(offset); offset += 4;
  const markerByte = buf.toString("utf8", offset, offset + 1);
  offset += 1;

  let oldTuple: TupleData | undefined;
  if (markerByte === "O" || markerByte === "K") {
    // Old tuple present (replica identity = FULL or index)
    const result = decodeTuple(buf, offset);
    oldTuple = result.tuple;
    offset = result.nextOffset;
    offset += 1; // skip the 'N' marker for new tuple
  }

  const { tuple: newTuple } = decodeTuple(buf, offset);
  // exactOptionalPropertyTypes: only spread `old` when it is defined to avoid
  // assigning `undefined` to an optional property typed as TupleData.
  return oldTuple !== undefined
    ? { type: "update", relationId, old: oldTuple, new: newTuple }
    : { type: "update", relationId, new: newTuple };
}

function decodeDelete(buf: Buffer): DeleteMessage {
  let offset = 1;
  const relationId = buf.readUInt32BE(offset); offset += 4;
  const markerByte = buf.toString("utf8", offset, offset + 1);
  offset += 1;

  if (markerByte === "O") {
    const { tuple } = decodeTuple(buf, offset);
    return { type: "delete", relationId, old: tuple };
  } else if (markerByte === "K") {
    const { tuple } = decodeTuple(buf, offset);
    return { type: "delete", relationId, key: tuple };
  }

  return { type: "delete", relationId };
}

// ---------------------------------------------------------------------------
// Public decode entry point
// ---------------------------------------------------------------------------

export type DecodedMessage =
  | RelationMessage
  | BeginMessage
  | CommitMessage
  | InsertMessage
  | UpdateMessage
  | DeleteMessage
  | null; // unknown / unhandled message type

/**
 * Decode a single pgoutput logical replication message buffer.
 * Returns null for message types we intentionally skip (type, origin, truncate,
 * message) so the consumer loop can `continue` without branching on the type byte.
 */
export function decodePgOutputMessage(buf: Buffer): DecodedMessage {
  if (buf.length === 0) return null;

  const typeByte = buf.toString("utf8", 0, 1);

  switch (typeByte) {
    case "R": return decodeRelation(buf);
    case "B": return decodeBegin(buf);
    case "C": return decodeCommit(buf);
    case "I": return decodeInsert(buf);
    case "U": return decodeUpdate(buf);
    case "D": return decodeDelete(buf);
    // 'T' = truncate, 'Y' = type, 'O' = origin, 'M' = message
    // These are valid in the protocol but we don't need to act on them.
    default: return null;
  }
}
