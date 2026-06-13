import type pg from "pg";
import type { WidgetDescriptor } from "../services/widget-service.js";

// ---------------------------------------------------------------------------
// WidgetRow — shape returned by app.widgets queries (snake_case mirrors SQL)
// ---------------------------------------------------------------------------

interface WidgetRow {
  widget_id:   string;
  app_id:      string;
  tenant_id:   string;
  name:        string;
  description: string;
  entrypoint:  string;
  category:    "dashboard" | "action" | "sidebar";
  width:       "narrow" | "full" | "auto";
  created_at:  Date;
}

const WIDGET_COLUMNS = `
  widget_id, app_id, tenant_id, name, description, entrypoint, category, width, created_at
`;

function rowToDescriptor(row: WidgetRow): WidgetDescriptor {
  return {
    widgetId:    row.widget_id,
    appId:       row.app_id,
    tenantId:    row.tenant_id,
    name:        row.name,
    description: row.description,
    entrypoint:  row.entrypoint,
    category:    row.category,
    width:       row.width,
    createdAt:   row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class WidgetRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Upsert so that re-registering on redeploy is idempotent. The widgetId is
  // deterministic (derived from appId + name), so a re-deploy of the same app
  // should update the descriptor fields without duplicating the row.
  async upsert(descriptor: WidgetDescriptor): Promise<WidgetDescriptor> {
    const result = await this.pool.query<WidgetRow>(
      `INSERT INTO app.widgets
         (widget_id, app_id, tenant_id, name, description, entrypoint, category, width, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, widget_id)
       DO UPDATE SET
         name        = EXCLUDED.name,
         description = EXCLUDED.description,
         entrypoint  = EXCLUDED.entrypoint,
         category    = EXCLUDED.category,
         width       = EXCLUDED.width
       RETURNING ${WIDGET_COLUMNS}`,
      [
        descriptor.widgetId,
        descriptor.appId,
        descriptor.tenantId,
        descriptor.name,
        descriptor.description,
        descriptor.entrypoint,
        descriptor.category,
        descriptor.width,
        new Date(descriptor.createdAt),
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `upsert into app.widgets returned no rows for widget_id="${descriptor.widgetId}"`
      );
    }

    return rowToDescriptor(row);
  }

  async findAll(): Promise<WidgetDescriptor[]> {
    const result = await this.pool.query<WidgetRow>(
      `SELECT ${WIDGET_COLUMNS} FROM app.widgets ORDER BY tenant_id, widget_id`
    );
    return result.rows.map(rowToDescriptor);
  }

  async delete(tenantId: string, widgetId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM app.widgets WHERE tenant_id = $1 AND widget_id = $2`,
      [tenantId, widgetId]
    );
  }
}
