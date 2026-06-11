// Database row shapes for the app schema.
// Column names mirror the SQL schema (snake_case) exactly — no transformation.
// Row types use Date for timestamptz and string for uuid (pg driver behaviour).

// ---------------------------------------------------------------------------
// app.apps
// ---------------------------------------------------------------------------

export interface AppRow {
  id:               string;
  tenant_id:        string;
  name:             string;
  slug:             string;
  description:      string | null;
  access_mode:      "platform-user" | "public";
  current_build_id: string | null;
  allowed_modules:  string[];
  created_at:       Date;
  updated_at:       Date;
  created_by:       string;
  deleted_at:       Date | null;
}

// ---------------------------------------------------------------------------
// app.files
// ---------------------------------------------------------------------------

export interface AppFileRow {
  id:           string;
  app_id:       string;
  path:         string;
  content:      string;
  content_hash: string;
  file_version: number;
  created_at:   Date;
  updated_at:   Date;
  updated_by:   string;
}

// ---------------------------------------------------------------------------
// app.builds
// ---------------------------------------------------------------------------

export interface BuildRow {
  id:             string;
  app_id:         string;
  version_number: number;
  status:         "pending" | "building" | "success" | "failed";
  bundle_path:    string | null;
  error_message:  string | null;
  error_detail:   Record<string, unknown>[] | null;
  build_manifest: Record<string, unknown> | null;
  built_at:       Date | null;
  built_by:       string;
  created_at:     Date;
}

// ---------------------------------------------------------------------------
// app.env_vars
// ---------------------------------------------------------------------------

export interface EnvVarRow {
  id:         string;
  app_id:     string;
  key:        string;
  value:      string;  // AES-256-GCM encrypted blob
  is_secret:  boolean;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// app.roles
// ---------------------------------------------------------------------------

export interface AppRoleRow {
  id:          string;
  app_id:      string;
  name:        string;
  permissions: RolePermission[];
  created_at:  Date;
  updated_at:  Date;
}

export interface RolePermission {
  entity:  string;
  actions: ("create" | "read" | "update" | "delete" | "admin")[];
}

// ---------------------------------------------------------------------------
// app.tenant_shares
// ---------------------------------------------------------------------------

export interface TenantShareRow {
  id:                 string;
  app_id:             string;
  external_tenant_id: string;
  mapped_roles:       string[];
  created_at:         Date;
  created_by:         string;
}

// ---------------------------------------------------------------------------
// app.oauth_registrations
// ---------------------------------------------------------------------------

export interface OAuthRegistrationRow {
  id:                 string;
  app_id:             string;
  client_id:          string;
  client_secret_hash: string | null;
  access_mode:        "platform-user" | "public";
  registered_at:      Date;
  updated_at:         Date;
}

// ---------------------------------------------------------------------------
// app.user_storage
// ---------------------------------------------------------------------------

export interface UserStorageRow {
  id:         string;
  app_id:     string;
  user_id:    string;
  key:        string;
  value:      unknown;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Input types — create/update operations
// ---------------------------------------------------------------------------

export interface CreateAppData {
  tenant_id:       string;
  name:            string;
  slug:            string;
  description?:    string;
  access_mode:     "platform-user" | "public";
  allowed_modules?: string[];
  created_by:      string;
}

export interface UpdateAppData {
  name?:            string;
  slug?:            string;
  description?:     string | null;
  access_mode?:     "platform-user" | "public";
  allowed_modules?: string[];
  current_build_id?: string | null;
  updated_at?:      Date;
}

export interface CreateFileData {
  app_id:       string;
  path:         string;
  content:      string;
  content_hash: string;
  updated_by:   string;
}

export interface UpdateFileData {
  content:      string;
  content_hash: string;
  updated_by:   string;
  file_version: number;  // current version — the UPDATE checks WHERE file_version = this
}

export interface CreateBuildData {
  app_id:         string;
  version_number: number;
  status:         "pending" | "building" | "success" | "failed";
  built_by:       string;
}

export interface UpdateBuildData {
  status?:        "pending" | "building" | "success" | "failed";
  bundle_path?:   string;
  error_message?: string;
  error_detail?:  Record<string, unknown>[];
  build_manifest?: Record<string, unknown>;
  built_at?:      Date;
}

export interface CreateEnvVarData {
  app_id:    string;
  key:       string;
  value:     string;  // pre-encrypted by service layer
  is_secret: boolean;
}

export interface CreateAppRoleData {
  app_id:      string;
  name:        string;
  permissions: RolePermission[];
}

export interface UpdateAppRoleData {
  name?:        string;
  permissions?: RolePermission[];
}

export interface CreateTenantShareData {
  app_id:             string;
  external_tenant_id: string;
  mapped_roles:       string[];
  created_by:         string;
}

export interface UpsertOAuthRegistrationData {
  app_id:             string;
  client_id:          string;
  access_mode:        "platform-user" | "public";
  client_secret_hash?: string;
}

export interface UpsertUserStorageData {
  app_id:  string;
  user_id: string;
  key:     string;
  value:   unknown;
}
