// GDPR data subject request orchestrator.
//
// This service is the single point of coordination for all GDPR requests.
// When a request is processed it fans out to each downstream service's internal
// deletion/anonymisation endpoint over service-to-service HTTP calls protected
// by an X-Service-Token bearer header.
//
// WHY the gateway owns this:
//   The gateway is the only service that knows the full topology (all service URLs).
//   Placing orchestration here avoids a dedicated GDPR service and keeps the
//   call graph simple: one writer (gateway), many readers (downstream services).
//
// Retention semantics for deletion:
//   - Auth: the user row is anonymised in-place (email hashed, name nulled) so
//     audit log FKs and session rows remain referentially valid.
//   - Logging: audit entries created BEFORE the retention cutoff are purged.
//   - Ingestion: connector configs owned by the user are removed.
//   - App: apps owned by the user are removed.
//
// GDPR compliance note: the gdpr_requests row itself is retained for 7 years
// (EU GDPR Art. 5(1)(e) storage limitation and Art. 30 accountability). The
// user_id stored there is the original ID, not personal data.

import { NotFoundError, ForbiddenError } from "@oneplatform/core";
import type { Logger, ServiceTokenSigner } from "@oneplatform/core";
import type { GdprRequestRepository } from "../repositories/gdpr-request-repository.js";
import type { GdprRequestRow, GdprRequestType } from "../repositories/types.js";
import type { StorageService } from "./storage-service.js";

// ---------------------------------------------------------------------------
// Configuration & dependencies
// ---------------------------------------------------------------------------

export interface GdprServiceConfig {
  /** URL of the auth service internal API. */
  authServiceUrl: string;
  /** URL of the logging service internal API. */
  loggingServiceUrl: string;
  /** URL of the ingestion service internal API. */
  ingestionServiceUrl: string;
  /** URL of the app service internal API. */
  appServiceUrl: string;
  /** Signer for service-to-service calls (Ed25519 JWT). */
  serviceTokenSigner?: ServiceTokenSigner;
  /** How many days of audit logs to retain on deletion. Default: 90. */
  auditRetentionDays?: number;
  /** Bucket name where GDPR exports are stored. Defaults to "gdpr-exports". */
  gdprExportBucket?: string;
  /** Presigned URL TTL in seconds for GDPR exports. Defaults to 86400 (24 h). */
  gdprExportUrlTtlSeconds?: number;
}

export interface GdprServiceDeps {
  gdprRequestRepo: GdprRequestRepository;
  logger: Logger;
  config: GdprServiceConfig;
  /** Object storage used to upload GDPR export files and generate presigned URLs. */
  storageService: StorageService;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GdprAccessPayload {
  userId: string;
  tenantId: string;
  exportedAt: string;
  profile: Record<string, unknown>;
  auditLog: Record<string, unknown>[];
}

export interface GdprExportResult {
  requestId: string;
  /** Presigned or inline JSON URL — currently returns inline JSON data URI for
   *  simplicity. Production deployments should upload to object storage and
   *  return a time-limited signed URL instead. */
  resultUrl: string;
}

export interface GdprService {
  /**
   * Gather all personal data held for a user and return it as a structured
   * payload. Updates the gdpr_requests row to completed when done.
   */
  handleAccessRequest(
    requestId: string,
    userId: string,
    tenantId: string,
  ): Promise<GdprAccessPayload>;

  /**
   * Anonymise / delete the user's personal data across all services.
   * Updates the gdpr_requests row to completed or failed when done.
   */
  handleDeletionRequest(
    requestId: string,
    userId: string,
    tenantId: string,
  ): Promise<void>;

  /**
   * Export all personal data as a JSON bundle.
   * Updates the gdpr_requests row with a result_url when done.
   */
  handleExportRequest(
    requestId: string,
    userId: string,
    tenantId: string,
  ): Promise<GdprExportResult>;

