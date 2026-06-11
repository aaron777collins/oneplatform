import type pg from "pg";
import type { HookRow, CreateHookData, ResolvedHook } from "./types.js";
import type { HookState } from "../schemas/index.js";

const HOOK_COLUMNS = `
  id, plugin_id, instance_id, tenant_id, stage, criticality,
  priority, timeout_seconds, entrypoint, state, created_at, updated_at
`;

export class HookRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createMany(hooks: CreateHookData[]): Promise<HookRow[]> {
    if (hooks.length === 0) return [];

    // Build a bulk insert with parameterised values — never string-interpolated data.
    const valuePlaceholders = hooks.map((_, i) => {
      const base = i * 9;
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`;
    });
    const values = hooks.flatMap((h) => [
      h.plugin_id,
      h.instance_id,
      h.tenant_id,
      h.stage,
      h.criticality,
      h.priority,
      h.timeout_seconds,
      h.entrypoint,
      h.state,
    ]);

    const result = await this.pool.query<HookRow>(
      `INSERT INTO plugin.hooks
         (plugin_id, instance_id, tenant_id, stage, criticality, priority, timeout_seconds, entrypoint, state)
       VALUES ${valuePlaceholders.join(", ")}
       RETURNING ${HOOK_COLUMNS}`,
      values
    );
    return result.rows;
  }

  // Resolve the active hook chain for a stage + tenant.
  // The secondary ORDER BY id provides deterministic ordering when priorities collide.
  async resolveChain(stage: string, tenantId: string): Promise<ResolvedHook[]> {
    const result = await this.pool.query<{
      id: string;
      instance_id: string;
      plugin_id: string;
      tenant_id: string;
      stage: string;
      criticality: "critical" | "advisory";
      priority: number;
      timeout_ms: string;
      entrypoint: string;
      manifest_id: string;
      bundle_key: string;
      bundle_bucket: string;
      version: string;
      config: Record<string, unknown>;
    }>(
      `SELECT
           h.id,
           h.instance_id,
           h.plugin_id,
           h.tenant_id,
           h.stage,
           h.criticality,
           h.priority,
           h.timeout_seconds * 1000 AS timeout_ms,
           h.entrypoint,
           p.manifest_id,
           p.bundle_key,
           p.bundle_bucket,
           p.version,
           i.config
         FROM plugin.hooks h
         JOIN plugin.plugins p  ON h.plugin_id = p.id
         JOIN plugin.instances i ON h.instance_id = i.id
        WHERE h.stage     = $1
          AND h.tenant_id = $2
          AND h.state     = 'active'
        ORDER BY h.priority ASC, h.id ASC`,
      [stage, tenantId]
    );

    return result.rows.map((r) => ({
      hookId: r["id"],
      instanceId: r["instance_id"],
      tenantId: r["tenant_id"],
      stage: r["stage"],
      criticality: r["criticality"],
      priority: r["priority"],
      timeoutMs: parseInt(r["timeout_ms"], 10),
      entrypoint: r["entrypoint"],
      pluginId: r["plugin_id"],
      manifestId: r["manifest_id"],
      bundleBucket: r["bundle_bucket"],
      bundleKey: r["bundle_key"],
      version: r["version"],
      instanceConfig: r["config"],
    }));
  }

  // Transition all hooks for an instance to a new state in one statement.
  // This ensures partial state changes are impossible (spec §7.2).
  async updateStateByInstance(
    client: pg.PoolClient,
    instanceId: string,
    newState: HookState
  ): Promise<number> {
    const result = await client.query(
      `UPDATE plugin.hooks
          SET state = $1, updated_at = now()
        WHERE instance_id = $2`,
      [newState, instanceId]
    );
    return result.rowCount ?? 0;
  }

  // Transition all hooks for a plugin_id from one state to another.
  // Used during the atomic version swap.
  async updateStateByPluginAndCurrentState(
    client: pg.PoolClient,
    pluginId: string,
    fromState: HookState,
    toState: HookState
  ): Promise<number> {
    const result = await client.query(
      `UPDATE plugin.hooks
          SET state = $1, updated_at = now()
        WHERE plugin_id = $2
          AND state = $3`,
      [toState, pluginId, fromState]
    );
    return result.rowCount ?? 0;
  }

  // Disable all hooks for a manifest — used during uninstall.
  async disableAllByManifestId(manifestId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE plugin.hooks h
          SET state = 'disabled', updated_at = now()
         FROM plugin.plugins p
        WHERE h.plugin_id = p.id
          AND p.manifest_id = $1`,
      [manifestId]
    );
    return result.rowCount ?? 0;
  }

  async findByInstanceId(instanceId: string): Promise<HookRow[]> {
    const result = await this.pool.query<HookRow>(
      `SELECT ${HOOK_COLUMNS}
         FROM plugin.hooks
        WHERE instance_id = $1`,
      [instanceId]
    );
    return result.rows;
  }
}
