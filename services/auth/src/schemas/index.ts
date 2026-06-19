/**
 * Auth Service — Zod request/response schemas.
 *
 * These schemas are the single source of truth for input validation and are
 * also used at build time to auto-generate the OpenAPI 3.1 spec.
 *
 * WHY Zod (not a hand-rolled type guard or joi):
 *   - Strict TypeScript inference means the inferred types are always in sync
 *     with the runtime validation.
 *   - The OpenAPI generator (@oneplatform build tooling) reads Zod schemas
 *     directly, so there is no divergence between the spec and the runtime.
 *   - @oneplatform/core already bundles zod — no additional install footprint.
 *
 * All email fields use .toLowerCase() to normalise before storage/lookup.
 * This matches the database index on lower(email) and prevents duplicate
 * accounts created via case variations.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Complete set of scopes that can be granted to an API key.
 * Also used to validate role permissions arrays.
 */
export const ApiKeyScope = z.enum([
  "data:read",
  "data:write",
  "ontology:read",
  "ontology:write",
  "pipelines:read",
  "pipelines:trigger",
  "pipelines:manage",
  "apps:read",
  "apps:deploy",
  "apps:manage",
  "plugins:read",
  "plugins:manage",
  "users:read",
  "users:manage",
  "logs:read",
  "logs:export",
  "audit:read",
  "webhooks:manage",
  "execution:read",
  "execution:run",
  "admin",
]);

export type ApiKeyScopeValue = z.infer<typeof ApiKeyScope>;

const paginationResponse = z.object({
  nextCursor: z.string().nullable(),
  total: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// 4.1 Bootstrap
// ---------------------------------------------------------------------------

export const bootstrapStatusResponse = z.object({
  data: z.object({
    completed: z.boolean(),
  }),
});

export const bootstrapRequest = z.object({
  adminEmail: z.string().email().max(254),
  adminPassword: z.string().min(12).max(128)
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[a-z]/, "Must contain lowercase")
    .regex(/[0-9]/, "Must contain a digit")
    .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
  tenantName: z.string().min(1).max(100).trim(),
  // 32 bytes hex-encoded = exactly 64 hex characters
  bootstrapToken: z.string().length(64).regex(/^[0-9a-f]{64}$/i, "Bootstrap token must be 64 hex characters"),
});

export const bootstrapResponse = z.object({
  data: z.object({
    tenantId: z.string().uuid(),
    adminUserId: z.string().uuid(),
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
  }),
});

// Internal-only: returned by GET /internal/auth/master-key-display
export const masterKeyDisplayResponse = z.object({
  data: z.object({
    masterKey: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// 4.2 Registration
// ---------------------------------------------------------------------------

export const registerRequest = z.object({
  email: z.string().email().max(254).toLowerCase(),
  password: z.string().min(12).max(128)
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[a-z]/, "Must contain lowercase")
    .regex(/[0-9]/, "Must contain a digit")
    .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
  displayName: z.string().min(1).max(100).trim().optional(),
  // tenantId required — self-registration is always scoped to an existing tenant
  tenantId: z.string().uuid(),
});

export const registerResponse = z.object({
  data: z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    tenantId: z.string().uuid(),
    roles: z.array(z.string()),
    // accessToken and refreshToken are absent when email verification is required
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresIn: z.number().optional(),
    requiresEmailVerification: z.boolean(),
  }),
});

// ---------------------------------------------------------------------------
// 4.2 Login
// ---------------------------------------------------------------------------

export const loginRequest = z.object({
  email: z.string().email().max(254).toLowerCase(),
  // min(1) because we must call bcrypt.compare regardless — Zod rejects empty
  // passwords before they reach the bcrypt path
  password: z.string().min(1).max(128),
  tenantId: z.string().uuid(),
});

const loginUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  tenantId: z.string().uuid(),
  roles: z.array(z.string()),
  emailVerified: z.boolean(),
});

export const loginResponse = z.object({
  data: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
    tokenType: z.literal("Bearer"),
    user: loginUser,
  }),
});

// ---------------------------------------------------------------------------
// 4.2 Logout
// ---------------------------------------------------------------------------

