// Auth-service-specific error classes that extend @oneplatform/core's AppError.
// All codes are prefixed with AUTH_ per the error registry in L2 design §10.
// Standard codes (UNAUTHORIZED, FORBIDDEN, etc.) come directly from core.

import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Bootstrap errors
// ---------------------------------------------------------------------------

export class BootstrapAlreadyCompletedError extends AppError {
  readonly code = "AUTH_BOOTSTRAP_ALREADY_COMPLETED" as const;
  // 410 Gone — the bootstrap endpoint is permanently disabled after first run
  readonly statusCode = 410;
}

export class BootstrapInvalidTokenError extends AppError {
  readonly code = "AUTH_BOOTSTRAP_INVALID_TOKEN" as const;
  readonly statusCode = 401;
}

export class BootstrapTokenMissingError extends AppError {
  readonly code = "AUTH_BOOTSTRAP_TOKEN_MISSING" as const;
  readonly statusCode = 503;
}

// ---------------------------------------------------------------------------
// Account state errors
// ---------------------------------------------------------------------------

export class AccountLockedError extends AppError {
  readonly code = "AUTH_ACCOUNT_LOCKED" as const;
  readonly statusCode = 403;
}

export class AccountDeactivatedError extends AppError {
  readonly code = "AUTH_ACCOUNT_DEACTIVATED" as const;
  readonly statusCode = 403;
}

export class EmailNotVerifiedError extends AppError {
  readonly code = "AUTH_EMAIL_NOT_VERIFIED" as const;
  readonly statusCode = 403;
}

export class EmailAlreadyVerifiedError extends AppError {
  readonly code = "AUTH_EMAIL_ALREADY_VERIFIED" as const;
  readonly statusCode = 409;
}

// ---------------------------------------------------------------------------
// Token errors
// ---------------------------------------------------------------------------

export class TokenReplayDetectedError extends AppError {
  readonly code = "AUTH_TOKEN_REPLAY_DETECTED" as const;
  readonly statusCode = 401;
}

export class SessionRevokedError extends AppError {
  readonly code = "AUTH_SESSION_REVOKED" as const;
  readonly statusCode = 401;
}

export class ResetTokenInvalidError extends AppError {
  readonly code = "AUTH_RESET_TOKEN_INVALID" as const;
  readonly statusCode = 401;
}

export class ResetTokenExpiredError extends AppError {
  readonly code = "AUTH_RESET_TOKEN_EXPIRED" as const;
  readonly statusCode = 401;
}

export class ResetTokenUsedError extends AppError {
  readonly code = "AUTH_RESET_TOKEN_USED" as const;
  readonly statusCode = 401;
}

export class VerifyTokenInvalidError extends AppError {
  readonly code = "AUTH_VERIFY_TOKEN_INVALID" as const;
  readonly statusCode = 401;
}

export class VerifyTokenExpiredError extends AppError {
  readonly code = "AUTH_VERIFY_TOKEN_EXPIRED" as const;
  readonly statusCode = 401;
}

export class VerifyTokenUsedError extends AppError {
  readonly code = "AUTH_VERIFY_TOKEN_USED" as const;
  readonly statusCode = 401;
}

// ---------------------------------------------------------------------------
// Tenant / registration errors
// ---------------------------------------------------------------------------

export class TenantNotFoundError extends AppError {
  readonly code = "AUTH_TENANT_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class RegistrationDisabledError extends AppError {
  readonly code = "AUTH_REGISTRATION_DISABLED" as const;
  readonly statusCode = 403;
}

// ---------------------------------------------------------------------------
// RBAC errors
// ---------------------------------------------------------------------------

export class PredefinedRoleImmutableError extends AppError {
  readonly code = "AUTH_PREDEFINED_ROLE_IMMUTABLE" as const;
  readonly statusCode = 403;
}

export class PredefinedRoleConflictError extends AppError {
  readonly code = "AUTH_PREDEFINED_ROLE_CONFLICT" as const;
  readonly statusCode = 409;
}

export class InsufficientScopeError extends AppError {
  readonly code = "AUTH_INSUFFICIENT_SCOPE" as const;
  readonly statusCode = 403;
}

// ---------------------------------------------------------------------------
// OAuth errors
// ---------------------------------------------------------------------------

export class OAuthProviderDisabledError extends AppError {
  readonly code = "AUTH_OAUTH_PROVIDER_DISABLED" as const;
  readonly statusCode = 400;
}

export class OAuthStateInvalidError extends AppError {
  readonly code = "AUTH_OAUTH_STATE_INVALID" as const;
  readonly statusCode = 401;
}

export class OAuthExchangeFailedError extends AppError {
  readonly code = "AUTH_OAUTH_EXCHANGE_FAILED" as const;
  readonly statusCode = 502;
}

export class OAuthEmailMissingError extends AppError {
  readonly code = "AUTH_OAUTH_EMAIL_MISSING" as const;
  readonly statusCode = 400;
}
