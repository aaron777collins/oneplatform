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

// Enriched row returned by admin list query — joins api_keys with auth.users
// to surface the owning user's display name alongside key metadata.
interface AdminApiKeyRow extends ApiKeyRow {
  display_name: string | null;
  email: string;
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

// Record returned by listAllKeys — augments the base record with owning user info.
// Never exposes key_hash; only the short prefix is included for identification.
export interface AdminApiKeyRecord extends ApiKeyRecord {
  displayName: string | null;
  email: string;
}

export interface ApiKeyService {
  create(
    userId: string,
    tenantId: string,
    data: CreateApiKeyInput,
    callerScopes: string[]
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }>;
  validate(key: string): Promise<UserContext | null>;
  list(
    userId: string,
    options?: { status?: "active" | "revoked" | "all"; limit?: number; offset?: number },
  ): Promise<{ keys: ApiKeyRecord[]; total: number }>;
  // Admin-only: list all keys across all users (no ownership filter).
  listAllKeys(options?: {
    status?: "active" | "revoked" | "all";
    limit?: number;
    offset?: number;
  }): Promise<{ keys: AdminApiKeyRecord[]; total: number }>;
  revoke(keyId: string, revokedBy: string, tenantId: string): Promise<void>;
  // Admin-only: revoke any key regardless of ownership; tenantId is not required
  // because the admin has already been authenticated at the service entry point.
  revokeAsAdmin(keyId: string, revokedBy: string): Promise<void>;
  rotate(
    keyId: string,
    userId: string,
    tenantId: string
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }>;
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const { db, redis, logger, events } = deps;

  // Minimum of 10 matches password-service.ts and bcrypt recommendations.
  const MIN_BCRYPT_ROUNDS = 10;
  const DEFAULT_BCRYPT_ROUNDS = 12;

