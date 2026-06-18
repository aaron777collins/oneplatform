import type pg from "pg";
import type {
  DataResidencyPolicyRow,
  UpsertDataResidencyPolicyData,
  DataTransferRuleRow,
  CreateDataTransferRuleData,
  DataLocationLogRow,
  CreateDataLocationLogData,
  DataRegion,
} from "./types.js";

// ---------------------------------------------------------------------------
// DataResidencyPolicyRepository
// ---------------------------------------------------------------------------

const POLICY_COLUMNS = `
  id, tenant_id, region, storage_class, replication_policy, created_at, updated_at
`;

export class DataResidencyPolicyRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(data: UpsertDataResidencyPolicyData): Promise<DataResidencyPolicyRow> {
    const storageClass = data.storage_class ?? "standard";
    const replicationPolicy = data.replication_policy ?? "single_region";

    const result = await this.pool.query<DataResidencyPolicyRow>(
      `INSERT INTO gateway.data_residency_policies
         (tenant_id, region, storage_class, replication_policy)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET
         region = EXCLUDED.region,
         storage_class = EXCLUDED.storage_class,
         replication_policy = EXCLUDED.replication_policy
       RETURNING ${POLICY_COLUMNS}`,
      [data.tenant_id, data.region, storageClass, replicationPolicy],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("UPSERT INTO gateway.data_residency_policies returned no rows");
    }
    return row;
  }

  async findByTenantId(tenantId: string): Promise<DataResidencyPolicyRow | null> {
    const result = await this.pool.query<DataResidencyPolicyRow>(
      `SELECT ${POLICY_COLUMNS}
         FROM gateway.data_residency_policies
        WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  async deleteByTenantId(tenantId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM gateway.data_residency_policies WHERE tenant_id = $1`,
      [tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findByRegion(region: DataRegion): Promise<DataResidencyPolicyRow[]> {
    const result = await this.pool.query<DataResidencyPolicyRow>(
      `SELECT ${POLICY_COLUMNS}
         FROM gateway.data_residency_policies
        WHERE region = $1
        ORDER BY created_at DESC`,
      [region],
    );
    return result.rows;
  }

  async findAll(): Promise<DataResidencyPolicyRow[]> {
    const result = await this.pool.query<DataResidencyPolicyRow>(
      `SELECT ${POLICY_COLUMNS}
         FROM gateway.data_residency_policies
        ORDER BY created_at DESC`,
    );
    return result.rows;
  }
}

// ---------------------------------------------------------------------------
// DataTransferRuleRepository
// ---------------------------------------------------------------------------

const TRANSFER_RULE_COLUMNS = `
  id, source_region, target_region, policy, justification_required, created_at
`;

export class DataTransferRuleRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateDataTransferRuleData): Promise<DataTransferRuleRow> {
    const justificationRequired = data.justification_required ?? false;

    const result = await this.pool.query<DataTransferRuleRow>(
      `INSERT INTO gateway.data_transfer_rules
         (source_region, target_region, policy, justification_required)
       VALUES ($1, $2, $3, $4)
       RETURNING ${TRANSFER_RULE_COLUMNS}`,
      [data.source_region, data.target_region, data.policy, justificationRequired],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO gateway.data_transfer_rules returned no rows");
    }
    return row;
  }

  async findByRegions(
    sourceRegion: DataRegion,
    targetRegion: DataRegion,
  ): Promise<DataTransferRuleRow | null> {
    const result = await this.pool.query<DataTransferRuleRow>(
      `SELECT ${TRANSFER_RULE_COLUMNS}
         FROM gateway.data_transfer_rules
        WHERE source_region = $1 AND target_region = $2`,
      [sourceRegion, targetRegion],
    );
    return result.rows[0] ?? null;
  }

  async findAll(): Promise<DataTransferRuleRow[]> {
    const result = await this.pool.query<DataTransferRuleRow>(
      `SELECT ${TRANSFER_RULE_COLUMNS}
         FROM gateway.data_transfer_rules
        ORDER BY source_region, target_region`,
    );
    return result.rows;
  }

  async findBySourceRegion(sourceRegion: DataRegion): Promise<DataTransferRuleRow[]> {
    const result = await this.pool.query<DataTransferRuleRow>(
      `SELECT ${TRANSFER_RULE_COLUMNS}
         FROM gateway.data_transfer_rules
        WHERE source_region = $1
        ORDER BY target_region`,
      [sourceRegion],
    );
    return result.rows;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM gateway.data_transfer_rules WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// DataLocationLogRepository
// ---------------------------------------------------------------------------

const LOCATION_LOG_COLUMNS = `
  id, record_id, tenant_id, region, service, operation, actor_id, metadata, timestamp
`;

export class DataLocationLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateDataLocationLogData): Promise<DataLocationLogRow> {
    const operation = data.operation ?? "access";

    const result = await this.pool.query<DataLocationLogRow>(
      `INSERT INTO gateway.data_location_log
         (record_id, tenant_id, region, service, operation, actor_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LOCATION_LOG_COLUMNS}`,
      [
        data.record_id,
        data.tenant_id,
        data.region,
        data.service,
        operation,
        data.actor_id ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO gateway.data_location_log returned no rows");
    }
    return row;
  }

  async findByTenantId(
    tenantId: string,
    options?: {
      region?: DataRegion;
      service?: string;
      startTime?: Date;
      endTime?: Date;
      cursor?: string;
      limit?: number;
    },
  ): Promise<DataLocationLogRow[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
    let idx = 2;

    if (options?.region !== undefined) {
      conditions.push(`region = $${idx++}`);
      values.push(options.region);
    }
    if (options?.service !== undefined) {
      conditions.push(`service = $${idx++}`);
      values.push(options.service);
    }
    if (options?.startTime !== undefined) {
      conditions.push(`timestamp >= $${idx++}::timestamptz`);
      values.push(options.startTime.toISOString());
    }
    if (options?.endTime !== undefined) {
      conditions.push(`timestamp <= $${idx++}::timestamptz`);
      values.push(options.endTime.toISOString());
    }
    if (options?.cursor !== undefined) {
      const [cursorTs, cursorId] = options.cursor.split("|");
      if (cursorTs !== undefined && cursorId !== undefined) {
        conditions.push(
          `(timestamp, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`,
        );
        values.push(cursorTs, cursorId);
      }
    }

    values.push(limit);
    const result = await this.pool.query<DataLocationLogRow>(
      `SELECT ${LOCATION_LOG_COLUMNS}
         FROM gateway.data_location_log
        WHERE ${conditions.join(" AND ")}
        ORDER BY timestamp DESC, id DESC
        LIMIT $${idx}`,
      values,
    );
    return result.rows;
  }
}
