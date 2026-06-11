/**
 * @oneplatform/plugin-sdk — root export
 *
 * Types-only re-export. Plugin source code imports from this path.
 *
 * CONSTRAINT: This file must never import Zod, Node.js builtins, or any
 * runtime library. The only permitted runtime code is the PluginError class
 * hierarchy from ./types/errors.ts. All other exports are TypeScript
 * interface/type declarations that emit zero JavaScript.
 */

// Primitive data types
export type { JSONSchema, DataRecord, MappedRecord } from "./types/primitives.js";

// Context and all sub-interfaces
export type {
  PluginContext,
  CredentialAccessor,
  FetchProxy,
  CacheAccessor,
  LockHandle,
  PluginLogger,
  TenantContext,
  OntologyAccessor,
  OntologySchema,
  EntitySchema,
  EntityField,
  TracingContext,
  SpanHandle,
} from "./types/context.js";

// Error classes (runtime code — the only runtime exports from this path)
export {
  PluginError,
  PluginAuthError,
  PluginRateLimitError,
  PluginTimeoutError,
  PluginDataError,
  PluginConfigError,
} from "./types/errors.js";

// Metadata types
export type {
  BaseMetadata,
  ConnectorMetadata,
  TransformerMetadata,
  DestinationMetadata,
  AuthProviderMetadata,
  WidgetMetadata,
  AnyPluginMetadata,
} from "./types/metadata.js";

// Hook types
export type { HookStage, HookDeclaration, HookPayload, HookResult } from "./types/hooks.js";

// Connector interface
export type {
  ConnectorHandle,
  BatchResult,
  EventCallback,
  Subscription,
  Connector,
} from "./types/connector.js";

// Transformer interface
export type { TransformerContext, Transformer } from "./types/transformer.js";

// Destination interface
export type { WriteResult, DestinationContext, Destination } from "./types/destination.js";

// AuthProvider interface
export type {
  AuthOptions,
  CallbackParams,
  AuthContext,
  AuthResult,
  TokenValidation,
  TokenPair,
  AuthProvider,
} from "./types/auth-provider.js";

// Widget interface
export type {
  WidgetSlot,
  WidgetSlotDeclaration,
  DataQuery,
  WidgetData,
  Widget,
} from "./types/widget.js";
