/**
 * Public type re-exports.
 *
 * This barrel surfaces only the types that are part of the public API.
 * Internal types (wire protocol, cache shapes) are not re-exported here.
 */

export type {
  FilterOperator,
  FilterValue,
  FilterSpec,
  QueryOptions,
  QueryResult,
  BulkResult,
  MutationResult,
  EntityEventType,
  EntityEvent,
  SubscriptionOptions,
  SubscriptionResult,
  UserContext,
  PermissionAction,
  AppSDKError,
  Pagination,
} from "./entities.js";
