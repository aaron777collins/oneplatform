// Data quality analysis for ingested batches.
//
// The service performs O(n) analysis of each batch immediately after it
// lands in the raw table. Quality checks run asynchronously — they never
// block the main sync execution path. Any issues discovered are stored
// to the connector_quality_stats table and emitted as structured log events
// so downstream alerting systems (e.g. PagerDuty, Slack) can subscribe.
//
// Design rationale:
//   - Pure functions: analyzeBatch is stateless; all comparisons go through
//     the previousStats parameter, which the caller loads from the DB.
//   - Strict thresholds are defined as named constants so they are easy to
//     find, audit, and adjust without hunting through conditionals.
//   - The service owns only analysis and persistence. Event emission is the
//     caller's responsibility (processBatchJob in sync-service.ts).

import type { Logger } from "@oneplatform/core";
import type { DataRecord } from "../utils/data-envelope.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IssueType =
  | "null_rate_spike"
  | "volume_drop"
  | "volume_spike"
  | "type_mismatch"
  | "missing_field"
  | "new_field";

export type IssueSeverity = "info" | "warning" | "critical";

export interface QualityIssue {
  type: IssueType;
  field?: string;
  severity: IssueSeverity;
  message: string;
  /** Observed value in this batch (rate [0–1] or count, depending on type). */
  currentValue: number;
  /** Baseline expected value from historical stats. */
  expectedValue: number;
}

export interface QualityReport {
  /**
   * Overall quality score: 1.0 = no issues, decreasing with each issue.
   * Critical issues subtract 0.4, warnings 0.15, info 0.05 — floored at 0.
   */
  score: number;
  issues: QualityIssue[];
  /** Per-field null rate observed in this batch (used to update stored stats). */
  fieldNullRates: Record<string, number>;
  /** Per-field observed JS type distribution (used to update stored stats). */
  fieldTypes: Record<string, Record<string, number>>;
  /** Number of records analysed. */
  recordCount: number;
}

/** Running statistics stored per (connector_id) in the DB. */
export interface ConnectorQualityStats {
  connectorId: string;
  /** Rolling average record count per sync batch (exponential moving average). */
  avgBatchSize: number;
  /** Per-field rolling average null rate. */
  fieldNullRates: Record<string, number>;
  /** Per-field observed JS type names and their counts across all batches seen. */
  fieldTypes: Record<string, Record<string, number>>;
  /** Fields seen at least once (used to detect missing / new fields). */
  knownFields: string[];
  /** Number of batches included in the running averages. */
  batchCount: number;
  updatedAt: string;
}

export interface QualityStatsRepository {
  findByConnectorId(connectorId: string): Promise<ConnectorQualityStats | null>;
  upsert(stats: ConnectorQualityStats): Promise<void>;
}

export interface DataQualityService {
  /**
   * Load the current quality stats for a connector from the DB.
   * Returns null on first batch (no history yet).
   */
  getStats(connectorId: string): Promise<ConnectorQualityStats | null>;

  /**
   * Analyse a batch and return a quality report. Never throws — errors are
   * logged and an empty "no issues" report is returned so the sync path is
   * never blocked.
   */
  analyzeBatch(
    connectorId: string,
    records: DataRecord[],
    previousStats: ConnectorQualityStats | null,
  ): QualityReport;

  /**
   * Persist updated running statistics back to the DB after a batch is
   * analysed. Separated from analyzeBatch so the pure analysis step can be
   * unit-tested without a DB dependency.
   */
  updateStats(
    connectorId: string,
    report: QualityReport,
    previousStats: ConnectorQualityStats | null,
  ): Promise<void>;
}

