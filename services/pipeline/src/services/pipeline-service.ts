import type { Logger } from "@oneplatform/core";
import type { Pool } from "pg";
import type {
  PipelineRow as RepoPipelineRow,
  PipelineVersionRow as RepoPipelineVersionRow,
  CreatePipelineData,
  UpdatePipelineData,
} from "../repositories/types.js";
import {
  PipelineNotFoundError,
  PipelineRunsActiveError,
  PipelineValidationError,
  PipelineInvalidWebhookUrlError,
  PipelineVersionNotFoundError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Domain types — re-use the concrete repo row type.
// The service layer accesses definition as PipelineDefinition; we cast at the
// boundary rather than re-declaring an incompatible type here.
// ---------------------------------------------------------------------------

// PipelineRow is the concrete DB row type. definition is stored as JSONB and
// returned as Record<string,unknown>; callers inside the service cast it to
// PipelineDefinition after fetching (validated at write time).
export type PipelineRow = RepoPipelineRow;

// PipelineVersionRow mirrors the DB row for pipeline_versions.
export type PipelineVersionRow = RepoPipelineVersionRow;

// ---------------------------------------------------------------------------
// Step types (design spec §4.2)
// ---------------------------------------------------------------------------

export type StepType =
  | "code"
  | "connector"
  | "transformer"
  | "conditional"
  | "parallel"
  | "webhook";

export type InputSource =
  | { from: "pipeline.input"; path?: string }
  | { from: "step"; stepId: string; path?: string }
  | { from: "literal"; value: unknown };

export interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
}

export interface StepBase {
  id: string;
  name: string;
  type: StepType;
  inputs?: Record<string, InputSource>;
  onError?: "fail" | "skip";
  condition?: string;
  timeout?: number;
  // Per-step retry with exponential backoff. Defaults to no retries when absent.
  retryConfig?: RetryConfig;
  // Execute this step id when the step fails after exhausting all retries.
  // Takes precedence over onError when set.
  fallbackStepId?: string;
}

export interface CodeStep extends StepBase {
  type: "code";
  language: "javascript" | "typescript" | "python" | "go";
  code: string;
  entrypoint?: string;
}

export interface ConnectorStep extends StepBase {
  type: "connector";
  connectorInstanceId: string;
  syncMode?: "full" | "incremental";
  waitForCompletion: boolean;
}

export interface TransformerStep extends StepBase {
  type: "transformer";
  transformerId: string;
  config?: Record<string, unknown>;
  entityType?: string;
}

export interface ConditionalStep extends StepBase {
  type: "conditional";
  expression: string;
  trueBranchStepId: string;
  falseBranchStepId: string;
}

export interface ParallelBranch {
  id: string;
  entryStepId: string;
  steps: Step[];
}

export interface ParallelStep extends StepBase {
  type: "parallel";
  branches: ParallelBranch[];
  waitMode: "all" | "any";
}

export interface WebhookStep extends StepBase {
  type: "webhook";
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  responseMapping?: string;
  timeout?: number;
}

export type Step =
  | CodeStep
  | ConnectorStep
  | TransformerStep
  | ConditionalStep
  | ParallelStep
  | WebhookStep;

export interface PipelineOptions {
  maxConcurrentRuns?: number;
  allowConcurrentRuns?: boolean;
  stepTimeout?: number;
  retainRunsCount?: number;
}