export const logoutRequest = z.object({
  refreshToken: z.string().optional(),
  // When true, all sessions for the current user are revoked
  all: z.boolean().optional().default(false),
});

// Response is 204 No Content — no body schema needed.

// ---------------------------------------------------------------------------
// 4.2 Refresh
// ---------------------------------------------------------------------------

export const refreshRequest = z.object({
  refreshToken: z.string(),
});

export const refreshResponse = z.object({
  data: z.object({
    accessToken: z.string(),
    // New token — old token is now invalid
    refreshToken: z.string(),
    expiresIn: z.number(),
    tokenType: z.literal("Bearer"),
  }),
});

// ---------------------------------------------------------------------------
// 4.2 Password reset
// ---------------------------------------------------------------------------

export const forgotPasswordRequest = z.object({
  email: z.string().email().max(254).toLowerCase(),
  tenantId: z.string().uuid(),
});

export const forgotPasswordResponse = z.object({
  data: z.object({
    message: z.literal(
      "If an account with this email exists, a reset link has been sent."
    ),
    // Only present when SMTP is not configured (link-copy / dev mode)
    resetLink: z.string().url().optional(),
  }),
});

export const resetPasswordRequest = z
  .object({
    newPassword: z.string().min(12).max(128)
      .regex(/[A-Z]/, "Must contain uppercase")
      .regex(/[a-z]/, "Must contain lowercase")
      .regex(/[0-9]/, "Must contain a digit")
      .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
    confirmPassword: z.string().min(12).max(128)
      .regex(/[A-Z]/, "Must contain uppercase")
      .regex(/[a-z]/, "Must contain lowercase")
      .regex(/[0-9]/, "Must contain a digit")
      .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const resetPasswordResponse = z.object({
  data: z.object({
    message: z.literal("Password reset successfully. Please log in again."),
  }),
});

// ---------------------------------------------------------------------------
// 4.2 Authenticated password change
// ---------------------------------------------------------------------------

export const changePasswordRequest = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(12).max(128)
      .regex(/[A-Z]/, "Must contain uppercase")
      .regex(/[a-z]/, "Must contain lowercase")
      .regex(/[0-9]/, "Must contain a digit")
      .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
    confirmPassword: z.string().min(12).max(128)
      .regex(/[A-Z]/, "Must contain uppercase")
      .regex(/[a-z]/, "Must contain lowercase")
      .regex(/[0-9]/, "Must contain a digit")
      .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const changePasswordResponse = z.object({
  data: z.object({
    message: z.literal("Password changed successfully."),
  }),
});

// ---------------------------------------------------------------------------
// 4.2 Email verification
// ---------------------------------------------------------------------------

export const verifyEmailResponse = z.object({
  data: z.object({
    message: z.literal("Email verified successfully."),
    userId: z.string().uuid(),
  }),
});

// ---------------------------------------------------------------------------
// 4.3 OAuth
// ---------------------------------------------------------------------------

export const oauthAuthorizeQuery = z.object({
  tenantId: z.string().uuid(),
  // If omitted, defaults to OP_BASE_URL + /auth/callback
  redirectUri: z.string().url().optional(),
});

export const oauthCallbackQuery = z.object({
  code: z.string(),
  state: z.string(),
  // Set by provider when the user denies permission
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 4.4 API keys
// ---------------------------------------------------------------------------

export const createApiKeyRequest = z.object({
  name: z.string().min(1).max(100).trim(),
  scopes: z.array(ApiKeyScope).min(1),
  // If omitted, key never expires
  expiresAt: z.string().datetime().optional(),
});

export const apiKeyResponse = z.object({
  data: z.object({
    id: z.string().uuid(),
    name: z.string(),
    // Only returned on creation. Subsequent calls return keyPrefix only.
    key: z.string(),
    keyPrefix: z.string().length(8),
    scopes: z.array(z.string()),
    expiresAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  }),
});

const apiKeyListItem = z.object({
  id: z.string().uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});

export const apiKeyListResponse = z.object({
  data: z.array(apiKeyListItem),
  pagination: paginationResponse,
});

export const rotateApiKeyResponse = z.object({
  data: z.object({
    id: z.string().uuid(),
    // New key value — returned once
    key: z.string(),
    keyPrefix: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.string().datetime(),
  }),
});

// ---------------------------------------------------------------------------
// 4.5 Roles
// ---------------------------------------------------------------------------

export const createRoleRequest = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9\-_]{0,62}$/),
  description: z.string().max(500).default(""),
  permissions: z.array(z.string()).max(50),
});

