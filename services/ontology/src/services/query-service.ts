/**
 * QueryService — executes structured queries against tenant entity tables.
 *
 * Security model: ALL identifiers (entity type, field names) go through
 * quotePgIdentifier() which validates the slug regex and double-quotes the
 * result. Values ALWAYS flow through parameterized query placeholders ($N).
 * This means SQL injection is structurally impossible at the query level.
 *
 * The query builder converts the high-level StructuredQuery into a single
 * parameterized SQL string. We never concatenate user-supplied values into
 * the SQL text — only pre-validated identifier slugs.
 */

import type pg from "pg";
import { quotePgIdentifier, tenantSchemaName } from "../utils/pg-identifier.js";
import type { FieldRepository } from "../repositories/field-repository.js";
import type { EntityRepository } from "../repositories/entity-repository.js";
import { EntityNotFoundError } from "./errors.js";
import { QueryValidationError, QueryTimeoutError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WhereOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "in"
  | "not_in"
  | "is_null"
  | "is_not_null";

export interface WhereClause {
  field: string;
  operator: WhereOperator;
  value?: unknown;
}

export interface StructuredQuery {
  entityType: string;
  select: string[]; // field slugs, or ['*']
  where?: WhereClause[];
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
  groupBy?: string[];
  having?: WhereClause[];
}

export interface QueryColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  totalCount: number;
  executionTimeMs: number;
}

export interface ValidateQueryResult {
  valid: boolean;
  errors: string[];
}

export interface QueryService {
  executeQuery(tenantId: string, query: StructuredQuery): Promise<QueryResult>;
  validateQuery(tenantId: string, query: StructuredQuery): Promise<ValidateQueryResult>;
}

