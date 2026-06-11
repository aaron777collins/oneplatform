import { randomBytes } from "node:crypto";
import { hash as bcryptHash, compare as bcryptCompare } from "bcryptjs";
import { encrypt, ForbiddenError } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import { WebhookReceiverNotFoundError } from "./errors.js";
import type {
  WebhookReceiverRepository,
  WebhookReceiverRow,
  UpdateWebhookReceiverData,
} from "./webhook-receive-service.js";
import type { CredentialService } from "./credential-service.js";

export interface WebhookReceiverInfo {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  receiveUrl: string;
  hmacAlgorithm: "sha256" | "sha512";
  headerName: string;
  connectorId: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastReceivedAt: string | null;
  eventsReceived: number;
}

export interface WebhookManagementService {
  createReceiver(
    tenantId: string,
    userId: string,
    input: {
      name: string;
      description?: string;
      connectorId?: string;
      hmacAlgorithm: "sha256" | "sha512";
      headerName: string;
    },
    masterKey: Buffer,
  ): Promise<{ receiver: WebhookReceiverInfo; secret: string }>;

  getReceiver(tenantId: string, id: string): Promise<WebhookReceiverInfo>;

  listReceivers(
    tenantId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{ data: WebhookReceiverInfo[]; pagination: { nextCursor: string | null; total: number } }>;

  updateReceiver(
    tenantId: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      connectorId?: string;
      hmacAlgorithm?: "sha256" | "sha512";
      headerName?: string;
      isEnabled?: boolean;
    },
  ): Promise<WebhookReceiverInfo>;

  deleteReceiver(tenantId: string, id: string): Promise<void>;

  rotateSecret(
    tenantId: string,
    id: string,
    currentSecret: string,
    masterKey: Buffer,
  ): Promise<{ secret: string }>;
}

export interface WebhookManagementServiceDeps {
  receiverRepo: WebhookReceiverRepository;
  credentialService: CredentialService;
  baseUrl: string;
  logger: Logger;
}

function toInfo(row: WebhookReceiverRow, baseUrl: string): WebhookReceiverInfo {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    receiveUrl: `${baseUrl}/api/v1/webhooks/inbound/${row.id}/receive`,
    hmacAlgorithm: row.hmac_algorithm,
    headerName: row.header_name,
    connectorId: row.connector_id,
    isEnabled: row.is_enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastReceivedAt: row.last_received_at?.toISOString() ?? null,
    eventsReceived: Number(row.events_received),
  };
}

export function createWebhookManagementService(
  deps: WebhookManagementServiceDeps,
): WebhookManagementService {
  const { receiverRepo, credentialService, baseUrl, logger } = deps;

  async function createReceiver(
    tenantId: string,
    userId: string,
    input: {
      name: string;
      description?: string;
      connectorId?: string;
      hmacAlgorithm: "sha256" | "sha512";
      headerName: string;
    },
    masterKey: Buffer,
  ): Promise<{ receiver: WebhookReceiverInfo; secret: string }> {
    const rawSecret = randomBytes(32).toString("hex");
    const secretHash = await bcryptHash(rawSecret, 12);

    const row = await receiverRepo.create({
      tenant_id: tenantId,
      name: input.name,
      path_suffix: crypto.randomUUID(),
      secret_hash: secretHash,
      hmac_algorithm: input.hmacAlgorithm,
      header_name: input.headerName,
      created_by: userId,
      ...(input.description ? { description: input.description } : {}),
      ...(input.connectorId ? { connector_id: input.connectorId } : {}),
    });

    // Store the raw secret encrypted in the credential vault for HMAC verification
    await credentialService.storeCredentials(
      row.id,
      { webhook_secret: rawSecret },
      masterKey,
    );

    logger.info("Webhook receiver created", { receiverId: row.id, tenantId });

    return {
      receiver: toInfo(row, baseUrl),
      secret: rawSecret,
    };
  }

  async function getReceiver(tenantId: string, id: string): Promise<WebhookReceiverInfo> {
    const row = await receiverRepo.findByTenantAndId(tenantId, id);
    if (!row) {
      throw new WebhookReceiverNotFoundError(`Webhook receiver ${id} not found`);
    }
    return toInfo(row, baseUrl);
  }

  async function listReceivers(
    tenantId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{ data: WebhookReceiverInfo[]; pagination: { nextCursor: string | null; total: number } }> {
    const result = await receiverRepo.listByTenantId(tenantId, query);
    return {
      data: result.items.map((r) => toInfo(r, baseUrl)),
      pagination: { nextCursor: result.nextCursor, total: result.total },
    };
  }

  async function updateReceiver(
    tenantId: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      connectorId?: string;
      hmacAlgorithm?: "sha256" | "sha512";
      headerName?: string;
      isEnabled?: boolean;
    },
  ): Promise<WebhookReceiverInfo> {
    const existing = await receiverRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      throw new WebhookReceiverNotFoundError(`Webhook receiver ${id} not found`);
    }

    const updateData: UpdateWebhookReceiverData = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.connectorId !== undefined) updateData.connector_id = input.connectorId;
    if (input.hmacAlgorithm !== undefined) updateData.hmac_algorithm = input.hmacAlgorithm;
    if (input.headerName !== undefined) updateData.header_name = input.headerName;
    if (input.isEnabled !== undefined) updateData.is_enabled = input.isEnabled;

    const updated = await receiverRepo.update(id, updateData);
    if (!updated) {
      throw new WebhookReceiverNotFoundError(`Webhook receiver ${id} not found after update`);
    }

    logger.info("Webhook receiver updated", { receiverId: id, tenantId });
    return toInfo(updated, baseUrl);
  }

  async function deleteReceiver(tenantId: string, id: string): Promise<void> {
    const existing = await receiverRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      throw new WebhookReceiverNotFoundError(`Webhook receiver ${id} not found`);
    }

    await receiverRepo.softDelete(id);
    await credentialService.deleteByConnectorId(id);

    logger.info("Webhook receiver deleted", { receiverId: id, tenantId });
  }

  async function rotateSecret(
    tenantId: string,
    id: string,
    currentSecret: string,
    masterKey: Buffer,
  ): Promise<{ secret: string }> {
    const existing = await receiverRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      throw new WebhookReceiverNotFoundError(`Webhook receiver ${id} not found`);
    }

    // Verify the current secret using the bcrypt hash.
    // Throws ForbiddenError (403) rather than WebhookReceiverNotFoundError so
    // the rotate-secret endpoint can surface a meaningful "wrong secret" response
    // without leaking receiver existence via a 404 (the receive endpoint does
    // that, but the management API sits behind authentication so enumeration is
    // already gated by tenantId ownership).
    const matches = await bcryptCompare(currentSecret, existing.secret_hash);
    if (!matches) {
      throw new ForbiddenError("Current secret does not match.");
    }

    // Generate a new secret
    const newSecret = randomBytes(32).toString("hex");
    const newHash = await bcryptHash(newSecret, 12);

    // Update the bcrypt hash in the receiver row
    await receiverRepo.update(id, { secret_hash: newHash });

    // Update the AES-encrypted secret in the credential vault
    await credentialService.storeCredentials(
      id,
      { webhook_secret: newSecret },
      masterKey,
    );

    logger.info("Webhook receiver secret rotated", { receiverId: id, tenantId });

    return { secret: newSecret };
  }

  return {
    createReceiver,
    getReceiver,
    listReceivers,
    updateReceiver,
    deleteReceiver,
    rotateSecret,
  };
}