export const updateRoleRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(50).optional(),
});

export const roleResponse = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  name: z.string(),
  description: z.string(),
  isPredefined: z.boolean(),
  permissions: z.array(z.string()),
  createdAt: z.string().datetime(),
});

export const roleListResponse = z.object({
  data: z.array(roleResponse),
  pagination: z.object({
    nextCursor: z.string().nullable(),
    total: z.number(),
  }),
});

const entityPermission = z.object({
  entityType: z.string(),
  actions: z.array(z.string()),
  fieldRestrictions: z.object({
    denyRead: z.array(z.string()),
    denyWrite: z.array(z.string()),
  }),
  rowFilter: z.record(z.string()),
});

export const rolePermissionsResponse = z.object({
  data: z.object({
    roleId: z.string().uuid(),
    entityPermissions: z.array(entityPermission),
  }),
});

// Request body for PUT /api/v1/roles/{id}/permissions (full replace)
export const updateRolePermissionsRequest = z.object({
  entityPermissions: z.array(entityPermission),
});

// ---------------------------------------------------------------------------
// 4.5b Tenants
// ---------------------------------------------------------------------------

export const createTenantRequest = z.object({
  name: z.string().min(1).max(100).trim(),
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase alphanumeric with hyphens, e.g. 'my-org'",
    ),
  settings: z.record(z.unknown()).optional(),
});

export const updateTenantRequest = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  settings: z.record(z.unknown()).optional(),
});

const tenantResponseItem = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  settings: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const tenantResponse = tenantResponseItem;

