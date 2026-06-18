import type pg from "pg";
import type { PipelineVersionRow } from "./types.js";

const VERSION_COLUMNS = `
  id, pipeline_id, tenant_id, version_number, definition_snapshot,
  name_at_version, description_at_version, created_at, created_by
`;

export class PipelineVersionRepository {
  constructor(private readonly pool: pg.Pool) {}

  // List all versions for a pipeline, newest first.
  // A cursor-based approach keyed on version_number desc keeps pages stable
  // even when new versions arrive between page fetches.
  async listByPipelineId(
    pipelineId: string,
    options?: {
      cursor?: number; // version_number of the last item on the previous page
      limit?: number;
    }
  ): Promise<PipelineVersionRow[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = ["pipeline_id = $1"];
    const values: unknown[] = [pipelineId];
    let idx = 2;

    // Cursor is the version_number of the last item returned. Because we order
    // descending, the next page starts below that number.
    if (options?.cursor !== undefined) {
      conditions.push(`version_number < $${idx++}`);
      values.push(options.cursor);
    }

    values.push(limit);

    const result = await this.pool.query<PipelineVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM pipeline.pipeline_versions
        WHERE ${conditions.join(" AND ")}
        ORDER BY version_number DESC
        LIMIT $${idx}`,
      values
    );
    return result.rows;
  }

  // Retrieve one specific version by its number.
  async findByPipelineIdAndVersionNumber(
    pipelineId: string,
    versionNumber: number
  ): Promise<PipelineVersionRow | null> {
    const result = await this.pool.query<PipelineVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM pipeline.pipeline_versions
        WHERE pipeline_id = $1
          AND version_number = $2`,
      [pipelineId, versionNumber]
    );
    return result.rows[0] ?? null;
  }
}
