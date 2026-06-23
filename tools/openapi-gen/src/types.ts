/**
 * Type definitions for the OpenAPI generation system.
 *
 * These types are the contract between per-service openapi-meta.ts files and
 * the generator tool. Services import ServiceOpenApiMeta and RouteMeta from
 * this module to declare their route-to-schema mappings.
 *
 * WHY a separate meta file instead of extracting from route handlers:
 *   The services use manual safeParse() — the relationship between a route path,
 *   its HTTP method, and which Zod schema applies is implicit in the handler.
 *   An AST-based extractor would be fragile. The explicit meta file is the
 *   contract that survives refactoring.
 */

import type { ZodTypeAny } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteBodyMeta {
  schema: ZodTypeAny;
  contentType: "application/json" | "multipart/form-data";
  /** Defaults to true when not specified. */
  required?: boolean;
}

export interface RouteQueryMeta {
  /** A Zod object schema whose keys become query parameters. */
  schema: ZodTypeAny;
}

export interface RouteParamMeta {
  /** Key is the param name matching :paramName in the path. */
  [paramName: string]: ZodTypeAny;
}

export interface RouteResponseMeta {
  /** Key is the HTTP status code. Value MUST have .describe("UniqueName") applied. */
  [statusCode: number]: ZodTypeAny;
}

export interface RouteMeta {
  method: HttpMethod;
  /** Full path including API prefix, e.g. "/api/v1/auth/login". */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  /**
   * Security requirements. Empty array means public (no auth).
   * Undefined means default Bearer JWT auth applies.
   */
  security?: Array<Record<string, string[]>>;
  body?: RouteBodyMeta;
  query?: RouteQueryMeta;
  params?: RouteParamMeta;
  /** Each response schema MUST call .describe("UniquePascalCaseName"). */
  response: RouteResponseMeta;
  deprecated?: boolean;
  deprecationMessage?: string;
  /**
   * Content-type for successful (2xx) responses.
   * Defaults to "application/json". Use "text/event-stream" for SSE endpoints
   * so the generated spec correctly documents the streaming response.
   */
  responseContentType?: string;
}

export interface ServiceOpenApiMeta {
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers?: Array<{ url: string; description: string }>;
  tags?: Array<{ name: string; description: string }>;
  routes: RouteMeta[];
}