export interface DataQualityServiceDeps {
  statsRepo: QualityStatsRepository;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Threshold constants
// ---------------------------------------------------------------------------

// A field must have had an average null rate below this value to be considered
// "previously non-null". Avoids false positives for fields that are inherently
// optional in the source system.
const NULL_RATE_PREVIOUSLY_NON_NULL_THRESHOLD = 0.1;

// Null rate must exceed this fraction of records in the current batch to trigger
// a null-rate-spike warning on a previously non-null field.
const NULL_RATE_SPIKE_THRESHOLD = 0.5;

// Volume drop: current batch is less than (1 - this fraction) of the average.
// 0.8 means the batch must be ≥ 20% of average to avoid a critical alert.
const VOLUME_DROP_FRACTION = 0.8;

// Volume spike: current batch exceeds this multiple of the average.
// 5.0 = 500 % of average triggers a warning (not critical — spikes can be
// legitimate catch-up syncs, but they are worth surfacing).
const VOLUME_SPIKE_MULTIPLE = 5.0;

// Type mismatch: more than this fraction of non-null values for a field deviate
// from the dominant historical type. 0.10 = 10 %.
const TYPE_MISMATCH_RATE_THRESHOLD = 0.1;

// Minimum historical batch count before volume-based checks are meaningful.
// Before this many batches, we only collect stats — no volume alerts.
const MIN_BATCHES_FOR_VOLUME_CHECK = 3;

// Exponential moving average smoothing factor (α). Lower = smoother / slower
// to react. 0.2 gives reasonable responsiveness over ~10-batch windows.
const EMA_ALPHA = 0.2;

// Score penalty per severity level.
const SCORE_PENALTY: Record<IssueSeverity, number> = {
  critical: 0.4,
  warning: 0.15,
  info: 0.05,
};

// ---------------------------------------------------------------------------
// Pure analysis helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Returns a map of field → null count for the given records.
 *  Only fields that have at least one null/undefined value appear in the result.
 *  Fields with all non-null values are absent (not stored as 0) so callers can
 *  use `in` / `?? 0` to distinguish "no nulls seen" from "field never appeared".
 */
export function computeFieldNullCounts(
  records: DataRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const record of records) {
    for (const [field, value] of Object.entries(record.data)) {
      if (value === null || value === undefined) {
        counts[field] = (counts[field] ?? 0) + 1;
      }
    }
  }

  return counts;
}

/** Returns a map of field → null rate (0–1) for the given records.
 *
 * A field that is absent from a record entirely is treated as null for that
 * record. This handles sparse schemas where optional fields are omitted rather
 * than set to null — both forms represent "no value".
 */
export function computeFieldNullRates(
  records: DataRecord[],
): Record<string, number> {
  if (records.length === 0) return {};

  // Count how many times each field appears as null/undefined OR is absent.
  // Pass 1: count explicit nulls/undefineds per field.
  const nullCounts = computeFieldNullCounts(records);

  // Pass 2: count how many records contain each field at all (presence count).
  const presenceCounts: Record<string, number> = {};
  for (const record of records) {
    for (const field of Object.keys(record.data)) {
      presenceCounts[field] = (presenceCounts[field] ?? 0) + 1;
    }
  }

  const result: Record<string, number> = {};

  for (const [field, presentIn] of Object.entries(presenceCounts)) {
    // Records where field is absent also count as null.
    const absentIn = records.length - presentIn;
    const totalNull = (nullCounts[field] ?? 0) + absentIn;
    result[field] = totalNull / records.length;
  }

  return result;
}

/** Returns per-field JS type distribution (e.g. { "string": 5, "number": 3 }). */
export function computeFieldTypes(
  records: DataRecord[],
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};

  for (const record of records) {
    for (const [field, value] of Object.entries(record.data)) {
      if (value === null || value === undefined) continue;
      const typeName = typeof value;
      if (result[field] === undefined) {
        result[field] = {};
      }
      result[field][typeName] = (result[field]?.[typeName] ?? 0) + 1;
    }
  }

  return result;
}

/** Returns the dominant type (highest count) for a field distribution. */
export function dominantType(
  distribution: Record<string, number>,
): string | null {
  let maxCount = 0;
  let dominant: string | null = null;

  for (const [typeName, count] of Object.entries(distribution)) {
    if (count > maxCount) {
      maxCount = count;
      dominant = typeName;
    }
  }

  return dominant;
}

/**
 * Exponential moving average update.
 *
 * Using EMA rather than a simple arithmetic mean means we don't need to store
 * the full history of batch sizes — just the running average and a batch count.
 * Early batches (before batchCount reaches MIN_BATCHES_FOR_VOLUME_CHECK) are
 * averaged simply (equal weight) to converge quickly.
 */
export function updateEma(previous: number, current: number, batchCount: number): number {
  if (batchCount <= 1) return current;
  const alpha = batchCount < MIN_BATCHES_FOR_VOLUME_CHECK ? 1 / batchCount : EMA_ALPHA;
  return alpha * current + (1 - alpha) * previous;
}