export interface PipelineDefinition {
  version: 1;
  entryStepId: string;
  steps: Step[];
  options?: PipelineOptions;
  // Index signature allows PipelineDefinition to be stored/returned as
  // Record<string,unknown> at the JSONB boundary without a cast at every use site.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Repository interfaces — defined here so the service layer compiles
// independently of the concrete repository implementations being built in
// the parallel agent. Concrete repos must satisfy these shapes.
// ---------------------------------------------------------------------------

// These aliases expose the concrete repository input shapes through the service
// layer's PipelineRepository interface.
type RepoCreateInput = CreatePipelineData;
type RepoUpdateInput = UpdatePipelineData;

export interface PipelineListQuery {
  cursor?: string;
  limit: number;
  filterIsActive?: boolean;
  sort?: string;
}

export interface PipelineListResult {
  data: Array<{ pipeline: PipelineRow; lastRunAt: string | null }>;
  pagination: { nextCursor: string | null; total: number | null };
}

export interface PipelineRepository {
  create(data: RepoCreateInput): Promise<PipelineRow>;
  findById(id: string): Promise<PipelineRow | null>;
  findByTenantAndId(tenantId: string, id: string): Promise<PipelineRow | null>;
  findByTenantAndSlug(tenantId: string, slug: string): Promise<PipelineRow | null>;
  findByTenantId(tenantId: string, options?: { cursor?: string; limit?: number; filterIsActive?: boolean }): Promise<PipelineRow[]>;
  // updatedBy is forwarded to the version snapshot so the audit trail records who
  // initiated each change. Omitting it (legacy callers or non-definition-changing
  // updates) skips snapshot creation.
  update(id: string, data: RepoUpdateInput, updatedBy?: string): Promise<PipelineRow | null>;
  delete(id: string): Promise<boolean>;
}

export interface PipelineVersionRepository {
  listByPipelineId(
    pipelineId: string,
    options?: { cursor?: number; limit?: number }
  ): Promise<PipelineVersionRow[]>;
  findByPipelineIdAndVersionNumber(
    pipelineId: string,
    versionNumber: number
  ): Promise<PipelineVersionRow | null>;
}

export interface ScheduleRepoForPipeline {
  // Disables all schedules for a pipeline when it is set inactive, preventing
  // further cron triggers from firing against a paused pipeline.
  disableByPipelineId(pipelineId: string): Promise<void>;
}

export interface RunRepository {
  countActiveByPipelineId(pipelineId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Service input shapes
// ---------------------------------------------------------------------------

// The route layer passes a Zod-validated definition; we accept Record<string,unknown>
// at the service boundary to avoid exactOptionalPropertyTypes mismatch between the
// Zod-inferred type and PipelineDefinition. The definition is re-validated inside
// createPipeline/updatePipeline as PipelineDefinition before any I/O.
export interface CreatePipelineInput {
  name: string;
  slug?: string;
  description?: string;
  definition: Record<string, unknown>;
  isActive: boolean;
}

export interface UpdatePipelineInput {
  name?: string;
  description?: string | null;
  definition?: Record<string, unknown>;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// PipelineService — public interface
// ---------------------------------------------------------------------------

export interface PipelineVersionListResult {
  data: PipelineVersionRow[];
  pagination: { nextCursor: number | null };
}

export interface PipelineService {
  createPipeline(tenantId: string, userId: string, input: CreatePipelineInput): Promise<PipelineRow>;
  getPipeline(tenantId: string, id: string): Promise<PipelineRow>;
  listPipelines(tenantId: string, query: PipelineListQuery): Promise<PipelineListResult>;
  updatePipeline(tenantId: string, id: string, input: UpdatePipelineInput, updatedBy?: string): Promise<PipelineRow>;
  deletePipeline(tenantId: string, id: string): Promise<void>;
  validateDefinition(definition: PipelineDefinition): ValidationResult;
  listVersions(tenantId: string, pipelineId: string, options?: { cursor?: number; limit?: number }): Promise<PipelineVersionListResult>;
  getVersion(tenantId: string, pipelineId: string, versionNumber: number): Promise<PipelineVersionRow>;
  rollbackToVersion(tenantId: string, pipelineId: string, versionNumber: number, userId: string): Promise<PipelineRow>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface PipelineServiceDeps {
  pipelineRepo: PipelineRepository;
  versionRepo: PipelineVersionRepository;
  scheduleRepo: ScheduleRepoForPipeline;
  runRepo: RunRepository;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// RFC-1918 / loopback / link-local / metadata SSRF blocklist (design spec §4.2)
// We check at definition-save time; execution engine re-checks at runtime.
// ---------------------------------------------------------------------------

const SSRF_BLOCKED_PATTERNS = [
  // Loopback
  /^https?:\/\/localhost(:\d+)?\//i,
  /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/\[::1\](:\d+)?\//i,
  // RFC-1918 private ranges
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?\//,
  // Link-local
  /^https?:\/\/169\.254\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/\[fe80:/i,
  // AWS metadata endpoint
  /^https?:\/\/169\.254\.169\.254(:\d+)?\//,
  // GCP metadata
  /^https?:\/\/metadata\.google\.internal(:\d+)?\//i,
  // Azure metadata
  /^https?:\/\/169\.254\.169\.254(:\d+)?\//,
];

function isUrlSsrfBlocked(url: string): boolean {
  return SSRF_BLOCKED_PATTERNS.some((pattern) => pattern.test(url));
}

// ---------------------------------------------------------------------------
// Slug derivation — lowercase, spaces→hyphens, strip unsafe chars
// ---------------------------------------------------------------------------

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// Collect all step IDs from a definition, including those nested in parallel
// branches, for graph validation.
// ---------------------------------------------------------------------------

function collectAllStepIds(steps: Step[]): Set<string> {
  const ids = new Set<string>();
  for (const step of steps) {
    ids.add(step.id);
    if (step.type === "parallel") {
      for (const branch of step.branches) {
        for (const id of collectAllStepIds(branch.steps)) {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Cycle detection via DFS on the step graph.
// The graph edges are: conditional → trueBranch/falseBranch,
// sequential flow between steps in a flat array.
// We treat the steps array as an ordered list where each step's "next" is the
// following step in the array (or branch targets for conditionals).
// ---------------------------------------------------------------------------

function buildAdjacencyMap(steps: Step[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const neighbors: string[] = [];

    if (step.type === "conditional") {
      neighbors.push(step.trueBranchStepId, step.falseBranchStepId);
    } else if (step.type === "parallel") {
      for (const branch of step.branches) {
        neighbors.push(branch.entryStepId);
      }
      // Sequential next
      const next = steps[i + 1];
      if (next) neighbors.push(next.id);
    } else {
      const next = steps[i + 1];
      if (next) neighbors.push(next.id);
    }

    adj.set(step.id, neighbors);
  }

  return adj;
}

function hasCycle(adj: Map<string, string[]>, startId: string): boolean {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    inStack.add(nodeId);

    for (const neighbor of adj.get(nodeId) ?? []) {
      if (dfs(neighbor)) return true;
    }

    inStack.delete(nodeId);
    return false;
  }

  return dfs(startId);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPipelineService(deps: PipelineServiceDeps): PipelineService {
  const { pipelineRepo, versionRepo, scheduleRepo, runRepo, logger } = deps;

  // -------------------------------------------------------------------------
  // validateDefinition — pure graph validation, no I/O
  // -------------------------------------------------------------------------

  function validateDefinition(definition: PipelineDefinition): ValidationResult {
    const errors: string[] = [];
    const allStepIds = collectAllStepIds(definition.steps);

    // entryStepId must reference an existing step
    if (!allStepIds.has(definition.entryStepId)) {
      errors.push(`entryStepId "${definition.entryStepId}" does not reference an existing step.`);
    }

    for (const step of definition.steps) {
      // Validate conditional branch targets
      if (step.type === "conditional") {
        if (!allStepIds.has(step.trueBranchStepId)) {
          errors.push(`Step "${step.id}": trueBranchStepId "${step.trueBranchStepId}" not found.`);
        }
        if (!allStepIds.has(step.falseBranchStepId)) {
          errors.push(`Step "${step.id}": falseBranchStepId "${step.falseBranchStepId}" not found.`);
        }
      }

      // Validate parallel branch entry steps
      if (step.type === "parallel") {
        for (const branch of step.branches) {
          if (!allStepIds.has(branch.entryStepId)) {
            errors.push(
              `Step "${step.id}" branch "${branch.id}": entryStepId "${branch.entryStepId}" not found.`,
            );
          }
        }
      }

      // SSRF validation for webhook steps
      if (step.type === "webhook") {
        if (isUrlSsrfBlocked(step.url)) {
          errors.push(
            `Step "${step.id}": webhook URL "${step.url}" is blocked by the SSRF policy.`,
          );
        }
      }
    }

    // Cycle detection — only if all step IDs are resolvable
    if (errors.length === 0) {
      const adj = buildAdjacencyMap(definition.steps);
      if (hasCycle(adj, definition.entryStepId)) {
        errors.push("Pipeline definition contains a cycle in the step graph.");
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // createPipeline
  // -------------------------------------------------------------------------

  async function createPipeline(
    tenantId: string,
    userId: string,
    input: CreatePipelineInput,
  ): Promise<PipelineRow> {
    // Cast to PipelineDefinition for validation — input.definition is Record<string,unknown>
    // at the service boundary to accommodate the Zod-inferred type from the route layer.
    const definition = input.definition as unknown as PipelineDefinition;

    // Validate definition before any I/O
    const validation = validateDefinition(definition);
    if (!validation.valid) {
      throw new PipelineValidationError(
        `Pipeline definition is invalid: ${validation.errors.join("; ")}`,
        { errors: validation.errors },
      );
    }

    // Check for webhook step URLs via the stricter SSRF check (already done
    // inside validateDefinition, but we surface a dedicated error here for
    // webhook-specific rejections from definition validation)
    for (const step of definition.steps) {
      if (step.type === "webhook" && isUrlSsrfBlocked(step.url)) {
        throw new PipelineInvalidWebhookUrlError(
          `Step "${step.id}": webhook URL is blocked by the SSRF policy.`,
          { stepId: step.id, url: step.url },
        );
      }
    }

    const slug = input.slug ?? deriveSlug(input.name);

    const pipeline = await pipelineRepo.create({
      tenant_id: tenantId,
      name: input.name,
      slug,
      ...(input.description !== undefined ? { description: input.description } : {}),
      definition: input.definition,
      is_active: input.isActive,
      created_by: userId,
    });

    logger.info("Pipeline created", { tenantId, pipelineId: pipeline.id, slug });

    return pipeline;
  }

  // -------------------------------------------------------------------------
  // getPipeline
  // -------------------------------------------------------------------------

  async function getPipeline(tenantId: string, id: string): Promise<PipelineRow> {
    const pipeline = await pipelineRepo.findByTenantAndId(tenantId, id);
    if (pipeline === null) {
      throw new PipelineNotFoundError(
        `Pipeline "${id}" not found.`,
        { pipelineId: id, tenantId },
      );
    }
    return pipeline;
  }

  // -------------------------------------------------------------------------
  // listPipelines
  // -------------------------------------------------------------------------

  async function listPipelines(
    tenantId: string,
    query: PipelineListQuery,
  ): Promise<PipelineListResult> {
    const rows = await pipelineRepo.findByTenantId(tenantId, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
      ...(query.filterIsActive !== undefined ? { filterIsActive: query.filterIsActive } : {}),
    });

    const nextCursor = rows.length === query.limit
      ? (rows[rows.length - 1]?.id ?? null)
      : null;

    return {
      data: rows.map((pipeline) => ({ pipeline, lastRunAt: null })),
      pagination: { nextCursor, total: null },
    };
  }

  // -------------------------------------------------------------------------
  // updatePipeline
  // -------------------------------------------------------------------------

  async function updatePipeline(
    tenantId: string,
    id: string,
    input: UpdatePipelineInput,
    updatedBy?: string,
  ): Promise<PipelineRow> {
    // Verify ownership before update
    await getPipeline(tenantId, id);

    // Re-validate definition if it is being changed.
    // Cast to PipelineDefinition for validation — the service boundary accepts
    // Record<string,unknown> to avoid exactOptionalPropertyTypes mismatches.
    if (input.definition !== undefined) {
      const newDefinition = input.definition as unknown as PipelineDefinition;
      const validation = validateDefinition(newDefinition);
      if (!validation.valid) {
        throw new PipelineValidationError(
          `Pipeline definition is invalid: ${validation.errors.join("; ")}`,
          { errors: validation.errors },
        );
      }

      for (const step of newDefinition.steps) {
        if (step.type === "webhook" && isUrlSsrfBlocked(step.url)) {
          throw new PipelineInvalidWebhookUrlError(
            `Step "${step.id}": webhook URL is blocked by the SSRF policy.`,
            { stepId: step.id, url: step.url },
          );
        }
      }
    }

    // Deactivating the pipeline: immediately pause all its enabled schedules
    // so no further cron runs fire. The schedule service's in-memory entries
    // are invalidated on the next cron tick via DB re-query.
    if (input.isActive === false) {
      await scheduleRepo.disableByPipelineId(id);
      logger.info("Schedules paused for inactive pipeline", { tenantId, pipelineId: id });
    }

    const repoData: RepoUpdateInput = {};
    if (input.name !== undefined) repoData.name = input.name;
    if (input.description !== undefined) repoData.description = input.description;
    if (input.definition !== undefined) repoData.definition = input.definition;
    if (input.isActive !== undefined) repoData.is_active = input.isActive;

    // Pass updatedBy through to the repository so that the version snapshot
    // (taken atomically inside the transaction) records who triggered this change.
    const updated = await pipelineRepo.update(id, repoData, updatedBy);
    if (updated === null) {
      // The row was removed between our ownership check and this UPDATE — treat as not found.
      throw new PipelineNotFoundError(
        `Pipeline "${id}" not found.`,
        { pipelineId: id, tenantId },
      );
    }

    logger.info("Pipeline updated", { tenantId, pipelineId: id, version: updated.current_version });

    return updated;
  }

  // -------------------------------------------------------------------------
  // deletePipeline
  // -------------------------------------------------------------------------

  async function deletePipeline(tenantId: string, id: string): Promise<void> {
    // Verify ownership
    await getPipeline(tenantId, id);

    // Reject deletion when active runs exist to prevent data consistency issues
    const activeCount = await runRepo.countActiveByPipelineId(id);
    if (activeCount > 0) {
      throw new PipelineRunsActiveError(
        `Pipeline "${id}" has ${activeCount} active run(s). Cancel them before deleting.`,
        { pipelineId: id, activeRunCount: activeCount },
      );
    }

    await pipelineRepo.delete(id);

    logger.info("Pipeline deleted", { tenantId, pipelineId: id });
  }

  // -------------------------------------------------------------------------
  // listVersions
  // -------------------------------------------------------------------------

  async function listVersions(
    tenantId: string,
    pipelineId: string,
    options?: { cursor?: number; limit?: number },
  ): Promise<PipelineVersionListResult> {
    // Ownership check — prevents tenant A from listing versions of tenant B's pipeline.
    await getPipeline(tenantId, pipelineId);

    const limit = options?.limit ?? 50;
    const rows = await versionRepo.listByPipelineId(pipelineId, {
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
      limit,
    });

    // nextCursor is the version_number of the last item; the next page asks for
    // items with version_number < that value (desc order).
    const nextCursor =
      rows.length === limit ? (rows[rows.length - 1]?.version_number ?? null) : null;

    return { data: rows, pagination: { nextCursor } };
  }

  // -------------------------------------------------------------------------
  // getVersion
  // -------------------------------------------------------------------------

  async function getVersion(
    tenantId: string,
    pipelineId: string,
    versionNumber: number,
  ): Promise<PipelineVersionRow> {
    // Ownership check first.
    await getPipeline(tenantId, pipelineId);

    const version = await versionRepo.findByPipelineIdAndVersionNumber(pipelineId, versionNumber);
    if (version === null) {
      throw new PipelineVersionNotFoundError(
        `Version ${versionNumber} of pipeline "${pipelineId}" not found.`,
        { pipelineId, versionNumber },
      );
    }
    return version;
  }

  // -------------------------------------------------------------------------
  // rollbackToVersion
  // -------------------------------------------------------------------------

  async function rollbackToVersion(
    tenantId: string,
    pipelineId: string,
    versionNumber: number,
    userId: string,
  ): Promise<PipelineRow> {
    // getVersion performs the ownership check and throws PipelineVersionNotFoundError
    // when the requested version does not exist.
    const version = await getVersion(tenantId, pipelineId, versionNumber);

    // The snapshot is already validated — it was a valid definition when originally
    // saved. We still re-validate to catch any schema changes since that snapshot.
    const restoredDef = version.definition_snapshot as unknown as PipelineDefinition;
    const validation = validateDefinition(restoredDef);
    if (!validation.valid) {
      throw new PipelineValidationError(
        `Version ${versionNumber} definition is no longer valid: ${validation.errors.join("; ")}`,
        { errors: validation.errors },
      );
    }

    // Rollback is treated as a new update — it creates its own version snapshot of
    // the current state before restoring the old one. This preserves the full history
    // (the "undo" itself is versioned), and the pipeline's current_version increments.
    return updatePipeline(
      tenantId,
      pipelineId,
      {
        definition: version.definition_snapshot,
        name: version.name_at_version,
        ...(version.description_at_version !== null
          ? { description: version.description_at_version }
          : {}),
      },
      userId,
    );
  }

  return {
    createPipeline,
    getPipeline,
    listPipelines,
    updatePipeline,
    deletePipeline,
    validateDefinition,
    listVersions,
    getVersion,
    rollbackToVersion,
  };
}
