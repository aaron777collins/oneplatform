/**
 * BFF request/response shapes.
 *
 * These types mirror the wire format of the App Service BFF endpoints.
 * They are intentionally kept separate from public-facing entity types so
 * that BFF contract changes do not automatically become breaking API changes
 * for app developers.
 */

import type { Pagination, FilterOperator, FilterSpec } from "./entities.js";

// ─── Query parameters passed to /bff/data/{entity} ───────────────────────────

export interface BffQueryParams {
  filter?: FilterSpec;
  sort?: string[];
  fields?: string[];
  cursor?: string;
  limit?: number;
}

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface BffDataResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface BffMeResponse {
  id: string;
  email: string | null;
  displayName: string;
  tenantId: string;
  roles: string[];
  isGuest: boolean;
}

/**
 * Wire format from GET /bff/permissions.
 *
 * The BFF returns entity → [action, ...] map (e.g. { "invoice": ["read", "write"] }).
 * PermissionCache.applySnapshot() expands this into the flat "action:resource" key space
 * it uses internally, setting all listed entries to allowed=true.
 */
export interface BffPermissionsResponse {
  data: {
    appId: string;
    permissions: Record<string, string[]>;
  };
}

export interface BffStorageGetResponse {
  key: string;
  value: unknown;
  updatedAt?: string;
}

export interface BffStoragePutResponse {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface BffBulkCreateResponse<T> {
  created: T[];
  errors: Array<{ index: number; error: { code: string; message: string } }>;
}

// ─── Re-export FilterOperator so BffClient can use it ────────────────────────
export type { FilterOperator };
