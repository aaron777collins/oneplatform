import type pg from "pg";
import type { CredentialRow, CreateCredentialData } from "./types.js";

const CREDENTIAL_COLUMNS = `
  id, connector_id, field_name, encrypted_blob, key_version, created_at, updated_at
`;

export class CredentialRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Upsert a single credential field. ON CONFLICT updates the encrypted_blob
  // and key_version so a credential rotation call naturally replaces the value
  // without needing a separate read-then-write pattern.
  async upsert(data: CreateCredentialData): Promise<CredentialRow> {
    const result = await this.pool.query<CredentialRow>(
      `INSERT INTO ingestion.credentials
         (connector_id, field_name, encrypted_blob, key_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (connector_id, field_name) DO UPDATE
           SET encrypted_blob = EXCLUDED.encrypted_blob,
               key_version    = EXCLUDED.key_version,
               updated_at     = now()
       RETURNING ${CREDENTIAL_COLUMNS}`,
      [data.connector_id, data.field_name, data.encrypted_blob, data.key_version]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `UPSERT INTO ingestion.credentials returned no rows for connector ${data.connector_id}, field ${data.field_name}`
      );
    }
    return row;
  }

  // Returns all credential rows for a connector — field names and blobs
  // but never decrypted values. The caller (vault service) handles decryption.
  async findByConnectorId(connectorId: string): Promise<CredentialRow[]> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS}
         FROM ingestion.credentials
        WHERE connector_id = $1
        ORDER BY field_name ASC`,
      [connectorId]
    );
    return result.rows;
  }

  async findByConnectorIdAndField(
    connectorId: string,
    fieldName: string
  ): Promise<CredentialRow | null> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS}
         FROM ingestion.credentials
        WHERE connector_id = $1
          AND field_name   = $2`,
      [connectorId, fieldName]
    );
    return result.rows[0] ?? null;
  }

  // Alias matching the service interface name — delegates to findByConnectorIdAndField
  // so the service layer can call the name it expects.
  async findByConnectorAndField(
    connectorId: string,
    fieldName: string
  ): Promise<CredentialRow | null> {
    return this.findByConnectorIdAndField(connectorId, fieldName);
  }

  // Returns just the field names (not blobs) for a connector.
  // Used by the API to list which credentials are configured without
  // exposing any encrypted values.
  async listFieldNamesByConnectorId(connectorId: string): Promise<string[]> {
    const result = await this.pool.query<{ field_name: string }>(
      `SELECT field_name
         FROM ingestion.credentials
        WHERE connector_id = $1
        ORDER BY field_name ASC`,
      [connectorId]
    );
    return result.rows.map((r) => r.field_name);
  }

  // Hard-delete all credentials for a connector. Called synchronously on
  // connector deletion so no plaintext is recoverable after the connector
  // row is soft-deleted (design spec §4.2 DELETE /api/v1/connectors/{id}).
  async deleteByConnectorId(connectorId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ingestion.credentials
        WHERE connector_id = $1`,
      [connectorId]
    );
    return result.rowCount ?? 0;
  }

  // Updates the key_version of a single credential row after it has been
  // re-encrypted with the new master key during key rotation. The optimistic
  // lock on `old_key_version` prevents double-re-encryption if the rotation
  // job restarts mid-run (design spec §5.6 step 4b.iii).
  async updateKeyVersion(
    id: string,
    newEncryptedBlob: string,
    newKeyVersion: number,
    oldKeyVersion: number
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ingestion.credentials
            SET encrypted_blob = $1,
                key_version    = $2,
                updated_at     = now()
          WHERE id          = $3
            AND key_version = $4`,
      [newEncryptedBlob, newKeyVersion, id, oldKeyVersion]
    );
    // 0 rows updated means either: row not found, or already rotated
    // (concurrent rotation won the race). Both are safe — skip silently.
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Finds all credentials whose key_version is below `targetKeyVersion`.
  // Used by the key rotation job to enumerate outstanding rows using the
  // partial index on key_version (design spec §2.2 and §5.6).
  async findOutstandingForRotation(targetKeyVersion: number): Promise<CredentialRow[]> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS}
         FROM ingestion.credentials
        WHERE key_version < $1
        ORDER BY id ASC`,
      [targetKeyVersion]
    );
    return result.rows;
  }
}
