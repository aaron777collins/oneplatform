// Data residency controls service.
//
// This service is the authoritative layer for managing geographic data
// residency policies, cross-region transfer rules, and compliance audit
// logging. It enforces data sovereignty regulations by ensuring tenant
// data operations are scoped to their assigned region.
//
// WHY the gateway owns this:
//   The gateway intercepts every API request before it reaches downstream
//   services. Enforcing residency here means no downstream service can
//   accidentally process data in the wrong region — the check happens
//   before any routing decision is made.
//
// Fail-closed design:
//   If a tenant has no residency policy, operations proceed (opt-in model).
//   If a cross-region transfer has no matching rule, it is DENIED by default.

import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import type { DataResidencyPolicyRepository } from "../repositories/data-residency-repository.js";
import type { DataTransferRuleRepository } from "../repositories/data-residency-repository.js";
import type { DataLocationLogRepository } from "../repositories/data-residency-repository.js";
import type {
  DataResidencyPolicyRow,
  DataTransferRuleRow,
  DataLocationLogRow,
  DataRegion,
  StorageClass,
  ReplicationPolicy,
  TransferPolicy,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Region definitions
// ---------------------------------------------------------------------------

export const DATA_REGIONS: readonly DataRegion[] = [
  "US_EAST",
  "US_WEST",
  "EU_WEST",
  "EU_CENTRAL",
  "AP_SOUTHEAST",
  "AP_NORTHEAST",
] as const;

export const REGION_METADATA: Record<DataRegion, { name: string; location: string; jurisdiction: string }> = {
  US_EAST: { name: "US East (Virginia)", location: "us-east-1", jurisdiction: "US" },
  US_WEST: { name: "US West (Oregon)", location: "us-west-2", jurisdiction: "US" },
  EU_WEST: { name: "EU West (Ireland)", location: "eu-west-1", jurisdiction: "EU" },
  EU_CENTRAL: { name: "EU Central (Frankfurt)", location: "eu-central-1", jurisdiction: "EU" },
  AP_SOUTHEAST: { name: "Asia Pacific (Singapore)", location: "ap-southeast-1", jurisdiction: "APAC" },
  AP_NORTHEAST: { name: "Asia Pacific (Tokyo)", location: "ap-northeast-1", jurisdiction: "APAC" },
};

// ---------------------------------------------------------------------------
// Configuration & dependencies
// ---------------------------------------------------------------------------

export interface DataResidencyServiceDeps {
  policyRepo: DataResidencyPolicyRepository;
  transferRuleRepo: DataTransferRuleRepository;
  locationLogRepo: DataLocationLogRepository;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RegionInfo {
  region: DataRegion;
  name: string;
  location: string;
  jurisdiction: string;
}

export interface TransferEvaluation {
  allowed: boolean;
  policy: TransferPolicy;
  justificationRequired: boolean;
  rule: DataTransferRuleRow | null;
}

export interface DataResidencyService {
  /**
   * List all available regions with metadata.
   */
  listRegions(): RegionInfo[];

  /**
   * Validate that a region string is a known region.
   */
  isValidRegion(region: string): region is DataRegion;

  /**
   * Get the residency policy for a specific tenant.
   */
  getPolicy(tenantId: string): Promise<DataResidencyPolicyRow | null>;

  /**
   * Create or update the residency policy for a tenant.
   */
  upsertPolicy(
    tenantId: string,
    region: DataRegion,
    options?: {
      storageClass?: StorageClass;
      replicationPolicy?: ReplicationPolicy;
    },
  ): Promise<DataResidencyPolicyRow>;

  /**
   * Remove the residency policy for a tenant (reverts to unrestricted).
   */
  deletePolicy(tenantId: string): Promise<void>;

  /**
   * List all cross-region transfer rules.
   */
  listTransferRules(): Promise<DataTransferRuleRow[]>;

  /**
   * Get transfer rules from a specific source region.
   */
  getTransferRulesFromRegion(sourceRegion: DataRegion): Promise<DataTransferRuleRow[]>;

  /**
   * Create a new cross-region transfer rule.
   */
  createTransferRule(
    sourceRegion: DataRegion,
    targetRegion: DataRegion,
    policy: TransferPolicy,
    justificationRequired?: boolean,
  ): Promise<DataTransferRuleRow>;

  /**
   * Delete a transfer rule by ID.
   */
  deleteTransferRule(ruleId: string): Promise<void>;

  /**
   * Evaluate whether a cross-region transfer is permitted.
   * Returns the evaluation result including the matched rule (if any).
   */
  evaluateTransfer(
    sourceRegion: DataRegion,
    targetRegion: DataRegion,
  ): Promise<TransferEvaluation>;

  /**
   * Enforce residency policy for a tenant operation.
   * Throws ForbiddenError if the operation violates the policy.
   * Returns the tenant's assigned region (or null if no policy exists).
   */
  enforcePolicy(
    tenantId: string,
    requestRegion: DataRegion,
    service: string,
    options?: {
      recordId?: string;
      actorId?: string;
      operation?: string;
      justification?: string;
    },
  ): Promise<DataRegion | null>;

  /**
   * Log a data location event for audit purposes.
   */
  logDataLocation(
    recordId: string,
    tenantId: string,
    region: DataRegion,
    service: string,
    options?: {
      operation?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<DataLocationLogRow>;

  /**
   * Query the data location audit log for a tenant.
   */
  queryAuditLog(
    tenantId: string,
    options?: {
      region?: DataRegion;
      service?: string;
      startTime?: Date;
      endTime?: Date;
      cursor?: string;
      limit?: number;
    },
  ): Promise<DataLocationLogRow[]>;

  /**
   * Check compliance: verify that all data for a tenant is in their assigned region.
   * Returns true if compliant or no policy exists (opt-in model).
   */
  checkCompliance(tenantId: string): Promise<{
    compliant: boolean;
    assignedRegion: DataRegion | null;
    violations: Array<{ region: DataRegion; count: number }>;
  }>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDataResidencyService(deps: DataResidencyServiceDeps): DataResidencyService {
  const { policyRepo, transferRuleRepo, locationLogRepo, logger } = deps;

  // -------------------------------------------------------------------------
  // listRegions
  // -------------------------------------------------------------------------

  function listRegions(): RegionInfo[] {
    return DATA_REGIONS.map((region) => ({
      region,
      ...REGION_METADATA[region],
    }));
  }

  // -------------------------------------------------------------------------
  // isValidRegion
  // -------------------------------------------------------------------------

  function isValidRegion(region: string): region is DataRegion {
    return (DATA_REGIONS as readonly string[]).includes(region);
  }

  // -------------------------------------------------------------------------
  // getPolicy
  // -------------------------------------------------------------------------

  async function getPolicy(tenantId: string): Promise<DataResidencyPolicyRow | null> {
    return policyRepo.findByTenantId(tenantId);
  }

  // -------------------------------------------------------------------------
  // upsertPolicy
  // -------------------------------------------------------------------------

  async function upsertPolicy(
    tenantId: string,
    region: DataRegion,
    options?: {
      storageClass?: StorageClass;
      replicationPolicy?: ReplicationPolicy;
    },
  ): Promise<DataResidencyPolicyRow> {
    if (!isValidRegion(region)) {
      throw new ValidationError(`Invalid region: ${region}. Valid regions: ${DATA_REGIONS.join(", ")}`);
    }

    const row = await policyRepo.upsert({
      tenant_id: tenantId,
      region,
      ...(options?.storageClass !== undefined ? { storage_class: options.storageClass } : {}),
      ...(options?.replicationPolicy !== undefined ? { replication_policy: options.replicationPolicy } : {}),
    });

    logger.info("Data residency policy upserted", {
      tenantId,
      region,
      storageClass: row.storage_class,
      replicationPolicy: row.replication_policy,
    });

    await logger.audit({
      actorId: tenantId,
      actorType: "service",
      tenantId,
      action: "data_residency.policy.upserted",
      resourceType: "data_residency_policy",
      resourceId: row.id,
      result: "success",
      metadata: { region, storageClass: row.storage_class, replicationPolicy: row.replication_policy },
    });

    return row;
  }

  // -------------------------------------------------------------------------
  // deletePolicy
  // -------------------------------------------------------------------------

  async function deletePolicy(tenantId: string): Promise<void> {
    const deleted = await policyRepo.deleteByTenantId(tenantId);
    if (!deleted) {
      throw new NotFoundError(`No data residency policy found for tenant ${tenantId}.`);
    }

    logger.info("Data residency policy deleted", { tenantId });

    await logger.audit({
      actorId: tenantId,
      actorType: "service",
      tenantId,
      action: "data_residency.policy.deleted",
      resourceType: "data_residency_policy",
      resourceId: tenantId,
      result: "success",
      metadata: {},
    });
  }

  // -------------------------------------------------------------------------
  // listTransferRules
  // -------------------------------------------------------------------------

  async function listTransferRules(): Promise<DataTransferRuleRow[]> {
    return transferRuleRepo.findAll();
  }

  // -------------------------------------------------------------------------
  // getTransferRulesFromRegion
  // -------------------------------------------------------------------------

  async function getTransferRulesFromRegion(sourceRegion: DataRegion): Promise<DataTransferRuleRow[]> {
    return transferRuleRepo.findBySourceRegion(sourceRegion);
  }

  // -------------------------------------------------------------------------
  // createTransferRule
  // -------------------------------------------------------------------------

  async function createTransferRule(
    sourceRegion: DataRegion,
    targetRegion: DataRegion,
    policy: TransferPolicy,
    justificationRequired?: boolean,
  ): Promise<DataTransferRuleRow> {
    if (!isValidRegion(sourceRegion)) {
      throw new ValidationError(`Invalid source region: ${sourceRegion}.`);
    }
    if (!isValidRegion(targetRegion)) {
      throw new ValidationError(`Invalid target region: ${targetRegion}.`);
    }
    if (sourceRegion === targetRegion) {
      throw new ValidationError("Source and target regions must be different.");
    }

    try {
      const row = await transferRuleRepo.create({
        source_region: sourceRegion,
        target_region: targetRegion,
        policy,
        ...(justificationRequired !== undefined ? { justification_required: justificationRequired } : {}),
      });

      logger.info("Data transfer rule created", {
        ruleId: row.id,
        sourceRegion,
        targetRegion,
        policy,
        justificationRequired: row.justification_required,
      });

      return row;
    } catch (err) {
      // Handle unique constraint violation (duplicate source-target pair)
      if (err instanceof Error && err.message.includes("duplicate key")) {
        throw new ConflictError(
          `A transfer rule already exists for ${sourceRegion} -> ${targetRegion}.`,
        );
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // deleteTransferRule
  // -------------------------------------------------------------------------

  async function deleteTransferRule(ruleId: string): Promise<void> {
    const deleted = await transferRuleRepo.deleteById(ruleId);
    if (!deleted) {
      throw new NotFoundError(`Transfer rule ${ruleId} not found.`);
    }

    logger.info("Data transfer rule deleted", { ruleId });
  }

  // -------------------------------------------------------------------------
  // evaluateTransfer
  // -------------------------------------------------------------------------

  async function evaluateTransfer(
    sourceRegion: DataRegion,
    targetRegion: DataRegion,
  ): Promise<TransferEvaluation> {
    // Same-region transfers are always allowed
    if (sourceRegion === targetRegion) {
      return {
        allowed: true,
        policy: "allow",
        justificationRequired: false,
        rule: null,
      };
    }

    const rule = await transferRuleRepo.findByRegions(sourceRegion, targetRegion);

    // No rule = fail-closed (deny by default)
    if (rule === null) {
      return {
        allowed: false,
        policy: "deny",
        justificationRequired: false,
        rule: null,
      };
    }

    return {
      allowed: rule.policy !== "deny",
      policy: rule.policy,
      justificationRequired: rule.justification_required,
      rule,
    };
  }

  // -------------------------------------------------------------------------
  // enforcePolicy
  // -------------------------------------------------------------------------

  async function enforcePolicy(
    tenantId: string,
    requestRegion: DataRegion,
    service: string,
    options?: {
      recordId?: string;
      actorId?: string;
      operation?: string;
      justification?: string;
    },
  ): Promise<DataRegion | null> {
    const policy = await policyRepo.findByTenantId(tenantId);

    // No policy = no restrictions (opt-in model)
    if (policy === null) {
      return null;
    }

    const tenantRegion = policy.region;

    // Same-region access is always permitted
    if (requestRegion === tenantRegion) {
      // Log the access
      await locationLogRepo.create({
        record_id: options?.recordId ?? "request",
        tenant_id: tenantId,
        region: requestRegion,
        service,
        operation: options?.operation ?? "access",
        ...(options?.actorId !== undefined ? { actor_id: options.actorId } : {}),
      });

      return tenantRegion;
    }

    // Cross-region access — evaluate transfer rules
    const evaluation = await evaluateTransfer(tenantRegion, requestRegion);

    // Log the cross-region access attempt regardless of outcome
    const logEntry = await locationLogRepo.create({
      record_id: options?.recordId ?? "request",
      tenant_id: tenantId,
      region: requestRegion,
      service,
      operation: options?.operation ?? "cross_region_access",
      ...(options?.actorId !== undefined ? { actor_id: options.actorId } : {}),
      metadata: {
        sourceRegion: tenantRegion,
        targetRegion: requestRegion,
        transferPolicy: evaluation.policy,
        allowed: evaluation.allowed,
        ...(options?.justification !== undefined ? { justification: options.justification } : {}),
      },
    });

    if (!evaluation.allowed) {
      logger.warn("Cross-region data access denied", {
        tenantId,
        tenantRegion,
        requestRegion,
        service,
        logId: logEntry.id,
      });

      throw new ForbiddenError(
        `Data residency violation: tenant is assigned to region ${tenantRegion} but the request targets region ${requestRegion}. Cross-region transfer is denied.`,
      );
    }

    if (evaluation.justificationRequired && !options?.justification) {
      throw new ValidationError(
        `Cross-region transfer from ${tenantRegion} to ${requestRegion} requires a justification. Provide a 'justification' field in the request.`,
      );
    }

    if (evaluation.policy === "audit") {
      logger.info("Cross-region data access audited", {
        tenantId,
        tenantRegion,
        requestRegion,
        service,
        logId: logEntry.id,
        justification: options?.justification,
      });

      await logger.audit({
        actorId: options?.actorId ?? tenantId,
        actorType: options?.actorId ? "user" : "service",
        tenantId,
        action: "data_residency.cross_region_access.audited",
        resourceType: "data_location_log",
        resourceId: logEntry.id,
        result: "success",
        metadata: {
          sourceRegion: tenantRegion,
          targetRegion: requestRegion,
          service,
          justification: options?.justification ?? null,
        },
      });
    }

    return tenantRegion;
  }

  // -------------------------------------------------------------------------
  // logDataLocation
  // -------------------------------------------------------------------------

  async function logDataLocation(
    recordId: string,
    tenantId: string,
    region: DataRegion,
    service: string,
    options?: {
      operation?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<DataLocationLogRow> {
    return locationLogRepo.create({
      record_id: recordId,
      tenant_id: tenantId,
      region,
      service,
      ...(options?.operation !== undefined ? { operation: options.operation } : {}),
      ...(options?.actorId !== undefined ? { actor_id: options.actorId } : {}),
      ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // queryAuditLog
  // -------------------------------------------------------------------------

  async function queryAuditLog(
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
    return locationLogRepo.findByTenantId(tenantId, options);
  }

  // -------------------------------------------------------------------------
  // checkCompliance
  // -------------------------------------------------------------------------

  async function checkCompliance(tenantId: string): Promise<{
    compliant: boolean;
    assignedRegion: DataRegion | null;
    violations: Array<{ region: DataRegion; count: number }>;
  }> {
    const policy = await policyRepo.findByTenantId(tenantId);

    if (policy === null) {
      return { compliant: true, assignedRegion: null, violations: [] };
    }

    // Query the audit log to find any access from non-assigned regions
    // that were not explicitly allowed.
    const allLogs = await locationLogRepo.findByTenantId(tenantId, { limit: 10000 });
    const violationMap = new Map<DataRegion, number>();

    for (const log of allLogs) {
      if (log.region !== policy.region) {
        const current = violationMap.get(log.region) ?? 0;
        violationMap.set(log.region, current + 1);
      }
    }

    const violations = Array.from(violationMap.entries()).map(([region, count]) => ({
      region,
      count,
    }));

    return {
      compliant: violations.length === 0,
      assignedRegion: policy.region,
      violations,
    };
  }

  return {
    listRegions,
    isValidRegion,
    getPolicy,
    upsertPolicy,
    deletePolicy,
    listTransferRules,
    getTransferRulesFromRegion,
    createTransferRule,
    deleteTransferRule,
    evaluateTransfer,
    enforcePolicy,
    logDataLocation,
    queryAuditLog,
    checkCompliance,
  };
}
