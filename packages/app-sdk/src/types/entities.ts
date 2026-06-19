/**
 * Generic entity and query types used across the public API surface.
 *
 * These types are generic-first so that app developers can substitute
 * their own entity shapes (e.g. useQuery<Customer>) for full type safety.
 * The SDK itself ships with T = unknown as the default — type safety is
 * additive through the declaration injection mechanism described in the spec.
 */

// ─── Filter system ────────────────────────────────────────────────────────────

export type FilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "nin"
  | "contains";

export type FilterValue = string | number | boolean | string[] | number[];

export type FilterSpec = {
  [field: string]: Partial<Record<FilterOperator, FilterValue>>;
};

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface Pagination {
  nextCursor: string | null;
  total: number;
}

// ─── Query options and result ─────────────────────────────────────────────────

export interface QueryOptions {
  filter?: FilterSpec;
  /** Prefix with "-" for descending order, e.g. ["-createdAt", "name"] */
  sort?: string[];
  /** Field projection. Omit for all fields. */
  fields?: string[];
  /** Pagination cursor. Omit for the first page. */
  cursor?: string;
  /** Default 50, max 100 */
  limit?: number;
  /** When false, skip the fetch entirely. Default true. */
  enabled?: boolean;
  /** Milliseconds before a cache entry is considered stale. Default 30_000. */
  staleTime?: number;
  onError?: (error: AppSDKError) => void;
}

export interface QueryResult<T> {
  data: T[] | null;
  pagination: Pagination | null;
  isLoading: boolean;
  isError: boolean;
  error: AppSDKError | null;
  refetch: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
}

// ─── Mutation result ──────────────────────────────────────────────────────────

export interface BulkResult<T> {
  created: T[];
  errors: Array<{ index: number; error: AppSDKError }>;
}

export interface MutationResult<T> {
  create: (data: Partial<T>) => Promise<T>;
  /** PATCH — partial update */
  update: (id: string, data: Partial<T>) => Promise<T>;
  /** PUT — full replacement */
  replace: (id: string, data: T) => Promise<T>;
  remove: (id: string) => Promise<void>;
  bulkCreate: (items: Partial<T>[]) => Promise<BulkResult<T>>;
  isLoading: boolean;
  isError: boolean;
  error: AppSDKError | null;
  /** Clears isError and error state */
  reset: () => void;
}

// ─── Subscription types ───────────────────────────────────────────────────────

export type EntityEventType = "created" | "updated" | "deleted";

export interface EntityEvent<T> {
  type: EntityEventType;
  entity: string;
  id: string;
  data: T;
  /** ISO 8601 */
  timestamp: string;
  tenantId: string;
}

export interface SubscriptionOptions {
  filter?: FilterSpec;
  /** Default: all three event types */
  events?: EntityEventType[];
  onEvent?: (event: EntityEvent<unknown>) => void;
  /**
   * When true (default), mutation events (created / updated / deleted) cause
   * the QueryCache to invalidate all entries for the subscribed entity. This
   * triggers a fresh fetch in any mounted useQuery for that entity.
   *
   * Set to false to manage cache invalidation manually (e.g. when applying
   * optimistic updates via useMutation and a WebSocket event would cause a
   * redundant refetch).
   */
  autoInvalidate?: boolean;
}

export interface SubscriptionResult<T> {
  lastEvent: EntityEvent<T> | null;
  isConnected: boolean;
  reconnectAttempts: number;
}

// ─── User context ─────────────────────────────────────────────────────────────

export interface UserContext {
  id: string;
  /** null for guest sessions */
  email: string | null;
  displayName: string;
  tenantId: string;
  roles: string[];
  isGuest: boolean;
  /**
   * true once the BFF /me response has been received and the user context
   * has been populated. When false, other fields contain sentinel/default
   * values and should not be used for business logic.
   */
  isLoaded: boolean;
}

// ─── Permission types ─────────────────────────────────────────────────────────

export type PermissionAction = "create" | "read" | "update" | "delete" | "admin";

// ─── Error type ───────────────────────────────────────────────────────────────

export interface AppSDKError {
  /** e.g. "PERMISSION_DENIED", "ENTITY_NOT_FOUND", "NETWORK_ERROR" */
  code: string;
  message: string;
  /** HTTP status code; 0 for network or client-side errors */
  statusCode: number;
  /** true for 429, 503, and NETWORK_ERROR — signals the caller may retry */
  isRetryable: boolean;
  /** X-Request-ID from the BFF response; empty string for network errors */
  requestId: string;
}
