// TODO: Implement master key rotation — re-encrypt all rows where key_version < CURRENT_KEY_VERSION (M-09)

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
// CredentialService — public interface
// ---------------------------------------------------------------------------

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
}

export interface CredentialServiceDeps {
  credentialRepo: CredentialRepository;
  logger: Logger;
}

// The key version written to new rows. Bump this constant (and implement a
// rotation job) whenever the master key changes — the partial index on
// key_version < max efficiently locates rows needing re-encryption.
const CURRENT_KEY_VERSION = 1;

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

    try {
      return await decrypt(row.encrypted_blob, masterKey);
    } catch (err) {
      // AES-GCM auth tag mismatch: the blob was either tampered with or was
      // encrypted with a different master key. Surface as a typed error so the
      // caller can emit the correct security audit event.
      throw new CredentialDecryptFailedError(
        `Failed to decrypt credential field "${fieldName}" for connector ${connectorId}.`,
        {
          connectorId,
          fieldName,
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

  return {
    storeCredentials,
    getDecryptedCredential,
    listFieldNames,
    deleteByConnectorId,
    createCredentialAccessor,
  };
}
