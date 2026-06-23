// Bootstrap flow — first-run platform setup.
// Implements the exact state machine from L2 design §7 including:
//   - Constant-time token comparison that ALWAYS runs regardless of prior state
//   - In-memory rate limiting (NOT Redis — must work without Redis, per §7.1)
//   - Advisory lock for concurrent-call safety
//   - Single atomic transaction for tenant + user + state flag
//
// Security invariant (L2 design §9.5): the constant-time comparison runs even
// when bootstrap is already completed, preventing a timing oracle that would
// reveal the bootstrap completion state to an attacker.

import { timingSafeEqual, randomUUID } from "crypto";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { PasswordService } from "./password-service.js";
import type { TokenService } from "./token-service.js";
import type { BootstrapInput, BootstrapResult } from "./types.js";
import {
  BootstrapAlreadyCompletedError,
  BootstrapInvalidTokenError,
  BootstrapTokenMissingError,
} from "./errors.js";
import { RateLimitError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// In-memory rate limiter (3 attempts / 10 min per IP)
// NOT Redis-backed — must survive Redis outages (L2 design §4.1)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000; // 10 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 3;

// Module-level store — shared across all handler invocations in the process
const bootstrapAttemptsByIp = new Map<string, RateLimitEntry>();

function checkBootstrapRateLimit(ipAddress: string): void {
  const now = Date.now();
  const entry = bootstrapAttemptsByIp.get(ipAddress);

  if (entry === undefined || now - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    // New window — reset count
    bootstrapAttemptsByIp.set(ipAddress, { count: 1, windowStartMs: now });
    return;
  }

  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (now - entry.windowStartMs)) / 1_000
    );
    throw new RateLimitError(retryAfterSeconds);
  }

  entry.count += 1;
}

/**
 * V6-122: Periodic cleanup of expired rate limiter entries.
 * Without cleanup, the Map grows unboundedly over time as unique IPs accumulate.
 * This sweep runs every RATE_LIMIT_WINDOW_MS and removes entries whose window
 * has fully elapsed, keeping memory usage proportional to active attackers only.
 */
