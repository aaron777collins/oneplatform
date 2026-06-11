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

export interface PermissionEntry {
  action: string;
  resource: string;
  allowed: boolean;
}

export interface BffPermissionsResponse {
  permissions: PermissionEntry[];
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
