/**
 * LSN (Log Sequence Number) utilities for PostgreSQL WAL positions.
 *
 * PostgreSQL encodes LSNs as "XXXXXXXX/YYYYYYYY" hex strings where each
 * segment is a 32-bit big-endian integer. Comparison by lexicographic string
 * sort is NOT safe because the segments are zero-padded independently.
 *
 * These helpers convert to/from a single BigInt for safe arithmetic and
 * comparison, matching the behavior of the pg_lsn type internally.
 */

const LSN_PATTERN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;

/**
 * Parse an LSN string into a BigInt for ordering comparisons.
 * Throws if the input is not a valid LSN string.
 */
export function parseLsn(lsn: string): bigint {
  if (!LSN_PATTERN.test(lsn)) {
    throw new Error(`Invalid LSN "${lsn}": expected format XXXXXXXX/YYYYYYYY`);
  }
  const [high, low] = lsn.split("/");
  return (BigInt(`0x${high ?? "0"}`) << 32n) | BigInt(`0x${low ?? "0"}`);
}

/**
 * Format a BigInt LSN back into the canonical "XXXXXXXX/YYYYYYYY" string
 * that PostgreSQL expects in replication feedback messages.
 */
export function formatLsn(value: bigint): string {
  const high = (value >> 32n) & 0xFFFF_FFFFn;
  const low = value & 0xFFFF_FFFFn;
  return `${high.toString(16).toUpperCase().padStart(8, "0")}/${low.toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * Return true when lsnA is strictly less than lsnB.
 * Used to avoid sending feedback with a position that goes backwards.
 */
export function lsnLessThan(lsnA: string, lsnB: string): boolean {
  return parseLsn(lsnA) < parseLsn(lsnB);
}

/**
 * Return the larger of two LSNs. Used to advance the confirmed-flush position
 * after a batch is durably committed to the raw table.
 */
export function maxLsn(lsnA: string, lsnB: string): string {
  return parseLsn(lsnA) >= parseLsn(lsnB) ? lsnA : lsnB;
}