// ---------------------------------------------------------------------------
// Core analysis function (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Analyse a batch against its historical baseline. Pure — no I/O.
 *
 * @param connectorId  - Used for labelling issues in log messages.
 * @param records      - The batch being analysed.
 * @param previousStats - Historical stats from the DB (null = first batch).
 */
export function analyzeBatch(
  connectorId: string,
  records: DataRecord[],
  previousStats: ConnectorQualityStats | null,
): QualityReport {
  const issues: QualityIssue[] = [];
  const fieldNullRates = computeFieldNullRates(records);
  const fieldTypes = computeFieldTypes(records);
  const recordCount = records.length;

  // ------------------------------------------------------------------
  // 1. Volume checks — only meaningful after MIN_BATCHES_FOR_VOLUME_CHECK
  //    historical batches have been seen. Before that we only collect.
  // ------------------------------------------------------------------

  if (previousStats !== null && previousStats.batchCount >= MIN_BATCHES_FOR_VOLUME_CHECK) {
    const avg = previousStats.avgBatchSize;

    if (avg > 0) {
      const dropThreshold = avg * (1 - VOLUME_DROP_FRACTION);
      const spikeThreshold = avg * VOLUME_SPIKE_MULTIPLE;

      if (recordCount < dropThreshold) {
        issues.push({
          type: "volume_drop",
          severity: "critical",
          message:
            `Volume drop: received ${recordCount} records, expected ~${Math.round(avg)} ` +
            `(${Math.round((1 - recordCount / avg) * 100)}% below average).`,
          currentValue: recordCount,
          expectedValue: avg,
        });
      } else if (recordCount > spikeThreshold) {
        issues.push({
          type: "volume_spike",
          severity: "warning",
          message:
            `Volume spike: received ${recordCount} records, expected ~${Math.round(avg)} ` +
            `(${Math.round((recordCount / avg) * 100)}% of average).`,
          currentValue: recordCount,
          expectedValue: avg,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Null rate checks — warn when a previously non-null field sees
  //    a spike in nulls.
  // ------------------------------------------------------------------

  for (const [field, currentNullRate] of Object.entries(fieldNullRates)) {
    const historicalNullRate = previousStats?.fieldNullRates[field] ?? null;

    if (
      historicalNullRate !== null &&
      historicalNullRate < NULL_RATE_PREVIOUSLY_NON_NULL_THRESHOLD &&
      currentNullRate > NULL_RATE_SPIKE_THRESHOLD
    ) {
      issues.push({
        type: "null_rate_spike",
        field,
        severity: "warning",
        message:
          `Null rate spike on field "${field}": ` +
          `${Math.round(currentNullRate * 100)}% null in current batch, ` +
          `historically ${Math.round(historicalNullRate * 100)}%.`,
        currentValue: currentNullRate,
        expectedValue: historicalNullRate,
      });
    }
  }

  // ------------------------------------------------------------------
  // 3. Missing field detection — a field seen historically but absent
  //    from every record in this batch.
  // ------------------------------------------------------------------

  if (previousStats !== null) {
    for (const knownField of previousStats.knownFields) {
      if (!(knownField in fieldNullRates)) {
        issues.push({
          type: "missing_field",
          field: knownField,
          severity: "warning",
          message: `Field "${knownField}" was present in previous batches but is missing from this batch entirely.`,
          currentValue: 0,
          expectedValue: 1,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. New field detection — a field not seen in any previous batch.
  // ------------------------------------------------------------------

  if (previousStats !== null) {
    const knownSet = new Set(previousStats.knownFields);
    for (const field of Object.keys(fieldNullRates)) {
      if (!knownSet.has(field)) {
        issues.push({
          type: "new_field",
          field,
          severity: "info",
          message: `New field "${field}" appeared in this batch for connector ${connectorId}.`,
          currentValue: 1,
          expectedValue: 0,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 5. Type mismatch — current batch has >10% non-dominant type.
  // ------------------------------------------------------------------

  for (const [field, currentDist] of Object.entries(fieldTypes)) {
    const historicalDist = previousStats?.fieldTypes[field] ?? null;
    if (historicalDist === null) continue;

    const historicalDominant = dominantType(historicalDist);
    if (historicalDominant === null) continue;

    const totalNonNull = Object.values(currentDist).reduce((a, b) => a + b, 0);
    if (totalNonNull === 0) continue;

    const dominantCount = currentDist[historicalDominant] ?? 0;
    const mismatchRate = 1 - dominantCount / totalNonNull;

    if (mismatchRate > TYPE_MISMATCH_RATE_THRESHOLD) {
      issues.push({
        type: "type_mismatch",
        field,
        severity: "warning",
        message:
          `Type mismatch on field "${field}": ` +
          `${Math.round(mismatchRate * 100)}% of non-null values deviate from the ` +
          `historical dominant type "${historicalDominant}".`,
        currentValue: mismatchRate,
        expectedValue: TYPE_MISMATCH_RATE_THRESHOLD,
      });
    }
  }

  // ------------------------------------------------------------------
  // 6. Score calculation — start at 1.0, deduct per issue severity.
  // ------------------------------------------------------------------

  const penalty = issues.reduce(
    (total, issue) => total + SCORE_PENALTY[issue.severity],
    0,
  );
  const score = Math.max(0, 1 - penalty);

  return { score, issues, fieldNullRates, fieldTypes, recordCount };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDataQualityService(
  deps: DataQualityServiceDeps,
): DataQualityService {
  const { statsRepo, logger } = deps;

  async function updateStats(
    connectorId: string,
    report: QualityReport,
    previousStats: ConnectorQualityStats | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    const prevBatchCount = previousStats?.batchCount ?? 0;
    const newBatchCount = prevBatchCount + 1;

    // Update rolling average batch size.
    const prevAvg = previousStats?.avgBatchSize ?? report.recordCount;
    const newAvg = updateEma(prevAvg, report.recordCount, newBatchCount);

    // Merge null rates using EMA.
    const mergedNullRates: Record<string, number> = { ...(previousStats?.fieldNullRates ?? {}) };
    for (const [field, rate] of Object.entries(report.fieldNullRates)) {
      const prev = mergedNullRates[field] ?? rate;
      mergedNullRates[field] = updateEma(prev, rate, newBatchCount);
    }

    // Merge type distributions: accumulate raw counts so the dominant type
    // calculation benefits from the full history rather than just EMA rates.
    const mergedTypes: Record<string, Record<string, number>> = {
      ...(previousStats?.fieldTypes ?? {}),
    };
    for (const [field, dist] of Object.entries(report.fieldTypes)) {
      const existing = mergedTypes[field] ?? {};
      const merged: Record<string, number> = { ...existing };
      for (const [typeName, count] of Object.entries(dist)) {
        merged[typeName] = (merged[typeName] ?? 0) + count;
      }
      mergedTypes[field] = merged;
    }

    // Update known fields: union of previous and current.
    const prevKnown = new Set(previousStats?.knownFields ?? []);
    for (const field of Object.keys(report.fieldNullRates)) {
      prevKnown.add(field);
    }

    const updatedStats: ConnectorQualityStats = {
      connectorId,
      avgBatchSize: newAvg,
      fieldNullRates: mergedNullRates,
      fieldTypes: mergedTypes,
      knownFields: [...prevKnown],
      batchCount: newBatchCount,
      updatedAt: now,
    };

    await statsRepo.upsert(updatedStats);
  }

  return {
    getStats(connectorId: string): Promise<ConnectorQualityStats | null> {
      return statsRepo.findByConnectorId(connectorId);
    },

    analyzeBatch(
      connectorId: string,
      records: DataRecord[],
      previousStats: ConnectorQualityStats | null,
    ): QualityReport {
      // analyzeBatch is synchronous and pure. Errors here would be bugs
      // (e.g. unexpected data shapes), not expected failures, so we let them
      // propagate to the caller who wraps this in a try/catch.
      try {
        return analyzeBatch(connectorId, records, previousStats);
      } catch (err) {
        logger.error("Data quality analysis failed unexpectedly", {
          connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Return a neutral report so the sync path is never blocked.
        return {
          score: 1,
          issues: [],
          fieldNullRates: {},
          fieldTypes: {},
          recordCount: records.length,
        };
      }
    },

    updateStats,
  };
}
