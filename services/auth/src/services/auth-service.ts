// Main authentication business logic.
// Orchestrates the registration, login, logout, password reset, and email
// verification flows exactly as specified in L2 design §6.
//
// This service has no HTTP concern — routes call into it and handle the
// HTTP response shape. The service throws typed errors from errors.ts
// which the error handler middleware converts to standard API responses.

import { randomUUID } from "crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { Logger } from "@oneplatform/core";
import {
  ConflictError,
  UnauthorizedError,
  type EventPublisher,
} from "@oneplatform/core";
import type { PasswordService } from "./password-service.js";
import type { TokenService } from "./token-service.js";
import type {
  RegisterInput,
  RegisterResult,
  LoginInput,
  LoginResult,
  ForgotPasswordResult,
  VerifyEmailResult,
} from "./types.js";
import {
  AccountLockedError,
  AccountDeactivatedError,
  TenantNotFoundError,
  ResetTokenInvalidError,
  ResetTokenExpiredError,
  ResetTokenUsedError,
  VerifyTokenInvalidError,
  VerifyTokenExpiredError,
  VerifyTokenUsedError,
  EmailAlreadyVerifiedError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// DB row types (internal — not exported)
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string | null;
  email_verified: boolean;
  is_active: boolean;
  display_name: string | null;
  roles: string[];
  failed_login_count: number;
  locked_until: Date | null;
}

