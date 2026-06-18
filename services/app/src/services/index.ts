export { createAppService } from "./app-service.js";
export type { AppService, CreateAppInput, UpdateAppInput, ListAppsOptions } from "./app-service.js";
export { validateFilePath, sha256hex } from "./app-service.js";

export { createBuildService } from "./build-service.js";
export type { BuildService, BuildManifest, EsbuildError } from "./build-service.js";

export { createDeployService } from "./deploy-service.js";
export type { DeployService, DeployResult, RollbackResult } from "./deploy-service.js";

export { createPermissionService } from "./permission-service.js";
export type {
  PermissionService,
  CreateRoleInput,
  UpdateRoleInput,
  ShareInput,
  EnvVarInput,
  EnvVarResponse,
} from "./permission-service.js";

export { createWidgetService } from "./widget-service.js";
export type { WidgetService, WidgetDescriptor, RegisterWidgetInput } from "./widget-service.js";

export { createEmbedService, isOriginAllowed, generateEmbedSnippet } from "./embed-service.js";
export type {
  EmbedService,
  EmbedOptions,
  EmbedConfig,
  EmbedTokenPayload,
  EmbedServiceDeps,
  GenerateEmbedTokenResult,
} from "./embed-service.js";

export { createAppVersionService } from "./app-version-service.js";
export type {
  AppVersionService,
  ListVersionsInput,
  ListVersionsResult,
  RestoreResult,
  AppVersionServiceDeps,
} from "./app-version-service.js";

export { computeDiff, diffFile } from "./diff-service.js";
export type { SnapshotDiff, FileDiff, DiffHunk, LineDiff, DiffOperation } from "./diff-service.js";

export * from "./errors.js";
