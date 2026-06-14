/**
 * Auth service OpenAPI 3.0.3 route metadata.
 *
 * This file is the contract between the auth route implementations and the
 * OpenAPI documentation system. It is a pure data file — no request handling,
 * no Hono imports. The generator reads it at build time via dynamic import.
 *
 * WHY this file exists alongside routes/:
 *   The routes use manual safeParse() — the relationship between a path, method,
 *   and schema is implicit in the handler. This file makes that mapping explicit
 *   for documentation without requiring a refactor of 188 route handlers.
 *
 * Convention:
 *   Every response schema must have .describe("UniquePascalCaseName") so the
 *   generator can assign a stable component name. The generator throws at build
 *   time if .describe() is missing.
 *
 * Routes excluded:
 *   All routes in internal.ts (paths starting with /internal/) are internal
 *   service-to-service routes protected by X-Service-Token. They are not
 *   documented in the public spec per the security policy in design doc §13.
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  bootstrapStatusResponse,
  bootstrapRequest,
  bootstrapResponse,
  registerRequest,
  registerResponse,
  loginRequest,
  loginResponse,
  logoutRequest,
  refreshRequest,
  refreshResponse,
  forgotPasswordRequest,
  forgotPasswordResponse,
  resetPasswordRequest,
  resetPasswordResponse,
  verifyEmailResponse,
  oauthAuthorizeQuery,
  oauthCallbackQuery,
  createApiKeyRequest,
  apiKeyResponse,
  apiKeyListResponse,
  rotateApiKeyResponse,
  createRoleRequest,
  updateRoleRequest,
  roleResponse,
  roleListResponse,
  updateRolePermissionsRequest,
  rolePermissionsResponse,
  updateUserRequest,
  userResponse,
  userListResponse,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// User query schema (inline — not in schemas/index.ts because it is a
// query-param-only shape used only for documentation)
// ---------------------------------------------------------------------------

const userListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const apiKeyListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const roleListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Simple 204 No Content response (used for logout, delete routes)
// ---------------------------------------------------------------------------

const noContentResponse = z
  .object({})
  .describe("NoContentResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Auth Service",
    description:
      "Authentication, authorization, API keys, roles, and user management for OnePlatform. " +
      "Provides JWT-based session management, OAuth 2.0 provider flows, and RBAC.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Bootstrap",
      description:
        "First-run platform initialization. One-time use — returns 410 Gone after completion.",
    },
    {
      name: "Auth",
      description: "Login, logout, token refresh, and password reset flows",
    },
    {
      name: "OAuth",
      description: "OAuth 2.0 provider authorization and callback flows",
    },
    {
      name: "API Keys",
      description: "Programmatic access credentials scoped to specific permissions",
    },
    {
      name: "Roles",
      description: "RBAC role management for tenant-scoped access control",
    },
    {
      name: "Users",
      description: "User management within a tenant",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Bootstrap
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/bootstrap/status",
      summary: "Bootstrap status",
      description:
        "Returns whether the platform has been bootstrapped (first admin user created). " +
        "Used by the setup wizard to determine whether to show the bootstrap form.",
      tags: ["Bootstrap"],
      security: [],
      response: {
        200: bootstrapStatusResponse.describe("BootstrapStatusResponse"),
      },
    },
    {
      method: "POST",
      path: "/api/v1/bootstrap",
      summary: "Bootstrap the platform",
      description:
        "Creates the first admin user and tenant. Requires the bootstrap token set via " +
        "the OP_BOOTSTRAP_TOKEN environment variable. Returns 410 Gone after first call.",
      tags: ["Bootstrap"],
      security: [],
      body: { schema: bootstrapRequest.describe("BootstrapRequest"), contentType: "application/json" },
      response: {
        201: bootstrapResponse.describe("BootstrapResponse"),
      },
    },

    // -----------------------------------------------------------------------
    // Auth: register, login, logout, refresh
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/auth/register",
      summary: "Register a new user",
      description:
        "Creates a new user account within an existing tenant. " +
        "When email verification is enabled, tokens are omitted from the response.",
      tags: ["Auth"],
      security: [],
      body: {
        schema: registerRequest.describe("RegisterRequest"),
        contentType: "application/json",
      },
      response: {
        201: registerResponse.describe("RegisterResponse"),
      },
    },
    {
      method: "POST",
      path: "/api/v1/auth/login",
      summary: "Login",
      description:
        "Authenticates a user and returns JWT access and refresh tokens. " +
        "Browser clients receive tokens in httpOnly cookies in addition to the response body.",
      tags: ["Auth"],
      security: [],
      body: {
        schema: loginRequest.describe("LoginRequest"),
        contentType: "application/json",
      },
      response: {
        200: loginResponse.describe("LoginResponse"),
      },
    },
    {
      method: "POST",
      path: "/api/v1/auth/logout",
      summary: "Logout",
      description:
        "Revokes the current session. Set `all: true` to revoke all active sessions " +
        "for the user (emergency logout).",
      tags: ["Auth"],
      body: {
        schema: logoutRequest.describe("LogoutRequest"),
        contentType: "application/json",
      },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/auth/refresh",
      summary: "Refresh access token",
      description:
        "Rotates the refresh token and issues a new access token. " +
        "The old refresh token is immediately invalidated (token rotation).",
      tags: ["Auth"],
      security: [],
      body: {
        schema: refreshRequest.describe("RefreshRequest"),
        contentType: "application/json",
      },
      response: {
        200: refreshResponse.describe("RefreshResponse"),
      },
    },

    // -----------------------------------------------------------------------
    // Auth: password reset
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/auth/forgot-password",
      summary: "Request password reset",
      description:
        "Sends a password reset link to the email address if an account exists. " +
        "Always returns the same message to prevent user enumeration.",
      tags: ["Auth"],
      security: [],
      body: {
        schema: forgotPasswordRequest.describe("ForgotPasswordRequest"),
        contentType: "application/json",
      },
      response: {
        200: forgotPasswordResponse.describe("ForgotPasswordResponse"),
      },
    },
    {
      method: "POST",
      path: "/api/v1/auth/reset-password/{token}",
      summary: "Reset password",
      description:
        "Sets a new password using a reset token received via email. " +
        "The reset token is single-use and expires after 1 hour. " +
        "Note: the resetPasswordRequest schema uses .refine() to validate that " +
        "newPassword equals confirmPassword — this constraint is enforced at runtime " +
        "but is not representable in the OpenAPI schema (see design doc §15 L-2).",
      tags: ["Auth"],
      security: [],
      params: {
        token: z.string().describe("PasswordResetToken"),
      },
      body: {
        schema: resetPasswordRequest.describe("ResetPasswordRequest"),
        contentType: "application/json",
      },
      response: {
        200: resetPasswordResponse.describe("ResetPasswordResponse"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/auth/verify-email/{token}",
      summary: "Verify email address",
      description: "Confirms a user's email address using the token sent during registration.",
      tags: ["Auth"],
      security: [],
      params: {
        token: z.string().describe("EmailVerificationToken"),
      },
      response: {
        200: verifyEmailResponse.describe("VerifyEmailResponse"),
      },
    },

    // -----------------------------------------------------------------------
    // OAuth
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/oauth/{provider}/authorize",
      summary: "Start OAuth authorization",
      description:
        "Redirects the browser to the OAuth provider's consent screen. " +
        "Supported providers: google, github. Returns 302 Redirect.",
      tags: ["OAuth"],
      security: [],
      params: {
        provider: z.enum(["google", "github"]).describe("OAuthProvider"),
      },
      query: { schema: oauthAuthorizeQuery },
      response: {
        // 302 redirect — no JSON body, documented for completeness
        200: z
          .object({ location: z.string().url() })
          .describe("OAuthAuthorizeRedirect"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/oauth/{provider}/callback",
      summary: "OAuth provider callback",
      description:
        "Receives the authorization code from the OAuth provider, exchanges it for " +
        "platform tokens, and returns JWT access and refresh tokens. " +
        "The state parameter is validated against the Redis-stored PKCE verifier.",
      tags: ["OAuth"],
      security: [],
      params: {
        provider: z.enum(["google", "github"]).describe("OAuthCallbackProvider"),
      },
      query: { schema: oauthCallbackQuery },
      response: {
        200: loginResponse.describe("OAuthLoginResponse"),
      },
    },

    // -----------------------------------------------------------------------
    // API Keys
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/api-keys",
      summary: "Create API key",
      description:
        "Creates a new API key scoped to the authenticated user. " +
        "The full key value is returned only on creation — store it securely.",
      tags: ["API Keys"],
      body: {
        schema: createApiKeyRequest.describe("CreateApiKeyRequest"),
        contentType: "application/json",
      },
      response: {
        201: apiKeyResponse.describe("ApiKeyResponse"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/api-keys",
      summary: "List API keys",
      description:
        "Lists all API keys for the authenticated user. The key value is not returned " +
        "in list responses — only the key prefix is shown.",
      tags: ["API Keys"],
      query: { schema: apiKeyListQuery },
      response: {
        200: apiKeyListResponse.describe("ApiKeyListResponse"),
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/api-keys/{id}",
      summary: "Revoke API key",
      description: "Permanently revokes an API key. The key is immediately invalid.",
      tags: ["API Keys"],
      params: { id: z.string().uuid().describe("ApiKeyId") },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/api-keys/{id}/rotate",
      summary: "Rotate API key",
      description:
        "Atomically revokes the old key and issues a new one with the same scopes. " +
        "The new key value is returned once and must be stored securely.",
      tags: ["API Keys"],
      params: { id: z.string().uuid().describe("RotateApiKeyId") },
      response: {
        200: rotateApiKeyResponse.describe("RotateApiKeyResponse"),
      },
    },

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/roles",
      summary: "Create role",
      description:
        "Creates a new tenant-scoped RBAC role. Requires the users:manage scope.",
      tags: ["Roles"],
      body: {
        schema: createRoleRequest.describe("CreateRoleRequest"),
        contentType: "application/json",
      },
      response: {
        201: roleResponse.describe("RoleResponse"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/roles",
      summary: "List roles",
      description: "Lists all roles visible to the caller's tenant, including predefined roles.",
      tags: ["Roles"],
      query: { schema: roleListQuery },
      response: {
        200: roleListResponse.describe("RoleListResponse"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/roles/{id}",
      summary: "Get role",
      tags: ["Roles"],
      params: { id: z.string().uuid().describe("RoleId") },
      response: {
        200: roleResponse.describe("RoleDetailResponse"),
      },
    },
    {
      method: "PUT",
      path: "/api/v1/roles/{id}",
      summary: "Update role",
      description:
        "Updates a tenant-scoped role. Predefined roles are immutable and return 403. " +
        "Requires the users:manage scope.",
      tags: ["Roles"],
      params: { id: z.string().uuid().describe("UpdateRoleId") },
      body: {
        schema: updateRoleRequest.describe("UpdateRoleRequest"),
        contentType: "application/json",
      },
      response: {
        200: roleResponse.describe("UpdateRoleResponse"),
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/roles/{id}",
      summary: "Delete role",
      description:
        "Soft-deletes a tenant-scoped role. Predefined roles cannot be deleted. " +
        "Requires the users:manage scope.",
      tags: ["Roles"],
      params: { id: z.string().uuid().describe("DeleteRoleId") },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/roles/{id}/permissions",
      summary: "Get role permissions",
      description: "Returns the entity-level permissions assigned to a role.",
      tags: ["Roles"],
      params: { id: z.string().uuid().describe("RolePermissionsId") },
      response: {
        200: rolePermissionsResponse.describe("RolePermissionsResponse"),
      },
    },
    {
      method: "PUT",
      path: "/api/v1/roles/{id}/permissions",
      summary: "Set role permissions",
      description:
        "Fully replaces the entity permissions for a role (not a partial update). " +
        "Requires the users:manage scope. Predefined role permissions cannot be changed.",
      tags: ["Roles"],
      params: { id: z.string().uuid().describe("SetRolePermissionsId") },
      body: {
        schema: updateRolePermissionsRequest.describe("UpdateRolePermissionsRequest"),
        contentType: "application/json",
      },
      response: {
        200: rolePermissionsResponse.describe("UpdateRolePermissionsResponse"),
      },
    },

    // -----------------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/users",
      summary: "List users",
      description:
        "Lists users in the caller's tenant. Requires the users:read scope.",
      tags: ["Users"],
      query: { schema: userListQuery },
      response: {
        200: userListResponse.describe("UserListResponse"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/users/{id}",
      summary: "Get user",
      description:
        "Returns a user by ID. Requires the users:read scope, " +
        "unless the caller is reading their own record.",
      tags: ["Users"],
      params: { id: z.string().uuid().describe("UserId") },
      response: {
        200: userResponse.describe("UserResponse"),
      },
    },
    {
      method: "PUT",
      path: "/api/v1/users/{id}",
      summary: "Update user",
      description:
        "Updates a user record. Any authenticated user can update their own displayName. " +
        "Changing roles or isActive requires the users:manage scope.",
      tags: ["Users"],
      params: { id: z.string().uuid().describe("UpdateUserId") },
      body: {
        schema: updateUserRequest.describe("UpdateUserRequest"),
        contentType: "application/json",
      },
      response: {
        200: userResponse.describe("UpdateUserResponse"),
      },
    },
  ],
};