interface TenantRow {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getJwtSecret(): Uint8Array {
  const secret = process.env["OP_JWT_SECRET"];
  if (!secret) {
    throw new Error("OP_JWT_SECRET is required but not set.");
  }
  return new TextEncoder().encode(secret);
}

function requireEmailVerification(): boolean {
  return process.env["OP_REQUIRE_EMAIL_VERIFICATION"] === "true";
}

function getBaseUrl(): string {
  return process.env["OP_BASE_URL"] ?? "http://localhost:3000";
}

function hasSmtp(): boolean {
  return !!process.env["OP_SMTP_HOST"];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface AuthServiceDeps {
  db: pg.Pool;
  redis: Redis;
  passwordService: PasswordService;
  tokenService: TokenService;
  logger: Logger;
  events: EventPublisher;
}

export interface AuthService {
  register(data: RegisterInput): Promise<RegisterResult>;
  login(data: LoginInput): Promise<LoginResult>;
  logout(refreshToken: string | undefined, accessTokenJti: string, accessTokenExp: number, userId: string, all?: boolean): Promise<void>;
  forgotPassword(email: string, tenantId: string): Promise<ForgotPasswordResult>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  verifyEmail(token: string): Promise<VerifyEmailResult>;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, redis, passwordService, tokenService, logger, events } = deps;

  // -------------------------------------------------------------------------
  // Registration (L2 design §4.2, §6.1)
  // -------------------------------------------------------------------------

  async function register(data: RegisterInput): Promise<RegisterResult> {
    // 1. Validate tenant exists
    const tenantResult = await db.query<TenantRow>(
      "SELECT id, name FROM auth.tenants WHERE id = $1",
      [data.tenantId]
    );
    if (tenantResult.rows.length === 0) {
      throw new TenantNotFoundError(
        `Tenant ${data.tenantId} does not exist.`
      );
    }

    // 2. Check email uniqueness within tenant (case-insensitive)
    const existingUser = await db.query(
      "SELECT id FROM auth.users WHERE tenant_id = $1 AND lower(email) = lower($2)",
      [data.tenantId, data.email]
    );
    if (existingUser.rows.length > 0) {
      throw new ConflictError(
        `Email address is already registered in this tenant.`
      );
    }

    const verifyRequired = requireEmailVerification();

    // 3. Hash password — ~200ms CPU-bound, performed before INSERT
    const passwordHash = await passwordService.hash(data.password);

    // 4. Insert user; email_verified is true when verification is NOT required
    const userResult = await db.query<{ id: string }>(
      `INSERT INTO auth.users
         (tenant_id, email, password_hash, email_verified, display_name, roles)
       VALUES ($1, $2, $3, $4, $5, ARRAY['viewer'])
       RETURNING id`,
      [
        data.tenantId,
        data.email.toLowerCase(),
        passwordHash,
        !verifyRequired,
        data.displayName ?? null,
      ]
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) {
      throw new Error("User INSERT returned no id — unexpected database error.");
    }

    await events.publish({
      eventType: "auth.user.created",
      eventVersion: "1.0",
      tenantId: data.tenantId,
      actor: { type: "system", id: userId },
      data: { userId, email: data.email, tenantId: data.tenantId },
    });

    if (verifyRequired) {
      // 5a. Issue email verification JWT + Redis single-use gate
      const jti = randomUUID();
      const verifyToken = await new SignJWT({
        sub: userId,
        purpose: "email-verify",
        jti,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("24h")
        .sign(getJwtSecret());

      await redis.set(`auth:verify:${jti}`, "1", "EX", 86_400);

      const verifyLink = `${getBaseUrl()}/verify-email?token=${verifyToken}`;

      if (hasSmtp()) {
        // SMTP send is out of scope for the service layer — the caller (route)
        // invokes the mailer with the generated link
        logger.info("Email verification link generated for SMTP delivery", {
          userId,
          tenantId: data.tenantId,
        });
      } else {
        logger.warn(
          "OP_SMTP_HOST not configured — email verification link returned in response (dev/test only)",
          { userId }
        );
      }

      return {
        userId,
        email: data.email,
        tenantId: data.tenantId,
        roles: ["viewer"],
        requiresEmailVerification: true,
        ...(hasSmtp() ? {} : { verifyLink }),
      };
    }

    // 5b. Issue access + refresh tokens immediately
    const familyId = randomUUID();
    const sessionId = randomUUID();
    const expiresAt = new Date(
      Date.now() + getRefreshTokenTtlSeconds() * 1_000
    );

    await db.query(
      `INSERT INTO auth.sessions
         (id, user_id, tenant_id, refresh_token_jti, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, userId, data.tenantId, randomUUID(), familyId, expiresAt]
    );

    const accessToken = await tokenService.issueAccessToken({
      id: userId,
      tenantId: data.tenantId,
      roles: ["viewer"],
      emailVerified: true,
    });

    const { token: refreshToken, jti: refreshJti } =
      await tokenService.issueRefreshToken(
        userId,
        data.tenantId,
        sessionId,
        familyId
      );

    // Update session with the actual refresh token JTI
    await db.query(
      "UPDATE auth.sessions SET refresh_token_jti = $1 WHERE id = $2",
      [refreshJti, sessionId]
    );

    const expirySeconds = getJwtExpirySeconds();

    return {
      userId,
      email: data.email,
      tenantId: data.tenantId,
      roles: ["viewer"],
      requiresEmailVerification: false,
      accessToken,
      refreshToken,
      expiresIn: expirySeconds,
    };
  }

  // -------------------------------------------------------------------------
  // Login (L2 design §4.2, §6.1)
  // -------------------------------------------------------------------------

  async function login(data: LoginInput): Promise<LoginResult> {
    // 1. Look up user by (tenant_id, email)
    const userResult = await db.query<UserRow>(
      `SELECT id, tenant_id, email, password_hash, email_verified,
              is_active, display_name, roles, failed_login_count, locked_until
       FROM auth.users
       WHERE tenant_id = $1 AND lower(email) = lower($2)`,
      [data.tenantId, data.email]
    );

    const user = userResult.rows[0];

    if (!user) {
      // Run dummy comparison to prevent timing oracle on user enumeration
      await passwordService.compareDummy(data.password);
      throw new UnauthorizedError("Invalid email or password.");
    }

    // 2. Check account lock — lockout supersedes any other check
    if (user.locked_until !== null && user.locked_until > new Date()) {
      throw new AccountLockedError(
        "Account is temporarily locked due to too many failed login attempts."
      );
    }

    // 3. Check account active state
    if (!user.is_active) {
      // Still run bcrypt to prevent timing oracle revealing deactivated accounts
      await passwordService.compareDummy(data.password);
      throw new AccountDeactivatedError("Account has been deactivated.");
    }

    // 4. If account has no password hash (OAuth-only), reject credential login
    if (user.password_hash === null) {
      await passwordService.compareDummy(data.password);
      throw new UnauthorizedError("Invalid email or password.");
    }

    // 5. Verify password
    const valid = await passwordService.compare(data.password, user.password_hash);

    if (!valid) {
      const newFailCount = user.failed_login_count + 1;
      const shouldLock = newFailCount >= 10;

      await db.query(
        `UPDATE auth.users
         SET failed_login_count = $1,
             locked_until = $2
         WHERE id = $3`,
        [
          newFailCount,
          shouldLock ? new Date(Date.now() + 15 * 60 * 1_000) : null,
          user.id,
        ]
      );

      await events.publish({
        eventType: "auth.user.login_failed",
        eventVersion: "1.0",
        tenantId: data.tenantId,
        actor: { type: "user", id: user.id },
        data: {
          userId: user.id,
          failCount: newFailCount,
          locked: shouldLock,
        },
      });

      if (shouldLock) {
        await events.publish({
          eventType: "auth.user.locked",
          eventVersion: "1.0",
          tenantId: data.tenantId,
          actor: { type: "user", id: user.id },
          data: { userId: user.id },
        });
      }

      throw new UnauthorizedError("Invalid email or password.");
    }

    // 6. Reset failed count and update last_login_at
    await db.query(
      `UPDATE auth.users
       SET failed_login_count = 0, last_login_at = now(), locked_until = NULL
       WHERE id = $1`,
      [user.id]
    );

    // 7. Create session record
    const familyId = randomUUID();
    const sessionId = randomUUID();
    const expiresAt = new Date(
      Date.now() + getRefreshTokenTtlSeconds() * 1_000
    );

    await db.query(
      `INSERT INTO auth.sessions
         (id, user_id, tenant_id, refresh_token_jti, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, user.id, data.tenantId, randomUUID(), familyId, expiresAt]
    );

    // 8. Issue tokens
    const accessToken = await tokenService.issueAccessToken({
      id: user.id,
      tenantId: user.tenant_id,
      roles: user.roles,
      emailVerified: user.email_verified,
    });

    const { token: refreshToken, jti: refreshJti } =
      await tokenService.issueRefreshToken(
        user.id,
        user.tenant_id,
        sessionId,
        familyId
      );

    await db.query(
      "UPDATE auth.sessions SET refresh_token_jti = $1 WHERE id = $2",
      [refreshJti, sessionId]
    );

    await events.publish({
      eventType: "auth.session.created",
      eventVersion: "1.0",
      tenantId: data.tenantId,
      actor: { type: "user", id: user.id },
      data: { userId: user.id, sessionId },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: getJwtExpirySeconds(),
      tokenType: "Bearer",
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        tenantId: user.tenant_id,
        roles: user.roles,
        emailVerified: user.email_verified,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Logout (L2 design §4.2)
  // -------------------------------------------------------------------------

  async function logout(
    refreshToken: string | undefined,
    accessTokenJti: string,
    accessTokenExp: number,
    userId: string,
    all = false
  ): Promise<void> {
    // 1. Revoke the current access token
    await tokenService.revokeAccessToken(accessTokenJti, accessTokenExp);

    if (all) {
      // Revoke ALL sessions for this user.
      // We cannot map session rows back to Redis refresh token keys because
      // the DB stores the JTI (UUID) while the Redis key is the raw hex token.
      // Instead, scan the Redis user-sessions set which tracks active token keys.
      const tokenKeys = await redis.smembers(`auth:user-sessions:${userId}`);
      for (const tokenKey of tokenKeys) {
        await redis.del(`auth:refresh:${tokenKey}`);
        await redis.del(`auth:token-family:${tokenKey}`);
      }
      await redis.del(`auth:user-sessions:${userId}`);

      await db.query(
        `UPDATE auth.sessions
         SET revoked_at = now(), revoked_reason = 'logout'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
    } else if (refreshToken !== undefined) {
      // 2. Revoke specific refresh token and its session
      const rawPayload = await redis.get(`auth:refresh:${refreshToken}`);
      if (rawPayload !== null) {
        const payload = JSON.parse(rawPayload) as { sessionId: string; userId: string };
        await redis.del(`auth:refresh:${refreshToken}`);
        await redis.del(`auth:token-family:${refreshToken}`);
        await redis.srem(`auth:user-sessions:${payload.userId}`, refreshToken);
        await db.query(
          `UPDATE auth.sessions
           SET revoked_at = now(), revoked_reason = 'logout'
           WHERE id = $1`,
          [payload.sessionId]
        );
      }
    }

    await events.publish({
      eventType: "auth.session.revoked",
      eventVersion: "1.0",
      tenantId: "",
      actor: { type: "user", id: userId },
      data: { userId, reason: "logout", all },
    });
  }

  // -------------------------------------------------------------------------
  // Forgot password (L2 design §6.7)
  // -------------------------------------------------------------------------

  async function forgotPassword(
    email: string,
    tenantId: string
  ): Promise<ForgotPasswordResult> {
    const message =
      "If an account with this email exists, a reset link has been sent." as const;

    const userResult = await db.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM auth.users
       WHERE tenant_id = $1 AND lower(email) = lower($2)`,
      [tenantId, email]
    );

    const user = userResult.rows[0];

    if (!user || !user.is_active) {
      // Sleep ~200ms to match the timing of the found-user path
      // and prevent email enumeration via response time.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { message };
    }

    // Generate reset JWT with 1-hour expiry
    const jti = randomUUID();
    const resetToken = await new SignJWT({
      sub: user.id,
      purpose: "password-reset",
      jti,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(getJwtSecret());

    // Store single-use gate in Redis
    await redis.set(`reset:${jti}`, "1", "EX", 3_600);

    // Durable audit record in Postgres
    await db.query(
      `INSERT INTO auth.password_reset_tokens (jti, user_id, expires_at)
       VALUES ($1, $2, now() + INTERVAL '1 hour')`,
      [jti, user.id]
    );

    const resetLink = `${getBaseUrl()}/reset-password?token=${resetToken}`;

    await events.publish({
      eventType: "auth.password.reset_requested",
      eventVersion: "1.0",
      tenantId,
      actor: { type: "user", id: user.id },
      data: { userId: user.id },
    });

    if (hasSmtp()) {
      // Mailer invocation is the caller's responsibility (route layer)
      logger.info("Password reset link generated for SMTP delivery", {
        userId: user.id,
        tenantId,
      });
      return { message };
    }

    logger.warn(
      "OP_SMTP_HOST not configured — reset link returned in response (dev/test only)",
      { userId: user.id }
    );
    return { message, resetLink };
  }

  // -------------------------------------------------------------------------
  // Reset password (L2 design §6.7)
  // -------------------------------------------------------------------------

  async function resetPassword(
    token: string,
    newPassword: string
  ): Promise<void> {
    // 1. Verify JWT signature — throws on invalid/malformed
    let payload: JWTPayload & { sub?: string; purpose?: string; jti?: string };
    try {
      const result = await jwtVerify(token, getJwtSecret(), {
        algorithms: ["HS256"],
      });
      payload = result.payload as typeof payload;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ERR_JWT_EXPIRED") {
        throw new ResetTokenExpiredError("Password reset token has expired.");
      }
      throw new ResetTokenInvalidError(
        "Password reset token is invalid or malformed."
      );
    }

    // 2. Validate purpose claim
    if (payload["purpose"] !== "password-reset") {
      throw new ResetTokenInvalidError(
        "Token was not issued for password reset."
      );
    }

    const userId = payload["sub"];
    const jti = payload["jti"];

    if (!userId || !jti) {
      throw new ResetTokenInvalidError("Token is missing required claims.");
    }

    // 3. Atomic single-use gate via Lua script (GETDEL is atomic in Redis 6.2+,
    // but Lua is universally supported and eliminates TOCTOU between GET and DEL)
    const luaScript = `
      local val = redis.call('GET', KEYS[1])
      if val then redis.call('DEL', KEYS[1]) end
      return val
    `;
    const getVal = await redis.eval(luaScript, 1, `reset:${jti}`) as string | null;

    if (getVal === null) {
      throw new ResetTokenUsedError(
        "Password reset token has already been used."
      );
    }

    // 4. Hash new password
    const newHash = await passwordService.hash(newPassword);

    // 5. Postgres transaction: update password, mark token used, revoke sessions
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        "UPDATE auth.users SET password_hash = $1 WHERE id = $2",
        [newHash, userId]
      );

      await client.query(
        "UPDATE auth.password_reset_tokens SET used_at = now() WHERE jti = $1",
        [jti]
      );

      // Revoke all active sessions — user must re-login after password reset
      await client.query(
        `UPDATE auth.sessions
         SET revoked_at = now(), revoked_reason = 'password_reset'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );

      await client.query("COMMIT");

      // 6. Delete all refresh tokens from Redis via the user-sessions set
      // (refresh_token_jti is a UUID, not the Redis key — the actual key is
      // the hex token string tracked in auth:user-sessions:{userId})
      const tokenKeys = await redis.smembers(`auth:user-sessions:${userId}`);
      for (const tokenKey of tokenKeys) {
        await redis.del(`auth:refresh:${tokenKey}`);
        await redis.del(`auth:token-family:${tokenKey}`);
      }
      await redis.del(`auth:user-sessions:${userId}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await events.publish({
      eventType: "auth.password.reset_completed",
      eventVersion: "1.0",
      tenantId: "",
      actor: { type: "user", id: userId },
      data: { userId },
    });
  }

  // -------------------------------------------------------------------------
  // Verify email (L2 design §6.8)
  // -------------------------------------------------------------------------

  async function verifyEmail(token: string): Promise<VerifyEmailResult> {
    // 1. Verify JWT
    let payload: JWTPayload & { sub?: string; purpose?: string; jti?: string };
    try {
      const result = await jwtVerify(token, getJwtSecret(), {
        algorithms: ["HS256"],
      });
      payload = result.payload as typeof payload;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ERR_JWT_EXPIRED") {
        throw new VerifyTokenExpiredError(
          "Email verification token has expired."
        );
      }
      throw new VerifyTokenInvalidError(
        "Email verification token is invalid or malformed."
      );
    }

    if (payload["purpose"] !== "email-verify") {
      throw new VerifyTokenInvalidError(
        "Token was not issued for email verification."
      );
    }

    const userId = payload["sub"];
    const jti = payload["jti"];

    if (!userId || !jti) {
      throw new VerifyTokenInvalidError("Token is missing required claims.");
    }

    // 2. Atomic single-use gate via Lua script (prevents TOCTOU race on concurrent requests)
    const luaScript = `
      local val = redis.call('GET', KEYS[1])
      if val then redis.call('DEL', KEYS[1]) end
      return val
    `;
    const getVal = await redis.eval(luaScript, 1, `auth:verify:${jti}`) as string | null;

    if (getVal === null) {
      throw new VerifyTokenUsedError(
        "Email verification token has already been used."
      );
    }

    // 3. Check if already verified (idempotent guard)
    const userResult = await db.query<{
      email_verified: boolean;
      tenant_id: string;
    }>(
      "SELECT email_verified, tenant_id FROM auth.users WHERE id = $1",
      [userId]
    );

    const user = userResult.rows[0];
    if (!user) {
      throw new VerifyTokenInvalidError("User not found.");
    }
    if (user.email_verified) {
      throw new EmailAlreadyVerifiedError("Email is already verified.");
    }

    // 4. Mark email as verified
    await db.query(
      "UPDATE auth.users SET email_verified = true WHERE id = $1",
      [userId]
    );

    return {
      message: "Email verified successfully.",
      userId,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  function getJwtExpirySeconds(): number {
    const raw = process.env["OP_JWT_EXPIRY_SECONDS"];
    return raw !== undefined ? parseInt(raw, 10) : 900;
  }

  function getRefreshTokenTtlSeconds(): number {
    const raw = process.env["OP_REFRESH_TOKEN_TTL_SECONDS"];
    return raw !== undefined ? parseInt(raw, 10) : 604_800;
  }

  // -------------------------------------------------------------------------

  return {
    register,
    login,
    logout,
    forgotPassword,
    resetPassword,
    verifyEmail,
  };
}
