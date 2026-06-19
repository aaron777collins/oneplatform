/**
 * client.apps namespace — application management.
 *
 * Covers the full surface of the app service: CRUD, builds, deployments,
 * and the virtual file system. Methods mirror the REST API 1:1 so callers
 * do not need to know internal URL patterns.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type { App, CreateAppRequest, UpdateAppRequest } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';
import { serializeListQuery } from './list-query.js';

// ---------------------------------------------------------------------------
// Deployment types
// ---------------------------------------------------------------------------

/**
 * Result returned by uploadAndDeploy() after a successful bundle upload.
 * Shape mirrors the DeployResult type from the app service's deploy-service.ts.
 */
export interface Deployment {
  readonly appId: string;
  readonly buildId: string;
  readonly versionNumber: number;
  readonly deployedAt: string;
  readonly previousBuildId: string | null;
}

/**
 * Result returned by rollback().
 * Shape mirrors the RollbackResult type from the app service's deploy-service.ts.
 */
export interface RollbackResult {
  readonly appId: string;
  /** The build that was active before the rollback. */
  readonly fromBuildId: string;
  /** The build that is now active after the rollback. */
  readonly toBuildId: string;
  readonly rolledBackAt: string;
}

/**
 * Options accepted by rollback().
 * buildId is required — rollback always targets a specific previously-successful build.
 */
export interface RollbackOptions {
  /**
   * The ID of the build to roll back to. Must be a UUID of a build that
   * previously reached 'success' status and still has retained artifacts.
   */
  readonly buildId: string;
}

// ---------------------------------------------------------------------------
// Build types
// ---------------------------------------------------------------------------

export interface AppBuild {
  readonly id: string;
  readonly appId: string;
  readonly status: 'pending' | 'building' | 'success' | 'failed';
  readonly versionNumber: number | null;
  readonly createdAt: string;
  readonly builtAt: string | null;
  readonly errorMessage: string | null;
}

