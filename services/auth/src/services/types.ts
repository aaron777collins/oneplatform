// Service-layer input/output types for the Auth Service.
// These are distinct from HTTP request/response schemas (Zod) — they represent
// the contracts between the route layer and the service layer.

import type { UserContext } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

/**
 * Minimal user data needed to issue an access JWT.
 * Pulled from auth.users; scopes are resolved from roles at issuance time.
 */
export interface UserForToken {
  id: string;
  tenantId: string;
  roles: string[];
  emailVerified: boolean;
  /** User's email — included in JWT claims for downstream display. */
  email?: string | undefined;
  /** User's display name — included in JWT claims for downstream display. */
  displayName?: string | undefined;
}

/**
 * Decoded claims from a verified access JWT.
 * Mirrors AccessTokenPayload in the L2 design §6.3.
 */
export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  tid: string;
  roles: string[];
  scopes: string[];
  ev: boolean;
  unverified: boolean;
  /** User's email — present when the token was issued with email context. */
  email?: string | undefined;
  /** User's display name — present when the token was issued with display name context. */
  displayName?: string | undefined;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
  tenantId: string;
}

export interface RegisterResult {
  userId: string;
  email: string;
  tenantId: string;
  roles: string[];
  requiresEmailVerification: boolean;
  // Present when email verification is NOT required
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  // Present in link-copy mode (no SMTP) when verification IS required
  verifyLink?: string;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginInput {
  email: string;
  password: string;
  tenantId: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: "Bearer";
  user: {
    id: string;
    email: string;
    displayName: string | null;
    tenantId: string;
    roles: string[];
    emailVerified: boolean;
  };
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export interface ForgotPasswordResult {
  message: string;
  // Present in link-copy mode only (OP_SMTP_HOST not set)
  resetLink?: string;
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export interface VerifyEmailResult {
  message: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapInput {
  adminEmail: string;
  adminPassword: string;
  tenantName: string;
  bootstrapToken: string;
  /** Caller's IP address for rate limiting. */
  ipAddress: string;
}

export interface BootstrapResult {
  tenantId: string;
  adminUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
  expiresAt?: string; // ISO datetime or undefined for no expiry
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  tenantId: string;
  name: string;
  /** First 8 chars of the random portion — used for fast DB lookup. */
  keyPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
  tenantId: string;
  isNewUser: boolean;
}

// ---------------------------------------------------------------------------
// RBAC / entity permissions
// ---------------------------------------------------------------------------

/**
 * Field-level access restrictions for a given (user, entityType) pair.
 * denyRead: fields stripped from response payloads.
 * denyWrite: fields rejected in mutation request bodies.
 */
export interface FieldRestrictions {
  denyRead: string[];
  denyWrite: string[];
}

/**
 * Row-level filter predicate injected into queries.
 * Values may contain "$userId" which the query builder substitutes at runtime.
 * Multiple roles' filters are ANDed together.
 */
export interface RowFilter {
  conditions: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Guest sessions
// ---------------------------------------------------------------------------

export interface GuestSessionResult {
  guestToken: string;
  expiresAt: Date;
}

export interface GuestSessionPayload {
  tenantId: string;
  appId: string;
  createdAt: string;
  ipAddress?: string;
}

// ---------------------------------------------------------------------------
// Re-export UserContext for convenience within service layer
// ---------------------------------------------------------------------------
export type { UserContext };