export const tenantListResponse = z.object({
  data: z.array(tenantResponseItem),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// 4.6 Users
// ---------------------------------------------------------------------------

export const createUserRequest = z.object({
  email: z.string().email().max(254).toLowerCase(),
  roles: z.array(z.string()).min(1),
  displayName: z.string().min(1).max(100).trim().optional(),
  // If omitted, a password reset email is sent to the user.
  temporaryPassword: z.string().min(12).max(128)
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[a-z]/, "Must contain lowercase")
    .regex(/[0-9]/, "Must contain a digit")
    .regex(/[^A-Za-z0-9]/, "Must contain a special character")
    .optional(),
});

export const updateUserRequest = z.object({
  displayName: z.string().min(1).max(100).optional(),
  // Role changes require users:manage scope
  roles: z.array(z.string()).optional(),
  // Activation changes require tenant-admin or platform-admin
  isActive: z.boolean().optional(),
});

export const userResponse = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  roles: z.array(z.string()),
  emailVerified: z.boolean(),
  isActive: z.boolean(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const userListResponse = z.object({
  data: z.array(userResponse),
  pagination: z.object({
    nextCursor: z.string().nullable(),
    total: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// 5. Internal endpoints
// ---------------------------------------------------------------------------

export const validateQuery = z.object({
  token: z.string(),
});

// Union: valid response vs. invalid-token response.
// The endpoint always returns 200 — callers check the `valid` field.
// z.discriminatedUnion requires the discriminant at the top level of the
// object, but the design spec places `valid` inside the `data` envelope.
// We use z.union here so the discriminant can live inside `data` as designed.
export const validateResponse = z.union([
  z.object({
    data: z.object({
      valid: z.literal(true),
      userId: z.string().uuid(),
      tenantId: z.string().uuid(),
      roles: z.array(z.string()),
      scopes: z.array(z.string()),
      emailVerified: z.boolean(),
      isGuest: z.literal(false),
      sessionId: z.string().uuid(),
    }),
  }),
  z.object({
    data: z.object({
      valid: z.literal(false),
      // e.g., "TOKEN_EXPIRED", "TOKEN_REVOKED", "TOKEN_INVALID"
      reason: z.string(),
    }),
  }),
]);

export const guestSessionRequest = z.object({
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  ipAddress: z.string().ip().optional(),
});

export const guestSessionResponse = z.object({
  data: z.object({
    // 32-byte hex = 64 characters, stored in op_guest_session cookie
    guestToken: z.string().length(64),
    expiresAt: z.string().datetime(),
  }),
});

export const oauthClientRequest = z.object({
  clientId: z
    .string()
    .regex(/^app:[0-9a-f-]{36}:[0-9a-f-]{36}$/)
    .or(z.string().regex(/^client_[0-9a-f-]{36}$/)),
  clientType: z.enum(["public", "confidential"]).default("public"),
  redirectUris: z.array(z.string().url()).min(1).max(10),
  allowedScopes: z.array(z.string()).min(1).max(20),
  tenantId: z.string().uuid(),
  appId: z.string().uuid().optional(),
  accessMode: z.enum(["platform-user", "public"]).default("platform-user"),
});

export const oauthClientResponse = z.object({
  data: z.object({
    clientId: z.string(),
    clientType: z.enum(["public", "confidential"]),
    redirectUris: z.array(z.string()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types (used throughout service implementation)
// ---------------------------------------------------------------------------

export type BootstrapStatusResponse = z.infer<typeof bootstrapStatusResponse>;
export type BootstrapRequest = z.infer<typeof bootstrapRequest>;
export type BootstrapResponse = z.infer<typeof bootstrapResponse>;
export type MasterKeyDisplayResponse = z.infer<typeof masterKeyDisplayResponse>;

export type RegisterRequest = z.infer<typeof registerRequest>;
export type RegisterResponse = z.infer<typeof registerResponse>;

export type LoginRequest = z.infer<typeof loginRequest>;
export type LoginResponse = z.infer<typeof loginResponse>;

export type LogoutRequest = z.infer<typeof logoutRequest>;

export type RefreshRequest = z.infer<typeof refreshRequest>;
export type RefreshResponse = z.infer<typeof refreshResponse>;

export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequest>;
export type ForgotPasswordResponse = z.infer<typeof forgotPasswordResponse>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequest>;
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponse>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequest>;
export type ChangePasswordResponse = z.infer<typeof changePasswordResponse>;

export type VerifyEmailResponse = z.infer<typeof verifyEmailResponse>;

export type OauthAuthorizeQuery = z.infer<typeof oauthAuthorizeQuery>;
export type OauthCallbackQuery = z.infer<typeof oauthCallbackQuery>;

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequest>;
export type ApiKeyResponse = z.infer<typeof apiKeyResponse>;
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponse>;
export type RotateApiKeyResponse = z.infer<typeof rotateApiKeyResponse>;

export type CreateRoleRequest = z.infer<typeof createRoleRequest>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequest>;
export type RoleResponse = z.infer<typeof roleResponse>;
export type RoleListResponse = z.infer<typeof roleListResponse>;
export type RolePermissionsResponse = z.infer<typeof rolePermissionsResponse>;
export type UpdateRolePermissionsRequest = z.infer<
  typeof updateRolePermissionsRequest
>;

export type CreateTenantRequest = z.infer<typeof createTenantRequest>;
export type UpdateTenantRequest = z.infer<typeof updateTenantRequest>;
export type TenantResponse = z.infer<typeof tenantResponse>;
export type TenantListResponse = z.infer<typeof tenantListResponse>;

export type CreateUserRequest = z.infer<typeof createUserRequest>;
export type UpdateUserRequest = z.infer<typeof updateUserRequest>;
export type UserResponse = z.infer<typeof userResponse>;
export type UserListResponse = z.infer<typeof userListResponse>;

export type ValidateQuery = z.infer<typeof validateQuery>;
export type ValidateResponse = z.infer<typeof validateResponse>;
export type GuestSessionRequest = z.infer<typeof guestSessionRequest>;
export type GuestSessionResponse = z.infer<typeof guestSessionResponse>;
export type OauthClientRequest = z.infer<typeof oauthClientRequest>;
export type OauthClientResponse = z.infer<typeof oauthClientResponse>;
