import type pg from "pg";
import type { TriggerRow, CreateTriggerData } from "./types.js";

const TRIGGER_COLUMNS = `
  id, pipeline_id, tenant_id, trigger_type,
  config, enabled, created_at, updated_at
`;

export class TriggerRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateTriggerData): Promise<TriggerRow> {
    const result = await this.pool.query<TriggerRow>(
      `INSERT INTO pipeline.triggers
         (pipeline_id, tenant_id, trigger_type, config, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${TRIGGER_COLUMNS}`,
      [
        data.pipeline_id,
        data.tenant_id,
        data.trigger_type,
        JSON.stringify(data.config),
        data.enabled ?? true,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO pipeline.triggers returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<TriggerRow | null> {
    const result = await this.pool.query<TriggerRow>(
      `SELECT ${TRIGGER_COLUMNS}
         FROM pipeline.triggers
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByPipelineId(pipelineId: string): Promise<TriggerRow[]> {
    const result = await this.pool.query<TriggerRow>(
      `SELECT ${TRIGGER_COLUMNS}
         FROM pipeline.triggers
        WHERE pipeline_id = $1
        ORDER BY created_at ASC, id ASC`,
      [pipelineId]
    );
    return result.rows;
  }

  async findByTenantId(tenantId: string): Promise<TriggerRow[]> {
    const result = await this.pool.query<TriggerRow>(
      `SELECT ${TRIGGER_COLUMNS}
         FROM pipeline.triggers
        WHERE tenant_id = $1
        ORDER BY created_at ASC, id ASC`,
      [tenantId]
    );
    return result.rows;
  }

  // Returns all enabled triggers of a specific type across all tenants.
  // Used at startup to establish Redis pub/sub subscriptions for 'event'
  // triggers, and to load webhook slug registrations for 'webhook' triggers.
  async findEnabledByType(
    triggerType: TriggerRow["trigger_type"]
  ): Promise<TriggerRow[]> {
    const result = await this.pool.query<TriggerRow>(
      `SELECT ${TRIGGER_COLUMNS}
         FROM pipeline.triggers
        WHERE trigger_type = $1
          AND enabled = true
        ORDER BY created_at ASC, id ASC`,
      [triggerType]
    );
    return result.rows;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM pipeline.triggers WHERE id = $1`,
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
