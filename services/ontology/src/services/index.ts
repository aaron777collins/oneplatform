export { createEntityService } from "./entity-service.js";
export type { EntityService, EntityDetail, FieldDetail, CreateEntityInput, PatchEntityInput } from "./entity-service.js";

export { buildFieldZodValidator, buildEntityZodSchema, buildCreateInputSchema, serializeZodSchema } from "./field-service.js";

export { createRelationshipService } from "./relationship-service.js";
export type { RelationshipService, RelationshipDetail, CreateRelationshipInput } from "./relationship-service.js";

export { createMappingService } from "./mapping-service.js";
export type { MappingService, MapResult } from "./mapping-service.js";

export { classifyChange, createMigrationService, isTypeWiden } from "./migration-service.js";
export type { MigrationService, ChangeClassification, ChangeDescription, EntityDiff } from "./migration-service.js";

export { generateTypeScriptInterface, generateZodSchema, generateRouteDefinition } from "./codegen-service.js";
export type { EntityRouteDefinition } from "./codegen-service.js";

export { createCacheService } from "./cache-service.js";
export type { CacheService, OntologySnapshot, EntitySnapshot } from "./cache-service.js";

export { createInferenceService } from "./inference-service.js";
export type { InferenceService, DataEnvelope } from "./inference-service.js";

export { createCleanupService } from "./cleanup-service.js";
export type { CleanupService } from "./cleanup-service.js";

export * from "./errors.js";
