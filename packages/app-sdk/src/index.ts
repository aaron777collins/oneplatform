/**
 * @packageDocumentation
 * @oneplatform/app-sdk — React hooks and context for OnePlatform hosted apps.
 *
 * ## Quick start
 * ```tsx
 * import { AppProvider, useQuery, useMutation } from '@oneplatform/app-sdk';
 *
 * function Root() {
 *   return (
 *     <AppProvider>
 *       <ProductList />
 *     </AppProvider>
 *   );
 * }
 *
 * function ProductList() {
 *   const { data, isLoading } = useQuery('Product');
 *   if (isLoading) return <div>Loading...</div>;
 *   return <ul>{data?.map(p => <li key={p.id}>{p.name}</li>)}</ul>;
 * }
 * ```
 *
 * Only the seven public exports and their associated types are re-exported here.
 * Internal modules (client/, cache/, ws/) are not accessible from package consumers.
 * Any attempt to import @oneplatform/app-sdk/client/BffClient will fail at the
 * esbuild enforcement layer in the sandbox build.
 */

export { AppProvider } from "./provider/AppProvider.js";
export {
  BrandingProvider,
  BrandLogo,
  useBranding,
  applyBranding,
  BrandingContext,
} from "./providers/BrandingProvider.js";
export { useQuery } from "./hooks/useQuery.js";
export { useMutation } from "./hooks/useMutation.js";
export { useSubscription } from "./hooks/useSubscription.js";
export { useUser } from "./hooks/useUser.js";
export { usePermission } from "./hooks/usePermission.js";
export { useAppStorage } from "./hooks/useAppStorage.js";

export type {
  TenantBrandingConfig,
  BrandingContextValue,
} from "./providers/branding-types.js";

export type {
  // Query
  QueryOptions,
  QueryResult,
  FilterSpec,
  FilterValue,
  FilterOperator,
  Pagination,
  // Mutation
  MutationResult,
  BulkResult,
  // Subscription
  SubscriptionOptions,
  SubscriptionResult,
  EntityEvent,
  EntityEventType,
  // User
  UserContext,
  // Permissions
  PermissionAction,
  // Error
  AppSDKError,
} from "./types/index.js";
