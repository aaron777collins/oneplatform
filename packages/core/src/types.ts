export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    total: number | null;
  };
}

export interface UserContext {
  userId: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
  isGuest: boolean;
  isService: boolean;
  emailVerified: boolean;
}

export interface PlatformEvent {
  eventId: string;
  eventType: string;
  eventVersion: string;
  tenantId: string;
  timestamp: string;
  actor: {
    type: "user" | "service" | "system";
    id: string;
    displayName?: string;
  };
  data: Record<string, unknown>;
}

export interface DataEnvelope {
  _id: string;
  _source: string;
  _ingestedAt: string;
  _connectorId: string;
  _batchId: string;
  _tenantId: string;
  _syncMode: "full" | "incremental";
  _cursor: string | null;
  data: Record<string, unknown>;
}

export enum ServiceName {
  Gateway = "gateway-service",
  Auth = "auth-service",
  Ingestion = "ingestion-service",
  Ontology = "ontology-service",
  Pipeline = "pipeline-service",
  Execution = "execution-service",
  App = "app-service",
  Logging = "logging-service",
  Plugin = "plugin-service",
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  policy: "global" | "per-tenant" | "per-api-key" | "webhook";
}

export interface DeprecationInfo {
  sunset: Date;
  successorUrl: string;
}

export type AppVariables = {
  user: UserContext;
  requestId: string;
  rateLimitInfo?: RateLimitInfo;
  deprecationInfo?: DeprecationInfo;
};
