/**
 * PostgreSQL CDC connector — barrel export.
 */

export { PostgresCdcConnector } from "./postgres-cdc-connector.js";
export type { PostgresCdcConfig, CachedRelation } from "./types.js";
export { parseLsn, formatLsn, lsnLessThan, maxLsn } from "./lsn.js";
export { decodePgOutputMessage, pgTimestampToIso } from "./pgoutput-decoder.js";