export interface QueryServiceDeps {
  db: pg.Pool;
  entityRepo: EntityRepository;
  fieldRepo: FieldRepository;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
// 30 seconds expressed as a PostgreSQL statement_timeout string
const QUERY_TIMEOUT_MS = 30_000;

// The system columns that every entity table has. These are always valid select targets.
const SYSTEM_COLUMNS = new Set(["_id", "_created_at", "_updated_at", "_version", "_source_id"]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQueryService(deps: QueryServiceDeps): QueryService {
  const { db, entityRepo, fieldRepo } = deps;

  // Resolve the entity and its field slugs for the given tenant.
  async function resolveEntityFields(
    tenantId: string,
    entityType: string,
  ): Promise<{ schemaName: string; tableSlug: string; fieldSlugs: Set<string>; fieldTypes: Map<string, string> }> {
    const entity = await entityRepo.findBySlug(tenantId, entityType);
    if (!entity) {
      throw new EntityNotFoundError(`Entity '${entityType}' not found.`);
    }
    const fields = await fieldRepo.findByEntityId(entity.id);
    const fieldSlugs = new Set<string>([...SYSTEM_COLUMNS, ...fields.map((f) => f.slug)]);
    const fieldTypes = new Map<string, string>(fields.map((f) => [f.slug, f.field_type]));
    // System column types
    fieldTypes.set("_id", "string");
    fieldTypes.set("_created_at", "date");
    fieldTypes.set("_updated_at", "date");
    fieldTypes.set("_version", "number");
    fieldTypes.set("_source_id", "string");

    return {
      schemaName: tenantSchemaName(tenantId),
      tableSlug: entity.slug,
      fieldSlugs,
      fieldTypes,
    };
  }

  // Validate all field references in a query against the known entity fields.
  function validateFieldReferences(
    query: StructuredQuery,
    fieldSlugs: Set<string>,
  ): string[] {
    const errors: string[] = [];

    // Validate select fields (wildcard is always fine)
    if (!query.select.includes("*")) {
      for (const f of query.select) {
        if (!fieldSlugs.has(f)) {
          errors.push(`Unknown field in select: '${f}'`);
        }
      }
    }

    for (const clause of query.where ?? []) {
      if (!fieldSlugs.has(clause.field)) {
        errors.push(`Unknown field in where: '${clause.field}'`);
      }
    }

    for (const ob of query.orderBy ?? []) {
      if (!fieldSlugs.has(ob.field)) {
        errors.push(`Unknown field in orderBy: '${ob.field}'`);
      }
    }

    for (const f of query.groupBy ?? []) {
      if (!fieldSlugs.has(f)) {
        errors.push(`Unknown field in groupBy: '${f}'`);
      }
    }

    for (const clause of query.having ?? []) {
      if (!fieldSlugs.has(clause.field)) {
        errors.push(`Unknown field in having: '${clause.field}'`);
      }
    }

    return errors;
  }

  // Validate structural constraints of the query (limit, operator compatibility, etc.)
  function validateStructure(query: StructuredQuery): string[] {
    const errors: string[] = [];

    if (query.limit !== undefined && (query.limit < 1 || query.limit > MAX_LIMIT)) {
      errors.push(`limit must be between 1 and ${MAX_LIMIT}`);
    }

    if (query.offset !== undefined && query.offset < 0) {
      errors.push("offset must be >= 0");
    }

    if (query.select.length === 0) {
      errors.push("select must not be empty; use ['*'] to select all fields");
    }

    // Operators that expect no value
    const nullaryOps = new Set<WhereOperator>(["is_null", "is_not_null"]);
    // Operators that expect an array value
    const arrayOps = new Set<WhereOperator>(["in", "not_in"]);

    for (const clause of [...(query.where ?? []), ...(query.having ?? [])]) {
      if (nullaryOps.has(clause.operator)) {
        // is_null / is_not_null must not carry a value — carrying one indicates a
        // client bug that could produce confusing results if silently ignored.
        if (clause.value !== undefined) {
          errors.push(`Operator '${clause.operator}' must not have a value`);
        }
      } else if (arrayOps.has(clause.operator)) {
        if (!Array.isArray(clause.value)) {
          errors.push(`Operator '${clause.operator}' requires an array value`);
        }
      } else {
        if (clause.value === undefined) {
          errors.push(`Operator '${clause.operator}' requires a value`);
        }
      }
    }

    return errors;
  }

  // Build a parameterized WHERE fragment.
  // params is mutated in-place — each call appends to the parameter list.
  // Returns SQL fragment like: "schema"."table"."field" = $3
  function pgArrayType(fieldType: string | undefined): string {
    switch (fieldType) {
      case "number": return "numeric[]";
      case "boolean": return "boolean[]";
      case "date": return "timestamptz[]";
      default: return "text[]";
    }
  }

  function buildWhereFragment(
    schemaName: string,
    tableSlug: string,
    clauses: WhereClause[],
    params: unknown[],
    fieldTypes?: Map<string, string>,
  ): string {
    if (clauses.length === 0) return "";

    const parts = clauses.map((clause) => {
      const qField = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(tableSlug)}.${quotePgIdentifier(clause.field)}`;

      switch (clause.operator) {
        case "eq": {
          params.push(clause.value);
          return `${qField} = $${params.length}`;
        }
        case "neq": {
          params.push(clause.value);
          return `${qField} != $${params.length}`;
        }
        case "gt": {
          params.push(clause.value);
          return `${qField} > $${params.length}`;
        }
        case "gte": {
          params.push(clause.value);
          return `${qField} >= $${params.length}`;
        }
        case "lt": {
          params.push(clause.value);
          return `${qField} < $${params.length}`;
        }
        case "lte": {
          params.push(clause.value);
          return `${qField} <= $${params.length}`;
        }
        case "like": {
          const raw = typeof clause.value === "string" ? clause.value : String(clause.value);
          const escaped = raw.replace(/[\\%_]/g, (ch) => "\\" + ch);
          params.push(escaped);
          return `${qField} LIKE $${params.length} ESCAPE '\\'`;
        }
        case "in": {
          params.push(clause.value);
          const inCast = pgArrayType(fieldTypes?.get(clause.field));
          return `${qField} = ANY($${params.length}::${inCast})`;
        }
        case "not_in": {
          params.push(clause.value);
          const notInCast = pgArrayType(fieldTypes?.get(clause.field));
          return `NOT (${qField} = ANY($${params.length}::${notInCast}))`;
        }
        case "is_null":
          return `${qField} IS NULL`;
        case "is_not_null":
          return `${qField} IS NOT NULL`;
        default: {
          // TypeScript exhaustiveness — should never reach here after validation
          const _exhaustive: never = clause.operator;
          throw new QueryValidationError(`Unknown operator: ${String(_exhaustive)}`);
        }
      }
    });

    return parts.join(" AND ");
  }

  // Build the full SELECT SQL and parameter list.
  function buildSelectSql(
    schemaName: string,
    tableSlug: string,
    query: StructuredQuery,
    fieldTypes?: Map<string, string>,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];

    const qTable = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(tableSlug)}`;

    // SELECT clause
    const selectClause =
      query.select.includes("*")
        ? `${qTable}.*`
        : query.select.map((f) => `${qTable}.${quotePgIdentifier(f)}`).join(", ");

    let sql = `SELECT ${selectClause} FROM ${qTable}`;

    // WHERE
    const whereFragment = buildWhereFragment(schemaName, tableSlug, query.where ?? [], params, fieldTypes);
    if (whereFragment) {
      sql += ` WHERE ${whereFragment}`;
    }

    // GROUP BY
    if (query.groupBy && query.groupBy.length > 0) {
      const groupCols = query.groupBy
        .map((f) => `${qTable}.${quotePgIdentifier(f)}`)
        .join(", ");
      sql += ` GROUP BY ${groupCols}`;

      // HAVING (only meaningful with GROUP BY)
      const havingFragment = buildWhereFragment(schemaName, tableSlug, query.having ?? [], params, fieldTypes);
      if (havingFragment) {
        sql += ` HAVING ${havingFragment}`;
      }
    }

    // ORDER BY
    if (query.orderBy && query.orderBy.length > 0) {
      const orderParts = query.orderBy.map((ob) => {
        const dir = ob.direction === "desc" ? "DESC" : "ASC";
        return `${qTable}.${quotePgIdentifier(ob.field)} ${dir}`;
      });
      sql += ` ORDER BY ${orderParts.join(", ")}`;
    }

    // LIMIT / OFFSET
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    params.push(limit);
    sql += ` LIMIT $${params.length}`;

    if (query.offset !== undefined && query.offset > 0) {
      params.push(query.offset);
      sql += ` OFFSET $${params.length}`;
    }

    return { sql, params };
  }

  // Build a COUNT(*) query for the same filter, used for totalCount.
  function buildCountSql(
    schemaName: string,
    tableSlug: string,
    query: StructuredQuery,
    fieldTypes?: Map<string, string>,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const qTable = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(tableSlug)}`;

    let sql = `SELECT COUNT(*) AS total FROM ${qTable}`;

    const whereFragment = buildWhereFragment(schemaName, tableSlug, query.where ?? [], params, fieldTypes);
    if (whereFragment) {
      sql += ` WHERE ${whereFragment}`;
    }

    return { sql, params };
  }

  // Derive column metadata from a pg QueryResult.
  function extractColumns(
    pgResult: pg.QueryResult,
    fieldTypes: Map<string, string>,
  ): QueryColumn[] {
    return (pgResult.fields ?? []).map((f) => ({
      name: f.name,
      type: fieldTypes.get(f.name) ?? "unknown",
    }));
  }

  return {
    async validateQuery(tenantId, query) {
      const structuralErrors = validateStructure(query);
      if (structuralErrors.length > 0) {
        return { valid: false, errors: structuralErrors };
      }

      const { fieldSlugs } = await resolveEntityFields(tenantId, query.entityType);
      const fieldErrors = validateFieldReferences(query, fieldSlugs);

      return {
        valid: fieldErrors.length === 0,
        errors: fieldErrors,
      };
    },

    async executeQuery(tenantId, query) {
      // Full validation before touching the database
      const structuralErrors = validateStructure(query);
      if (structuralErrors.length > 0) {
        throw new QueryValidationError(
          `Query validation failed: ${structuralErrors.join("; ")}`,
        );
      }

      const { schemaName, tableSlug, fieldSlugs, fieldTypes } =
        await resolveEntityFields(tenantId, query.entityType);

      const fieldErrors = validateFieldReferences(query, fieldSlugs);
      if (fieldErrors.length > 0) {
        throw new QueryValidationError(
          `Query validation failed: ${fieldErrors.join("; ")}`,
        );
      }

      const { sql, params } = buildSelectSql(schemaName, tableSlug, query, fieldTypes);
      const { sql: countSql, params: countParams } = buildCountSql(schemaName, tableSlug, query, fieldTypes);

      const client = await db.connect();
      try {
        // Wrap in a transaction so SET LOCAL takes effect. SET LOCAL only
        // applies within a transaction block; without BEGIN it is silently
        // ignored and queries run without timeout protection.
        await client.query("BEGIN");

        // Per-query timeout: if the query exceeds 30 s, PostgreSQL cancels it.
        // This protects against runaway analytical queries on large tenants.
        await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);

        const startTime = Date.now();

        let pgResult: pg.QueryResult;
        let countResult: pg.QueryResult;

        try {
          [pgResult, countResult] = await Promise.all([
            client.query(sql, params),
            client.query(countSql, countParams),
          ]);
        } catch (err: unknown) {
          // PostgreSQL error code 57014 = query_canceled (fired by statement_timeout)
          const pgErr = err as { code?: string };
          if (pgErr.code === "57014") {
            throw new QueryTimeoutError(
              `Query exceeded the ${QUERY_TIMEOUT_MS / 1000}s timeout.`,
            );
          }
          throw err;
        } finally {
          // Always commit (read-only queries) to release the transaction and
          // ensure SET LOCAL is scoped properly.
          await client.query("COMMIT");
        }

        const executionTimeMs = Date.now() - startTime;
        const totalCount = parseInt(
          (countResult.rows[0] as { total: string } | undefined)?.total ?? "0",
          10,
        );

        return {
          columns: extractColumns(pgResult, fieldTypes),
          rows: pgResult.rows,
          totalCount,
          executionTimeMs,
        };
      } finally {
        client.release();
      }
    },
  };
}