const CLEANUP_INTERVAL_MS = RATE_LIMIT_WINDOW_MS;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startRateLimiterCleanup(): void {
  if (cleanupTimer !== null) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of bootstrapAttemptsByIp) {
      if (now - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
        bootstrapAttemptsByIp.delete(ip);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Unref so the timer does not prevent graceful process shutdown.
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

// Start cleanup on module load — runs for the lifetime of the process.
startRateLimiterCleanup();

// Exposed for testing — resets the in-memory counters and restarts cleanup
export function resetBootstrapRateLimiter(): void {
  bootstrapAttemptsByIp.clear();
}

// ---------------------------------------------------------------------------
// 64-char dummy hex constant for timing-safe comparison when token is null
// (L2 design §7.1 guard implementation)
// ---------------------------------------------------------------------------
const DUMMY_64_CHAR_HEX = "0".repeat(64);

// ---------------------------------------------------------------------------
// Slug generation for tenant name
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface BootstrapServiceDeps {
  db: pg.Pool;
  passwordService: PasswordService;
  tokenService: TokenService;
  logger: Logger;
  events: EventPublisher;
  /** The bootstrap token loaded from /data/init/bootstrap.token at startup. */
  getInMemoryToken: () => string | null;
  /** Called after successful bootstrap to zero the in-memory token. */
  clearInMemoryToken: () => void;
}

export interface BootstrapService {
  getStatus(): Promise<{ completed: boolean }>;
  bootstrap(data: BootstrapInput): Promise<BootstrapResult>;
}

export function createBootstrapService(
  deps: BootstrapServiceDeps
): BootstrapService {
  const {
    db,
    passwordService,
    tokenService,
    logger,
    events,
    getInMemoryToken,
    clearInMemoryToken,
  } = deps;

  async function getStatus(): Promise<{ completed: boolean }> {
    const result = await db.query<{ bootstrap_completed: boolean }>(
      "SELECT bootstrap_completed FROM auth.bootstrap_state WHERE id = 1"
    );
    const completed = result.rows[0]?.bootstrap_completed ?? false;

    // V6-020: Bootstrap token is no longer included in the API response to
    // avoid leaking secrets over the network. It is logged to console on
    // startup so operators can retrieve it from server logs.
    if (!completed) {
      const token = getInMemoryToken();
      if (token !== null) {
        logger.info("Bootstrap not yet completed. Bootstrap token is available (check server startup logs).");
      }
    }

    return { completed };
  }

  async function bootstrap(data: BootstrapInput): Promise<BootstrapResult> {
    // Step 1: Apply in-memory rate limit before touching the DB or doing any
    // crypto. Throwing here does NOT bypass the token comparison below — the
    // rate limit is a guard on excessive attempts, not a short-circuit for the
    // timing-safe comparison requirement.
    checkBootstrapRateLimit(data.ipAddress);

    // Step 2: Read completion flag from DB.
    // We read it HERE before comparison so we can throw 410 after the comparison,
    // not before — the constant-time compare MUST always execute.
    const result = await db.query<{ bootstrap_completed: boolean }>(
      "SELECT bootstrap_completed FROM auth.bootstrap_state WHERE id = 1"
    );
    const alreadyCompleted = result.rows[0]?.bootstrap_completed ?? false;

    const inMemoryToken = getInMemoryToken();

    // Step 3: ALWAYS run the constant-time comparison regardless of state.
    // This prevents a timing oracle that could reveal whether bootstrap is
    // complete (L2 design §9.5, §7.1).
    //
    // If bootstrap token was never loaded (service startup failure), use a
    // dummy so comparison still takes the same time as a real compare.
    // Non-hex characters are silently dropped by Buffer.from(..., "hex"),
    // producing a shorter buffer that causes timingSafeEqual to throw
    // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH instead of returning false.
    // Normalise to exactly 32 bytes so the comparison always runs safely;
    // a malformed token will simply not match.
    const rawProvided = Buffer.from(
      data.bootstrapToken.padEnd(64, "0"),
      "hex"
    );
    const providedBytes =
      rawProvided.length === 32 ? rawProvided : Buffer.alloc(32);
    const expectedBytes = Buffer.from(
      (inMemoryToken ?? DUMMY_64_CHAR_HEX).padEnd(64, "0"),
      "hex"
    );
    const tokenMatch = timingSafeEqual(providedBytes, expectedBytes);

    // Step 4: Apply guards AFTER the comparison so timing is consistent
    if (inMemoryToken === null) {
      throw new BootstrapTokenMissingError(
        "Bootstrap token was not loaded at startup. Re-run op-init to regenerate."
      );
    }
    if (alreadyCompleted) {
      throw new BootstrapAlreadyCompletedError(
        "Bootstrap has already been completed. This endpoint is permanently disabled."
      );
    }
    if (!tokenMatch) {
      throw new BootstrapInvalidTokenError(
        "Bootstrap token does not match."
      );
    }

    // Step 5: Acquire advisory lock to prevent concurrent bootstrap attempts.
    // pg_advisory_lock is session-scoped so we need a dedicated client.
    const client = await db.connect();
    try {
      await client.query("SELECT pg_advisory_lock(1)");

      // Step 6: Double-check inside lock (double-check pattern)
      const innerResult = await client.query<{ bootstrap_completed: boolean }>(
        "SELECT bootstrap_completed FROM auth.bootstrap_state WHERE id = 1"
      );
      if (innerResult.rows[0]?.bootstrap_completed) {
        throw new BootstrapAlreadyCompletedError(
          "Bootstrap has already been completed (concurrent attempt)."
        );
      }

      // Step 7: Single transaction — tenant + user + state flag
      await client.query("BEGIN");
      let tenantId: string;
      let adminUserId: string;

      try {
        const tenantSlug = slugify(data.tenantName);
        const tenantResult = await client.query<{ id: string }>(
          `INSERT INTO auth.tenants (name, slug)
           VALUES ($1, $2)
           RETURNING id`,
          [data.tenantName, tenantSlug]
        );
        const insertedTenantId = tenantResult.rows[0]?.id;
        if (!insertedTenantId) {
          throw new Error("Tenant INSERT returned no id.");
        }
        tenantId = insertedTenantId;

        const passwordHash = await passwordService.hash(data.adminPassword);

        const userResult = await client.query<{ id: string }>(
          `INSERT INTO auth.users
             (tenant_id, email, password_hash, email_verified, roles)
           VALUES ($1, $2, $3, true, ARRAY['platform-admin'])
           RETURNING id`,
          [tenantId, data.adminEmail.toLowerCase(), passwordHash]
        );
        const insertedUserId = userResult.rows[0]?.id;
        if (!insertedUserId) {
          throw new Error("User INSERT returned no id.");
        }
        adminUserId = insertedUserId;

        // Seed predefined roles for this tenant (NULL tenant_id = platform-wide)
        // Roles are seeded in the migration with tenant_id = NULL.
        // No additional seeding needed here.

        await client.query(
          `UPDATE auth.bootstrap_state
           SET bootstrap_completed = true,
               completed_at = now(),
               admin_user_id = $1,
               first_tenant_id = $2
           WHERE id = 1`,
          [adminUserId, tenantId]
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }

      // Step 8: Issue session (outside the transaction — session can be recreated)
      const familyId = randomUUID();
      const sessionId = randomUUID();
      const expiresAt = new Date(
        Date.now() + getRefreshTokenTtlSeconds() * 1_000
      );

      await client.query(
        `INSERT INTO auth.sessions
           (id, user_id, tenant_id, refresh_token_jti, family_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sessionId, adminUserId, tenantId, randomUUID(), familyId, expiresAt]
      );

      const accessToken = await tokenService.issueAccessToken({
        id: adminUserId,
        tenantId,
        roles: ["platform-admin"],
        emailVerified: true,
        email: data.adminEmail,
      });

      const { token: refreshToken, jti: refreshJti } =
        await tokenService.issueRefreshToken(
          adminUserId,
          tenantId,
          sessionId,
          familyId
        );

      await client.query(
        "UPDATE auth.sessions SET refresh_token_jti = $1 WHERE id = $2",
        [refreshJti, sessionId]
      );

      // Step 9: Zero the in-memory token and best-effort erase the file
      clearInMemoryToken();

      // File erasure is handled by the startup/route layer that owns the path;
      // the service layer signals completion via clearInMemoryToken().

      logger.info("Bootstrap completed successfully", {
        tenantId,
        adminUserId,
      });

      await events.publish({
        eventType: "auth.bootstrap.completed",
        eventVersion: "1.0",
        tenantId,
        actor: { type: "system", id: adminUserId },
        data: { tenantId, adminUserId },
      });

      return {
        tenantId,
        adminUserId,
        accessToken,
        refreshToken,
        expiresIn: getJwtExpirySeconds(),
      };
    } finally {
      await client.query("SELECT pg_advisory_unlock(1)");
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  function getJwtExpirySeconds(): number {
    const raw = process.env["OP_JWT_EXPIRY_SECONDS"];
    if (raw === undefined) return 900;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `OP_JWT_EXPIRY_SECONDS must be a positive integer, got: "${raw}"`
      );
    }
    return parsed;
  }

  function getRefreshTokenTtlSeconds(): number {
    const raw = process.env["OP_REFRESH_TOKEN_TTL_SECONDS"];
    if (raw === undefined) return 604_800;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `OP_REFRESH_TOKEN_TTL_SECONDS must be a positive integer, got: "${raw}"`
      );
    }
    return parsed;
  }

  // -------------------------------------------------------------------------

  return { getStatus, bootstrap };
}