  /**
   * List all GDPR requests for a tenant with optional filters.
   */
  listRequests(
    tenantId: string,
    options?: {
      userId?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<GdprRequestRow[]>;

  /**
   * Fetch a single request by ID, enforcing tenant isolation.
   */
  getRequest(requestId: string, tenantId: string): Promise<GdprRequestRow>;

  /**
   * Persist a new GDPR request record and return it.
   * The caller is responsible for invoking the appropriate handle* method
   * asynchronously after creation so the HTTP response returns immediately.
   */
  createRequest(
    type: GdprRequestType,
    userId: string,
    tenantId: string,
    requesterId: string,
  ): Promise<GdprRequestRow>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30_000;

async function callService(
  url: string,
  method: "POST" | "DELETE" | "GET",
  serviceToken: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": serviceToken,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Service call to ${url} returned HTTP ${response.status}: ${text.slice(0, 256)}`,
      );
    }

    const json = await response.json().catch(() => ({}));
    return json as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGdprService(deps: GdprServiceDeps): GdprService {
  const { gdprRequestRepo, logger, config, storageService } = deps;
  const auditRetentionDays = config.auditRetentionDays ?? 90;

  // -------------------------------------------------------------------------
  // createRequest
  // -------------------------------------------------------------------------

  async function createRequest(
    type: GdprRequestType,
    userId: string,
    tenantId: string,
    requesterId: string,
  ): Promise<GdprRequestRow> {
    const row = await gdprRequestRepo.create({
      tenant_id: tenantId,
      user_id: userId,
      type,
      requester_id: requesterId,
    });

    logger.info("GDPR request created", {
      requestId: row.id,
      type,
      userId,
      tenantId,
      requesterId,
    });

    await logger.audit({
      actorId: requesterId,
      actorType: "user",
      tenantId,
      action: `gdpr.${type}_request.created`,
      resourceType: "gdpr_request",
      resourceId: row.id,
      result: "success",
      metadata: { userId, requestId: row.id },
    });

    return row;
  }

  // -------------------------------------------------------------------------
  // getRequest
  // -------------------------------------------------------------------------

  async function getRequest(requestId: string, tenantId: string): Promise<GdprRequestRow> {
    const row = await gdprRequestRepo.findById(requestId);
    if (row === null) {
      throw new NotFoundError(`GDPR request ${requestId} not found.`);
    }
    // Prevent cross-tenant access to another tenant's GDPR requests.
    if (row.tenant_id !== tenantId) {
      throw new ForbiddenError(`You do not have access to GDPR request ${requestId}.`);
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // listRequests
  // -------------------------------------------------------------------------

  async function listRequests(
    tenantId: string,
    options?: { userId?: string; status?: string; cursor?: string; limit?: number },
  ): Promise<GdprRequestRow[]> {
    return gdprRequestRepo.findByTenantId(tenantId, options);
  }

  // -------------------------------------------------------------------------
  // handleAccessRequest — gather data from auth + logging services
  // -------------------------------------------------------------------------

  async function handleAccessRequest(
    requestId: string,
    userId: string,
    tenantId: string,
  ): Promise<GdprAccessPayload> {
    await gdprRequestRepo.updateStatus(requestId, { status: "processing" });

    const token = config.serviceTokenSigner !== undefined ? await config.serviceTokenSigner.sign() : "";

    try {
      // Fetch the user's profile from auth service
      const profileData = await callService(
        `${config.authServiceUrl}/internal/gdpr/users/${userId}`,
        "GET",
        token,
      );

      // Fetch recent audit log entries for the user from the logging service
      const auditData = await callService(
        `${config.loggingServiceUrl}/internal/gdpr/audit-log?userId=${encodeURIComponent(userId)}&tenantId=${encodeURIComponent(tenantId)}`,
        "GET",
        token,
      );

      const payload: GdprAccessPayload = {
        userId,
        tenantId,
        exportedAt: new Date().toISOString(),
        profile: (profileData["data"] as Record<string, unknown>) ?? {},
        auditLog: (auditData["data"] as Record<string, unknown>[]) ?? [],
      };

      await gdprRequestRepo.updateStatus(requestId, {
        status: "completed",
        completed_at: new Date(),
      });

      logger.info("GDPR access request completed", { requestId, userId, tenantId });

      await logger.audit({
        actorId: userId,
        actorType: "user",
        tenantId,
        action: "gdpr.access_request.completed",
        resourceType: "gdpr_request",
        resourceId: requestId,
        result: "success",
        metadata: { userId },
      });

      return payload;
    } catch (err) {
      const errorDetail = err instanceof Error ? err.message : String(err);

      await gdprRequestRepo.updateStatus(requestId, {
        status: "failed",
        completed_at: new Date(),
        error_detail: errorDetail,
      });

      logger.error("GDPR access request failed", { requestId, userId, tenantId, error: errorDetail });

      await logger.audit({
        actorId: userId,
        actorType: "user",
        tenantId,
        action: "gdpr.access_request.failed",
        resourceType: "gdpr_request",
        resourceId: requestId,
        result: "failure",
        metadata: { userId, error: errorDetail },
      });

      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // handleDeletionRequest — fan out anonymisation calls to all services
  // -------------------------------------------------------------------------

  async function handleDeletionRequest(
    requestId: string,
    userId: string,
    tenantId: string,
  ): Promise<void> {
    await gdprRequestRepo.updateStatus(requestId, { status: "processing" });

    const token = config.serviceTokenSigner !== undefined ? await config.serviceTokenSigner.sign() : "";
    const errors: string[] = [];

    // Each service call is attempted independently so a partial failure still
    // anonymises as much data as possible. All errors are collected and reported.

    // 1. Auth service: anonymise user record (hash email, null display_name)
    //    The user row is retained because sessions, API keys, and audit FKs
    //    reference it — hard deletion would break referential integrity.
    try {
      await callService(
        `${config.authServiceUrl}/internal/gdpr/users/${userId}/anonymise`,
        "POST",
        token,
        { tenantId },
      );
    } catch (err) {
      errors.push(`auth: ${err instanceof Error ? err.message : String(err)}`);
      logger.warn("GDPR deletion: auth anonymisation failed", { requestId, userId, error: String(err) });
    }

    // 2. Logging service: purge user audit entries older than the retention cutoff
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - auditRetentionDays);
      await callService(
        `${config.loggingServiceUrl}/internal/gdpr/audit-log`,
        "DELETE",
        token,
        { userId, tenantId, olderThan: cutoff.toISOString() },
      );
    } catch (err) {
      errors.push(`logging: ${err instanceof Error ? err.message : String(err)}`);
      logger.warn("GDPR deletion: logging purge failed", { requestId, userId, error: String(err) });
    }

    // 3. Ingestion service: remove user-created connector configs
    try {
      await callService(
        `${config.ingestionServiceUrl}/internal/gdpr/connectors`,
        "DELETE",
        token,
        { userId, tenantId },
      );
    } catch (err) {
      errors.push(`ingestion: ${err instanceof Error ? err.message : String(err)}`);
      logger.warn("GDPR deletion: ingestion cleanup failed", { requestId, userId, error: String(err) });
    }

    // 4. App service: remove user-created apps
    try {
      await callService(
        `${config.appServiceUrl}/internal/gdpr/apps`,
        "DELETE",
        token,
        { userId, tenantId },
      );
    } catch (err) {
      errors.push(`app: ${err instanceof Error ? err.message : String(err)}`);
      logger.warn("GDPR deletion: app cleanup failed", { requestId, userId, error: String(err) });
    }

    if (errors.length > 0) {
      const errorDetail = errors.join("; ");
      await gdprRequestRepo.updateStatus(requestId, {
        status: "failed",
        completed_at: new Date(),
        error_detail: errorDetail,
      });

      logger.error("GDPR deletion request partially failed", {
        requestId,
        userId,
        tenantId,
        errors,
      });

      await logger.audit({
        actorId: userId,
        actorType: "user",
        tenantId,
        action: "gdpr.deletion_request.failed",
        resourceType: "gdpr_request",
        resourceId: requestId,
        result: "failure",
        metadata: { userId, errors },
      });

      // Fail loudly so callers know the deletion was incomplete.
      throw new Error(`GDPR deletion completed with errors: ${errorDetail}`);
    }

    await gdprRequestRepo.updateStatus(requestId, {
      status: "completed",
      completed_at: new Date(),
    });

    logger.info("GDPR deletion request completed", { requestId, userId, tenantId });

    await logger.audit({
      actorId: userId,
      actorType: "user",
      tenantId,
      action: "gdpr.deletion_request.completed",
      resourceType: "gdpr_request",
      resourceId: requestId,
      result: "success",
      metadata: { userId },
    });
  }

  // -------------------------------------------------------------------------
  // handleExportRequest — gather all data and produce a downloadable JSON blob
  // -------------------------------------------------------------------------

  async function handleExportRequest(
    requestId: string,
    userId: string,
    tenantId: string,
  ): Promise<GdprExportResult> {
    // Access is a superset of what export needs; reuse the same fan-out.
    const payload = await handleAccessRequest(requestId, userId, tenantId);

    // Upload the export to object storage under a tenant-scoped key so that
    // full PII is never stored inline in the DB as a data URI. A presigned URL
    // with a TTL is returned instead; the object is stored under the tenant
    // prefix so IAM bucket policies can enforce tenant isolation.
    const bucket = config.gdprExportBucket ?? "gdpr-exports";
    const ttlSeconds = config.gdprExportUrlTtlSeconds ?? 86400; // 24 hours
    const objectKey = `${tenantId}/${requestId}/export.json`;
    const jsonBytes = Buffer.from(JSON.stringify(payload, null, 2), "utf8");

    await storageService.putObject(bucket, objectKey, jsonBytes, "application/json");
    const { url: resultUrl } = await storageService.generatePresignedDownloadUrl(
      bucket,
      objectKey,
      ttlSeconds,
    );

    // The status was already set to completed by handleAccessRequest above.
    // We overwrite it with the presigned result_url.
    await gdprRequestRepo.updateStatus(requestId, {
      status: "completed",
      completed_at: new Date(),
      result_url: resultUrl,
    });

    logger.info("GDPR export request completed", { requestId, userId, tenantId });

    return { requestId, resultUrl };
  }

  return {
    createRequest,
    getRequest,
    listRequests,
    handleAccessRequest,
    handleDeletionRequest,
    handleExportRequest,
  };
}
