// Database row shapes for the auth schema.
// These mirror the SQL schema in the L2 design exactly — no transformation,
// so repository methods can return them directly without mapping.

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
  settings: Record<string, unknown>;
}

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string | null;
  email_verified: boolean;
  is_active: boolean;
  display_name: string | null;
  roles: string[];
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  metadata: Record<string, unknown>;
}

export interface Session {
  id: string;
  user_id: string;
  tenant_id: string;
  refresh_token_jti: string;
  family_id: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  user_agent: string | null;
  ip_address: string | null;
}

export interface ApiKey {
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
  revoked_by: string | null;
}

export interface Role {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string;
  is_predefined: boolean;
  permissions: string[];
  created_at: Date;
  updated_at: Date;
}

export interface OAuthProvider {
  id: string;
  user_id: string;
  tenant_id: string;
  provider: string;
  provider_user_id: string;
  provider_email: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: Date | null;
  token_key_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  client_type: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  tenant_id: string | null;
  app_id: string | null;
  access_mode: string;
  created_at: Date;
  updated_at: Date;
  created_by_service: string | null;
}

export interface BootstrapState {
  id: number;
  bootstrap_completed: boolean;
  completed_at: Date | null;
  admin_user_id: string | null;
  first_tenant_id: string | null;
}

export interface PasswordResetToken {
  jti: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  ip_address: string | null;
}

export interface EntityPermission {
  id: string;
  tenant_id: string;
  entity_type: string;
  role: string;
  actions: string[];
  field_restrictions: Record<string, unknown>;
  row_filter: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Input shapes for create / update operations
// ---------------------------------------------------------------------------

export interface CreateTenantData {
  name: string;
  slug: string;
  settings?: Record<string, unknown>;
}

export interface CreateUserData {
  tenant_id: string;
  email: string;
  password_hash?: string;
  display_name?: string;
  roles?: string[];
  email_verified?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateUserData {
  display_name?: string;
  roles?: string[];
  metadata?: Record<string, unknown>;
  last_login_at?: Date;
  password_hash?: string;
}

export interface CreateSessionData {
  user_id: string;
  tenant_id: string;
  refresh_token_jti: string;
  family_id: string;
  expires_at: Date;
  user_agent?: string;
  ip_address?: string;
}

export interface CreateApiKeyData {
  user_id: string;
  tenant_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes?: string[];
  expires_at?: Date;
}

export interface CreateRoleData {
  tenant_id: string | null;
  name: string;
  description?: string;
  is_predefined?: boolean;
  permissions?: string[];
}

export interface UpdateRoleData {
  description?: string;
  permissions?: string[];
}

export interface UpsertOAuthProviderData {
  user_id: string;
  tenant_id: string;
  provider: string;
  provider_user_id: string;
  provider_email?: string;
  access_token_encrypted?: string;
  refresh_token_encrypted?: string;
  token_expires_at?: Date;
  token_key_version?: number;
}

export interface UpsertOAuthClientData {
  client_id: string;
  client_secret_hash?: string;
  client_type?: string;
  redirect_uris?: string[];
  allowed_scopes?: string[];
  tenant_id?: string;
  app_id?: string;
  access_mode?: string;
  created_by_service?: string;
}

export interface CreatePasswordResetData {
  jti: string;
  user_id: string;
  expires_at: Date;
  ip_address?: string;
}

// ---------------------------------------------------------------------------
// Redis payload shapes
// ---------------------------------------------------------------------------

export interface RefreshTokenPayload {
  userId: string;
  tenantId: string;
  sessionId: string;
  jti: string;
  familyId: string;
}

export interface OAuthStatePayload {
  provider: string;
  pkceVerifier: string;
  redirectUri: string;
  tenantId: string;
}

export interface GuestSessionPayload {
  tenantId: string;
  appId: string;
  createdAt: string;
  ipAddress: string;
}