export interface TriggerBuildRequest {
  /** Optional commit SHA or tag that labels this build for traceability. */
  readonly ref?: string;
}

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export interface AppFileSummary {
  readonly id: string;
  readonly appId: string;
  readonly path: string;
  readonly contentHash: string;
  readonly fileVersion: number;
  readonly sizeBytes: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface AppFileDetail extends AppFileSummary {
  readonly content: string;
}

export interface WriteFileRequest {
  readonly content: string;
  /**
   * Optimistic-lock version. Pass 0 to create a new file; pass the current
   * fileVersion for updates. The server rejects mismatches with 409.
   */
  readonly fileVersion: number;
}

// ---------------------------------------------------------------------------
// AppNamespace interface
// ---------------------------------------------------------------------------

/**
 * Namespace for hosted application management.
 *
 * Accessible as `client.apps`. Covers full app lifecycle: CRUD, server-side
 * builds, deployments, and the virtual file system used by in-platform editors.
 */
export interface AppNamespace {
  // Core CRUD
  /** Lists all apps for the tenant. */
  list(options?: ListOptions): PaginatedIterable<App>;
  /** Fetches a single app by ID or slug. */
  get(id: string): Promise<App>;
  /** Creates a new app definition. */
  create(data: CreateAppRequest): Promise<App>;
  /** Updates app metadata (name, description, settings). */
  update(id: string, data: UpdateAppRequest): Promise<App>;
  /** Permanently deletes an app and all its builds. */
  delete(id: string): Promise<void>;

  /**
   * Returns the total number of apps without fetching all items.
   *
   * Issues a single request with `limit=0` and reads the `total` field from
   * the paginated response envelope.
   *
   * @param options - Optional filter/sort to count a subset.
   * @returns The total count, or `null` if the server does not support counting.
   */
  count(options?: ListOptions): Promise<number | null>;

  // Build management
  /** Enqueue a new build for the app's current file set. */
  triggerBuild(id: string, data?: TriggerBuildRequest): Promise<AppBuild>;
  /** Fetch a single build record by build ID. */
  getBuild(id: string, buildId: string): Promise<AppBuild>;
  /** List all builds for an app, newest first. */
  listBuilds(id: string, options?: ListOptions): PaginatedIterable<AppBuild>;
  /**
   * Set the current (deployed) build. The build must be in 'success' status.
   * Equivalent to a deployment/promotion step.
   */
  deploy(id: string, buildId: string): Promise<Deployment>;

  /**
   * Upload a pre-built bundle and trigger an immediate deployment.
   *
   * Use this instead of `deploy()` when you have a local bundle file (produced
   * by `vite build` + `tar -czf`) rather than a build triggered server-side.
   *
   * The bundle must be a .tar.gz archive containing: index.html plus bundled
   * JS/CSS assets. Build with: vite build && tar -czf bundle.tar.gz -C dist .
   *
   * @param id      App ID or slug
   * @param bundle  Pre-built bundle as a Blob or Uint8Array (Node.js Buffer extends Uint8Array)
   * @param opts    Optional deployment options (e.g. env label)
   */
  uploadAndDeploy(
    id: string,
    bundle: Blob | Uint8Array,
    opts?: { env?: string },
  ): Promise<Deployment>;

  /**
   * Roll back an app to a specific previously-successful build.
   *
   * The target build must have status 'success' and its artifacts must still be
   * within the platform's retention window. Use `listBuilds()` to find candidate
   * build IDs before calling this method.
   *
   * @param appId   App ID or slug
   * @param options Options containing the `buildId` to roll back to
   */
  rollback(appId: string, options: RollbackOptions): Promise<RollbackResult>;

  // Virtual file system
  listFiles(id: string): Promise<AppFileSummary[]>;
  getFile(id: string, filePath: string): Promise<AppFileDetail>;
  /** Create or update a file using optimistic locking. */
  writeFile(id: string, filePath: string, data: WriteFileRequest): Promise<AppFileSummary>;
  deleteFile(id: string, filePath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppNamespace(transport: Transport): AppNamespace {
  const BASE = '/api/v1/apps';

  return {
    // ── Core CRUD ────────────────────────────────────────────────────────────

    list(options?: ListOptions): PaginatedIterable<App> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<App>(async (cursor, limit) => {
        const result = await transport.request<{
          items: App[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: BASE,
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },

    async count(options?: ListOptions): Promise<number | null> {
      const baseQuery = serializeListQuery(options);
      const result = await transport.request<{
        items: App[];
        nextCursor: string | null;
        total: number | null;
      }>({
        method: 'GET',
        path: BASE,
        query: {
          ...baseQuery,
          limit: 0,
        },
      });
      return result.total;
    },

    async get(id: string): Promise<App> {
      return transport.request<App>({ method: 'GET', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async create(data: CreateAppRequest): Promise<App> {
      return transport.request<App>({ method: 'POST', path: BASE, body: data });
    },

    async update(id: string, data: UpdateAppRequest): Promise<App> {
      return transport.request<App>({
        method: 'PATCH',
        path: `${BASE}/${encodeURIComponent(id)}`,
        body: data,
      });
    },

    async delete(id: string): Promise<void> {
      await transport.request<void>({ method: 'DELETE', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    // ── Build management ─────────────────────────────────────────────────────

    async triggerBuild(id: string, data?: TriggerBuildRequest): Promise<AppBuild> {
      return transport.request<AppBuild>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/builds`,
        body: data ?? {},
      });
    },

    async getBuild(id: string, buildId: string): Promise<AppBuild> {
      return transport.request<AppBuild>({
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(id)}/builds/${encodeURIComponent(buildId)}`,
      });
    },

    listBuilds(id: string, options?: ListOptions): PaginatedIterable<AppBuild> {
      const pageSize = options?.limit ?? 20;
      const baseQuery = serializeListQuery(options);
      return new Paginator<AppBuild>(async (cursor, limit) => {
        const result = await transport.request<{
          items: AppBuild[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: `${BASE}/${encodeURIComponent(id)}/builds`,
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },

    async deploy(id: string, buildId: string): Promise<Deployment> {
      // POST to the deploy endpoint to promote a successful build to production.
      return transport.request<Deployment>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/deploy`,
        body: { buildId },
      });
    },

    async rollback(appId: string, options: RollbackOptions): Promise<RollbackResult> {
      // POST /api/v1/apps/:appId/rollback — the buildId is required by the server's
      // RollbackSchema, so we send it unconditionally rather than filtering undefined.
      return transport.request<RollbackResult>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(appId)}/rollback`,
        body: { buildId: options.buildId },
      });
    },

    async uploadAndDeploy(
      id: string,
      bundle: Blob | Uint8Array,
      opts: { env?: string } = {},
    ): Promise<Deployment> {
      // Normalise Uint8Array (which Node's Buffer extends) → Blob so that
      // FormData.append() receives a Blob in both Node 18+ and browser environments.
      // We copy the bytes into a fresh ArrayBuffer via Uint8Array.from() to satisfy
      // TypeScript's strict BlobPart constraint — ArrayBufferLike (which includes
      // SharedArrayBuffer) is not accepted by new Blob(), but a plain ArrayBuffer is.
      // The filename "bundle.tar.gz" hints to the server for content inspection;
      // octet-stream avoids any browser-side content sniffing.
      const blob =
        bundle instanceof Uint8Array
          ? new Blob([Uint8Array.from(bundle)], { type: 'application/octet-stream' })
          : bundle;

      const form = new FormData();
      form.append('bundle', blob, 'bundle.tar.gz');
      if (opts.env !== undefined) form.append('env', opts.env);

      return transport.requestMultipart<Deployment>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/deploy/upload`,
        body: form,
      });
    },

    // ── Virtual file system ──────────────────────────────────────────────────

    async listFiles(id: string): Promise<AppFileSummary[]> {
      // Transport unwraps the { data } envelope, so we receive AppFileSummary[] directly.
      return transport.request<AppFileSummary[]>({
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(id)}/files`,
      });
    },

    async getFile(id: string, filePath: string): Promise<AppFileDetail> {
      // The path segment already contains slashes; encode each part individually
      // to preserve directory separators while still escaping special characters.
      const encodedPath = filePath.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
      return transport.request<AppFileDetail>({
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(id)}/files/${encodedPath}`,
      });
    },

    async writeFile(id: string, filePath: string, data: WriteFileRequest): Promise<AppFileSummary> {
      const encodedPath = filePath.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
      return transport.request<AppFileSummary>({
        method: 'PUT',
        path: `${BASE}/${encodeURIComponent(id)}/files/${encodedPath}`,
        body: data,
      });
    },

    async deleteFile(id: string, filePath: string): Promise<void> {
      const encodedPath = filePath.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
      await transport.request<void>({
        method: 'DELETE',
        path: `${BASE}/${encodeURIComponent(id)}/files/${encodedPath}`,
      });
    },
  };
}
