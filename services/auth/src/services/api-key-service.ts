// API key lifecycle management.
// Key format: "op_live_" + 43 random base64url chars (32 bytes encoded).
// The first 8 chars of the random portion are the key_prefix used for fast
// DB lookup before bcrypt comparison (L2 design §6.5).
//
// Key validation is the hot path — it's called on every API request.
// The validate() method is designed to be passed as the validateApiKey
// callback to the core auth middleware.

import { randomBytes } from "crypto";
import type { Redis } from "ioredis";
import type pg from "pg";
import bcrypt from "bcrypt";
import type { UserContext, Logger, EventPublisher } from "@oneplatform/core";
import { NotFoundError, ForbiddenError } from "@oneplatform/core";
import type { CreateApiKeyInput, ApiKeyRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Key generation constants
// ---------------------------------------------------------------------------

const KEY_PREFIX_TEXT = "op_live_";
// 32 random bytes → 43-char base64url string (no padding)
const KEY_RANDOM_BYTES = 32;
const PREFIX_CHARS = 8; // Length of the lookup prefix stored in DB

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  user_id: string;
  tenant_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ApiKeyServiceDeps {
  db: pg.Pool;
  redis: Redis;
  logger: Logger;
  events: EventPublisher;
}

export interface ApiKeyService {
  create(
    userId: string,
    tenantId: string,
    data: CreateApiKeyInput
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }>;
  validate(key: string): Promise<UserContext | null>;
  list(userId: string): Promise<ApiKeyRecord[]>;
  revoke(keyId: string, revokedBy: string): Promise<void>;
  rotate(
    keyId: string,
    userId: string
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }>;
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const { db, redis, logger, events } = deps;

  function getBcryptRounds(): number {
    const raw = process.env["OP_BCRYPT_ROUNDS"];
    return raw !== undefined ? parseInt(raw, 10) : 12;
  }

  // -------------------------------------------------------------------------
  // Key generation helper
  // -------------------------------------------------------------------------

  function generateRawKey(): {
    fullKey: string;
    keyPrefix: string;
    randomPart: string;
  } {
    const randomPart = randomBytes(KEY_RANDOM_BYTES).toString("base64url");
    const keyPrefix = randomPart.substring(0, PREFIX_CHARS);
    const fullKey = `${KEY_PREFIX_TEXT}${randomPart}`;
    return { fullKey, keyPrefix, randomPart };
  }

  function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
    return {
      id: row.id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async function create(
    userId: string,
    tenantId: string,
    data: CreateApiKeyInput
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }> {
    const { fullKey, keyPrefix } = generateRawKey();
    const keyHash = await bcrypt.hash(fullKey, getBcryptRounds());

    const result = await db.query<ApiKeyRow>(
      `INSERT INTO auth.api_keys
         (user_id, tenant_id, name, key_hash, key_prefix, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userId,
        tenantId,
        data.name,
        keyHash,
        keyPrefix,
        data.scopes,
        data.expiresAt ?? null,
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("API key INSERT returned no row — unexpected database error.");
    }

    await events.publish({
      eventType: "auth.key.created",
      eventVersion: "1.0",
      tenantId,
      actor: { type: "user", id: userId },
      data: { keyId: row.id, userId, name: data.name },
    });

    return {
      apiKey: fullKey,
      keyRecord: rowToRecord(row),
    };
  }

  // -------------------------------------------------------------------------
  // Validate (hot path — called on every API request with an API key)
  // -------------------------------------------------------------------------

  async function validate(key: string): Promise<UserContext | null> {
    // Step 1: Format validation
    if (!key.startsWith(KEY_PREFIX_TEXT)) {
      return null;
    }

    // Extract the random portion: everything after "op_live_"
    const randomPart = key.substring(KEY_PREFIX_TEXT.length);
    const keyPrefix = randomPart.substring(0, PREFIX_CHARS);

    if (keyPrefix.length < PREFIX_CHARS) {
      return null;
    }

    // Step 2: Fast DB lookup by prefix
    const result = await db.query<ApiKeyRow>(
      `SELECT * FROM auth.api_keys
       WHERE key_prefix = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [keyPrefix]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Step 3: bcrypt comparison against all candidate rows (handles prefix collisions)
    let matchedRow: ApiKeyRow | null = null;
    for (const row of result.rows) {
      const matches = await bcrypt.compare(key, row.key_hash);
      if (matches) {
        matchedRow = row;
        break;
      }
    }

    if (matchedRow === null) {
      return null;
    }

    // Step 4: Check Redis revocation blocklist (catches keys revoked via admin)
    const revoked = await redis.get(
      `auth:apikey:revocation:${matchedRow.id}`
    );
    if (revoked !== null) {
      return null;
    }

    // Step 5: Non-blocking last_used_at update — fire and forget
    // Using setImmediate defers this to the next iteration of the event loop
    // so it doesn't add to the request's critical path latency.
    setImmediate(() => {
      db.query(
        "UPDATE auth.api_keys SET last_used_at = now() WHERE id = $1",
        [matchedRow!.id]
      ).catch((err: unknown) => {
        logger.warn("Failed to update api_keys.last_used_at", {
          keyId: matchedRow!.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // Step 6: Build UserContext for downstream middleware
    return {
      userId: matchedRow.user_id,
      tenantId: matchedRow.tenant_id,
      roles: [],
      scopes: matchedRow.scopes,
      isGuest: false,
      isService: false,
      emailVerified: true,
    };
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  async function list(userId: string): Promise<ApiKeyRecord[]> {
    const result = await db.query<ApiKeyRow>(
      `SELECT * FROM auth.api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(rowToRecord);
  }

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  async function revoke(keyId: string, revokedBy: string): Promise<void> {
    const result = await db.query<{ id: string; tenant_id: string; user_id: string }>(
      `UPDATE auth.api_keys
       SET revoked_at = now(), revoked_by = $1
       WHERE id = $2 AND revoked_at IS NULL
       RETURNING id, tenant_id, user_id`,
      [revokedBy, keyId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError(`API key ${keyId} not found or already revoked.`);
    }

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError(`API key ${keyId} not found.`);
    }

    // Set Redis revocation flag (no TTL — persists until key row is hard-deleted)
    await redis.set(`auth:apikey:revocation:${keyId}`, "1");

    await events.publish({
      eventType: "auth.key.revoked",
      eventVersion: "1.0",
      tenantId: row.tenant_id,
      actor: { type: "user", id: revokedBy },
      data: { keyId, userId: row.user_id, revokedBy },
    });
  }

  // -------------------------------------------------------------------------
  // Rotate (revoke old → create new with same name/scopes in one transaction)
  // -------------------------------------------------------------------------

  async function rotate(
    keyId: string,
    userId: string
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }> {
    // Fetch the existing key to verify ownership and get its metadata
    const existingResult = await db.query<ApiKeyRow>(
      `SELECT * FROM auth.api_keys
       WHERE id = $1 AND revoked_at IS NULL`,
      [keyId]
    );
    const existing = existingResult.rows[0];

    if (!existing) {
      throw new NotFoundError(`API key ${keyId} not found or already revoked.`);
    }
    if (existing.user_id !== userId) {
      throw new ForbiddenError("You do not own this API key.");
    }

    const { fullKey, keyPrefix } = generateRawKey();
    const keyHash = await bcrypt.hash(fullKey, getBcryptRounds());

    // Atomic rotation: revoke old key and insert new key in a single transaction.
    // There is no window where neither key is valid.
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        "UPDATE auth.api_keys SET revoked_at = now(), revoked_by = $1 WHERE id = $2",
        [userId, keyId]
      );

      const newResult = await client.query<ApiKeyRow>(
        `INSERT INTO auth.api_keys
           (user_id, tenant_id, name, key_hash, key_prefix, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          existing.user_id,
          existing.tenant_id,
          existing.name,
          keyHash,
          keyPrefix,
          existing.scopes,
          existing.expires_at,
        ]
      );

      await client.query("COMMIT");

      const newRow = newResult.rows[0];
      if (!newRow) {
        throw new Error("Key rotation INSERT returned no row.");
      }

      // Revoke old key in Redis after transaction commits
      await redis.set(`auth:apikey:revocation:${keyId}`, "1");

      await events.publish({
        eventType: "auth.key.created",
        eventVersion: "1.0",
        tenantId: existing.tenant_id,
        actor: { type: "user", id: userId },
        data: {
          keyId: newRow.id,
          userId,
          name: existing.name,
          rotatedFrom: keyId,
        },
      });

      return {
        apiKey: fullKey,
        keyRecord: rowToRecord(newRow),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------

  return { create, validate, list, revoke, rotate };
}
