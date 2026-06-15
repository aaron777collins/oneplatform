import { encrypt, decrypt } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import {
  CredentialDecryptFailedError,
  CredentialNotFoundError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Repository interface — matches the concrete CredentialRepository class in
// services/ingestion/src/repositories/credential-repository.ts exactly.
// ---------------------------------------------------------------------------

export interface CredentialRow {
  id: string;
  connector_id: string;
  field_name: string;
  encrypted_blob: string;
  key_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertCredentialData {
  connector_id: string;
  field_name: string;
  encrypted_blob: string;
  key_version: number;
}

export interface CredentialRepository {
  upsert(data: UpsertCredentialData): Promise<CredentialRow>;
  findByConnectorId(connectorId: string): Promise<CredentialRow[]>;
  findByConnectorIdAndField(connectorId: string, fieldName: string): Promise<CredentialRow | null>;
  deleteByConnectorId(connectorId: string): Promise<number>;
  updateKeyVersion(
    id: string,
    newEncryptedBlob: string,
    newKeyVersion: number,
    oldKeyVersion: number,
  ): Promise<boolean>;
  findOutstandingForRotation(targetKeyVersion: number): Promise<CredentialRow[]>;
}

// ---------------------------------------------------------------------------
// CredentialAccessor — injected into connector plugin context for lazy,
// cached credential decryption scoped to a single sync job lifetime.
// ---------------------------------------------------------------------------

export interface CredentialAccessor {
  get(name: string): Promise<string>;
  list(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Key version resolution — supports multiple encryption keys loaded from env
// vars: OP_CREDENTIAL_KEY_V1, OP_CREDENTIAL_KEY_V2, etc. V1 falls back to
// OP_CREDENTIAL_ENCRYPTION_KEY for backward compatibility.
// ---------------------------------------------------------------------------

function resolveKeyVersion(): number {
  const raw = process.env["OP_CREDENTIAL_KEY_VERSION"];
  if (!raw) return 1;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return 1;
  return parsed;
}

function loadKeyForVersion(version: number, fallbackKey: Buffer): Buffer {
  const envName = `OP_CREDENTIAL_KEY_V${version}`;
  const raw = process.env[envName];
  if (raw) return Buffer.from(raw, "base64");
  if (version === 1) {
    const legacyRaw = process.env["OP_CREDENTIAL_ENCRYPTION_KEY"];
    if (legacyRaw) return Buffer.from(legacyRaw, "base64");
    return fallbackKey;
  }
  throw new Error(
    `Encryption key for version ${version} not found. Set ${envName} in the environment.`,
  );
}

// ---------------------------------------------------------------------------
// CredentialService — public interface
// ---------------------------------------------------------------------------

export interface RotationResult {
  rotated: number;
  skipped: number;
  failed: number;
}

export interface CredentialService {
  storeCredentials(
    connectorId: string,
    credentials: Record<string, string>,
    masterKey: Buffer,
  ): Promise<void>;
  getDecryptedCredential(
    connectorId: string,
    fieldName: string,
    masterKey: Buffer,
  ): Promise<string>;
  listFieldNames(connectorId: string): Promise<string[]>;
  deleteByConnectorId(connectorId: string): Promise<void>;
  createCredentialAccessor(
    connectorId: string,
    masterKey: Buffer,
  ): CredentialAccessor;
  rotateCredentials(
    masterKey: Buffer,
    newKeyVersion?: number,
  ): Promise<RotationResult>;
}

export interface CredentialServiceDeps {
  credentialRepo: CredentialRepository;
  logger: Logger;
}

const CURRENT_KEY_VERSION = resolveKeyVersion();

export function createCredentialService(
  deps: CredentialServiceDeps,
): CredentialService {
  const { credentialRepo, logger } = deps;

  // -------------------------------------------------------------------------
  // storeCredentials — encrypts each field and upserts to credential repo.
  // Called during connector creation and partial credential updates.
  // -------------------------------------------------------------------------

  async function storeCredentials(
    connectorId: string,
    credentials: Record<string, string>,
    masterKey: Buffer,
  ): Promise<void> {
    const entries = Object.entries(credentials);
    if (entries.length === 0) return;

    // Encrypt all fields in parallel — each encrypt() call generates its own
    // salt + IV so concurrent calls don't share any key material.
    await Promise.all(
      entries.map(async ([fieldName, plaintext]) => {
        const encryptedBlob = await encrypt(plaintext, masterKey);
        await credentialRepo.upsert({
          connector_id: connectorId,
          field_name: fieldName,
          encrypted_blob: encryptedBlob,
          key_version: CURRENT_KEY_VERSION,
        });
      }),
    );

    logger.info("Credentials stored", {
      connectorId,
      fieldCount: entries.length,
    });
  }

  // -------------------------------------------------------------------------
  // getDecryptedCredential — fetches the encrypted blob and decrypts it.
  // Throws CredentialNotFoundError when the field does not exist so callers
  // get a clear message rather than a null-dereference downstream.
  // -------------------------------------------------------------------------

  function resolveDecryptionKey(
    keyVersion: number,
    fallbackKey: Buffer,
  ): Buffer {
    return loadKeyForVersion(keyVersion, fallbackKey);
  }

  async function getDecryptedCredential(
    connectorId: string,
    fieldName: string,
    masterKey: Buffer,
  ): Promise<string> {
    const row = await credentialRepo.findByConnectorIdAndField(
      connectorId,
      fieldName,
    );

    if (row === null) {
      throw new CredentialNotFoundError(
        `Credential field "${fieldName}" is not configured for connector ${connectorId}.`,
        { connectorId, fieldName },
      );
    }

    const decryptionKey = resolveDecryptionKey(row.key_version, masterKey);

    try {
      return await decrypt(row.encrypted_blob, decryptionKey);
    } catch (err) {
      throw new CredentialDecryptFailedError(
        `Failed to decrypt credential field "${fieldName}" for connector ${connectorId}.`,
        {
          connectorId,
          fieldName,
          keyVersion: row.key_version,
          cause: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // listFieldNames — returns field names without any values.
  // Used by the API response to show which credentials are configured.
  // -------------------------------------------------------------------------

  async function listFieldNames(connectorId: string): Promise<string[]> {
    const rows = await credentialRepo.findByConnectorId(connectorId);
    return rows.map((r) => r.field_name);
  }

  // -------------------------------------------------------------------------
  // deleteByConnectorId — removes all credentials for a connector.
  // Called synchronously during connector deletion (credentials must not
  // outlive the connector row for compliance reasons).
  // -------------------------------------------------------------------------

  async function deleteByConnectorId(connectorId: string): Promise<void> {
    const count = await credentialRepo.deleteByConnectorId(connectorId);
    logger.info("Credentials deleted", { connectorId, fieldCount: count });
  }

  // -------------------------------------------------------------------------
  // createCredentialAccessor — returns a scoped accessor object that lazily
  // decrypts credentials on demand and caches them in memory for the duration
  // of the sync job. The cache is not shared between jobs — each call to
  // createCredentialAccessor produces a fresh Map.
  // -------------------------------------------------------------------------

  function createCredentialAccessor(
    connectorId: string,
    masterKey: Buffer,
  ): CredentialAccessor {
    // Per-job in-memory cache. Cleared when the accessor object is GC'd after
    // the job completes. Decrypted values never persist beyond one sync job.
    const cache = new Map<string, string>();

    return {
      async get(name: string): Promise<string> {
        const cached = cache.get(name);
        if (cached !== undefined) return cached;

        const value = await getDecryptedCredential(connectorId, name, masterKey);
        cache.set(name, value);
        return value;
      },

      async list(): Promise<string[]> {
        return listFieldNames(connectorId);
      },
    };
  }

  // -------------------------------------------------------------------------
  // rotateCredentials — re-encrypts all credentials that are still on an
  // older key version. For each row: decrypt with the old version's key,
  // re-encrypt with the target version's key, and atomically update the row
  // (optimistic lock on old key_version prevents double-rotation).
  // -------------------------------------------------------------------------

  async function rotateCredentials(
    masterKey: Buffer,
    newKeyVersion: number = CURRENT_KEY_VERSION,
  ): Promise<RotationResult> {
    const rows = await credentialRepo.findOutstandingForRotation(newKeyVersion);
    if (rows.length === 0) {
      logger.info("Key rotation: no outstanding credentials to rotate", {
        targetKeyVersion: newKeyVersion,
      });
      return { rotated: 0, skipped: 0, failed: 0 };
    }

    const newKey = loadKeyForVersion(newKeyVersion, masterKey);
    let rotated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const oldKey = resolveDecryptionKey(row.key_version, masterKey);
        const plaintext = await decrypt(row.encrypted_blob, oldKey);
        const newBlob = await encrypt(plaintext, newKey);
        const updated = await credentialRepo.updateKeyVersion(
          row.id,
          newBlob,
          newKeyVersion,
          row.key_version,
        );
        if (updated) {
          rotated++;
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
        logger.error("Key rotation: failed to rotate credential", {
          credentialId: row.id,
          connectorId: row.connector_id,
          fieldName: row.field_name,
          oldKeyVersion: row.key_version,
          newKeyVersion,
          cause: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Key rotation complete", {
      targetKeyVersion: newKeyVersion,
      rotated,
      skipped,
      failed,
      total: rows.length,
    });

    return { rotated, skipped, failed };
  }

  return {
    storeCredentials,
    getDecryptedCredential,
    listFieldNames,
    deleteByConnectorId,
    createCredentialAccessor,
    rotateCredentials,
  };
}