  function getBcryptRounds(): number {
    const raw = process.env["OP_BCRYPT_ROUNDS"];
    if (raw === undefined) return DEFAULT_BCRYPT_ROUNDS;
    const parsed = parseInt(raw, 10);
    // Guard against NaN (non-numeric env var) or values below the security
    // threshold. bcrypt.hash(key, NaN) produces unpredictable results depending
    // on the library version — always fall back to the safe default instead.
    if (isNaN(parsed) || parsed < MIN_BCRYPT_ROUNDS) {
      return DEFAULT_BCRYPT_ROUNDS;
    }
    return parsed;
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
    data: CreateApiKeyInput,
    callerScopes: string[]
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }> {
    // Scope subsetting check: a user cannot grant an API key more privileges
    // than they themselves possess. This prevents privilege escalation via
    // key creation (e.g. a viewer creating an admin-scoped key).
    const callerScopeSet = new Set(callerScopes);
    for (const requestedScope of data.scopes) {
      if (!callerScopeSet.has(requestedScope)) {
        throw new ForbiddenError(
          `Cannot create API key with scope '${requestedScope}' — not in your permissions.`
        );
      }
    }

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

    // Step 2: Fast DB lookup by prefix.
    // LIMIT 5 caps sequential bcrypt comparisons to prevent a DoS attack
    // where an adversary creates many keys sharing the same 8-char prefix
    // and forces unbounded bcrypt work per validation call (V5-027).
    const result = await db.query<ApiKeyRow>(
      `SELECT * FROM auth.api_keys
       WHERE key_prefix = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 5`,
      [keyPrefix]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // If the query returned the full LIMIT, there may be more rows beyond
    // the cap. Log a warning so operators can investigate prefix saturation.
    if (result.rows.length >= 5) {
      logger.warn("API key prefix collision at safety limit — some keys may be unreachable", {
        keyPrefix,
        matchCount: result.rows.length,
      });
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

    // Step 5: Fetch the user's roles from auth.users so RBAC role-based checks work
    const userResult = await db.query<{ roles: string[]; email_verified: boolean }>(
      "SELECT roles, email_verified FROM auth.users WHERE id = $1",
      [matchedRow.user_id]
    );
    const userRoles = userResult.rows[0]?.roles ?? [];
    const emailVerified = userResult.rows[0]?.email_verified ?? true;

    // Step 6: Non-blocking last_used_at update — fire and forget
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

    // Step 7: Build UserContext for downstream middleware
    return {
      userId: matchedRow.user_id,
      tenantId: matchedRow.tenant_id,
      roles: userRoles,
      scopes: matchedRow.scopes,
      isGuest: false,
      isService: false,
      emailVerified,
    };
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  async function list(
    userId: string,
    options?: { status?: "active" | "revoked" | "all"; limit?: number; offset?: number },
  ): Promise<{ keys: ApiKeyRecord[]; total: number }> {
    const status = options?.status ?? "active";
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const offset = Math.max(options?.offset ?? 0, 0);

    let statusClause = "";
    if (status === "active") {
      statusClause = " AND revoked_at IS NULL";
    } else if (status === "revoked") {
      statusClause = " AND revoked_at IS NOT NULL";
    }
    // status === "all" → no extra clause

    const countResult = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM auth.api_keys
       WHERE user_id = $1${statusClause}`,
      [userId],
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    const result = await db.query<ApiKeyRow>(
      `SELECT * FROM auth.api_keys
       WHERE user_id = $1${statusClause}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    return { keys: result.rows.map(rowToRecord), total };
  }

  // -------------------------------------------------------------------------
  // listAllKeys (admin-only)
  // -------------------------------------------------------------------------

  async function listAllKeys(options?: {
    status?: "active" | "revoked" | "all";
    limit?: number;
    offset?: number;
  }): Promise<{ keys: AdminApiKeyRecord[]; total: number }> {
    const status = options?.status ?? "active";
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const offset = Math.max(options?.offset ?? 0, 0);

    let statusClause = "";
    if (status === "active") {
      statusClause = " AND k.revoked_at IS NULL";
    } else if (status === "revoked") {
      statusClause = " AND k.revoked_at IS NOT NULL";
    }

    const countResult = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM auth.api_keys k WHERE 1=1${statusClause}`
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    // Join with auth.users to surface owning user info.
    // key_hash is intentionally excluded — the column is never returned by this
    // service method. key_prefix provides enough context for identification.
    const result = await db.query<AdminApiKeyRow>(
      `SELECT k.id, k.user_id, k.tenant_id, k.name, k.key_hash, k.key_prefix,
              k.scopes, k.expires_at, k.last_used_at, k.created_at, k.revoked_at,
              u.display_name, u.email
       FROM auth.api_keys k
       JOIN auth.users u ON u.id = k.user_id
       WHERE 1=1${statusClause}
       ORDER BY k.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      keys: result.rows.map((row) => ({
        ...rowToRecord(row),
        displayName: row.display_name,
        email: row.email,
      })),
      total,
    };
  }

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  async function revoke(keyId: string, revokedBy: string, tenantId: string): Promise<void> {
    const result = await db.query<{ id: string; tenant_id: string; user_id: string }>(
      `UPDATE auth.api_keys
       SET revoked_at = now(), revoked_by = $1
       WHERE id = $2 AND tenant_id = $3 AND revoked_at IS NULL
       RETURNING id, tenant_id, user_id`,
      [revokedBy, keyId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError(`API key ${keyId} not found or already revoked.`);
    }

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError(`API key ${keyId} not found.`);
    }

    // Set Redis revocation flag with 30-day TTL to prevent unbounded memory growth.
    // After 30 days the DB check (revoked_at IS NULL) is authoritative.
    const REVOCATION_TTL_SECONDS = 30 * 24 * 60 * 60;
    await redis.set(`auth:apikey:revocation:${keyId}`, "1", "EX", REVOCATION_TTL_SECONDS);

    await events.publish({
      eventType: "auth.key.revoked",
      eventVersion: "1.0",
      tenantId: row.tenant_id,
      actor: { type: "user", id: revokedBy },
      data: { keyId, userId: row.user_id, revokedBy },
    });
  }

  // -------------------------------------------------------------------------
  // revokeAsAdmin — revoke any key without a tenantId ownership check.
  // The caller (route layer) is responsible for verifying admin scope before
  // calling this method. The tenantId is not enforced here because a platform
  // admin can revoke keys belonging to any tenant for compliance purposes.
  // -------------------------------------------------------------------------

  async function revokeAsAdmin(keyId: string, revokedBy: string): Promise<void> {
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

    const REVOCATION_TTL_SECONDS = 30 * 24 * 60 * 60;
    await redis.set(`auth:apikey:revocation:${keyId}`, "1", "EX", REVOCATION_TTL_SECONDS);

    await events.publish({
      eventType: "auth.key.revoked",
      eventVersion: "1.0",
      tenantId: row.tenant_id,
      actor: { type: "user", id: revokedBy },
      data: { keyId, userId: row.user_id, revokedBy, adminRevocation: true },
    });
  }

  // -------------------------------------------------------------------------
  // Rotate (revoke old → create new with same name/scopes in one transaction)
  // -------------------------------------------------------------------------

  async function rotate(
    keyId: string,
    userId: string,
    tenantId: string
  ): Promise<{ apiKey: string; keyRecord: ApiKeyRecord }> {
    // Fetch the existing key to verify ownership and tenant membership
    const existingResult = await db.query<ApiKeyRow>(
      `SELECT * FROM auth.api_keys
       WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [keyId, tenantId]
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

      const REVOCATION_TTL_SECONDS = 30 * 24 * 60 * 60;
      await redis.set(`auth:apikey:revocation:${keyId}`, "1", "EX", REVOCATION_TTL_SECONDS);

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

  return { create, validate, list, listAllKeys, revoke, revokeAsAdmin, rotate };
}
