/**
 * @module client
 *
 * createClient() — the single entry point for SDK consumers.
 *
 * Construction is synchronous and performs no I/O. Connection errors surface
 * on the first API call. Multiple independent client instances can coexist in
 * the same process (zero global state).
 *
 * Auth mode selection order:
 *   1. apiKey provided → API key mode (rejected in browser environments)
 *   2. accessToken provided → access token mode
 *   3. browser config provided → PKCE mode
 *   4. nothing provided + browser detected → PKCE mode (must supply clientId via runtime)
 *   5. nothing provided + Node.js detected → ConfigurationError
 */

import type { ClientOptions, ResolvedClientConfig } from './types/client-options.js';
import type { AuthHandler } from './auth/api-key.js';
import type { WhoAmIResponse } from './resources/platform-types.js';
import { ConfigurationError } from './errors/client-errors.js';
import { createApiKeyHandler } from './auth/api-key.js';
import { createAccessTokenHandler } from './auth/access-token.js';
import { createPkceHandler } from './auth/pkce.js';
import { Transport } from './transport.js';
import { createDataNamespace } from './resources/data.js';
import { createPipelineNamespace } from './resources/pipelines.js';
import { createConnectorNamespace } from './resources/connectors.js';
import { createOntologyNamespace } from './resources/ontologies.js';
import { createEventNamespace } from './resources/events.js';
import { createAppNamespace } from './resources/apps.js';
import { createPluginNamespace } from './resources/plugins.js';
import { createApiKeyNamespace } from './resources/api-keys.js';
import { createUserNamespace } from './resources/users.js';
import { createLogNamespace } from './resources/logs.js';
import type { DataNamespace } from './resources/data.js';
import type { PipelineNamespace } from './resources/pipelines.js';
import type { ConnectorNamespace } from './resources/connectors.js';
import type { OntologyNamespace } from './resources/ontologies.js';
import type { EventNamespace } from './resources/events.js';
import type { AppNamespace } from './resources/apps.js';
import type { PluginNamespace } from './resources/plugins.js';
import type { ApiKeyNamespace } from './resources/api-keys.js';
import type { UserNamespace } from './resources/users.js';
import type { LogNamespace } from './resources/logs.js';
import type { Subscription } from './types/subscription.js';

function isBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { document?: unknown }).document !== 'undefined' &&
    typeof (window as { sessionStorage?: unknown }).sessionStorage !== 'undefined'
  );
}

/**
 * The fully-initialised OnePlatform API client.
 *
 * Obtain an instance via {@link createClient}. Each namespace corresponds to a
 * top-level resource group in the REST API (e.g. `client.apps` maps to
 * `GET /api/v1/apps`).
 */
export interface OnePlatformClient {
  /**
   * Ontology-typed entity CRUD.
   *
   * Access a resource with `client.data.entity('Product')` or, with generated
   * typed clients, `client.data.Product`.
   */
  readonly data: DataNamespace;

  /** Pipeline management — create, trigger, and monitor runs. */
  readonly pipelines: PipelineNamespace;

  /** Connector lifecycle management — register, test, and trigger syncs. */
  readonly connectors: ConnectorNamespace;

  /** Ontology schema management — define, validate, and migrate schemas. */
  readonly ontologies: OntologyNamespace;

  /** Real-time entity event subscriptions via Server-Sent Events. */
  readonly events: EventNamespace;

  /** Application management — CRUD, build, and deploy hosted apps. */
  readonly apps: AppNamespace;

  /** Plugin lifecycle management — install and configure plugins. */
  readonly plugins: PluginNamespace;

  /** API key management — create and revoke API keys. */
  readonly apiKeys: ApiKeyNamespace;

  /** User management (admin-only) — provision and update user accounts. */
  readonly users: UserNamespace;

  /** Log and audit trail queries — stream logs and fetch audit entries. */
  readonly logs: LogNamespace;

  /**
   * Returns the resolved options this client was constructed with.
   * Auth tokens are redacted from the returned object.
   */
  getConfig(): Readonly<ResolvedClientConfig>;

  /**
   * Verifies connectivity and authentication.
   *
   * Calls `GET /api/v1/auth/whoami` and resolves with the current user
   * identity, or throws an {@link AuthError} if the credentials are invalid.
   */
  ping(): Promise<WhoAmIResponse>;

  /**
   * Terminates all active SSE subscriptions and aborts in-flight requests.
   *
   * The client must not be reused after calling `destroy()`. Create a new
   * client instance if you need to make further requests.
   */
  destroy(): void;
}

/**
 * Creates a new OnePlatform API client.
 *
 * Construction is synchronous and performs no I/O — connection errors surface
 * on the first API call. Multiple independent client instances can coexist in
 * the same process (zero global state).
 *
 * @param options - Client configuration including `baseUrl` and `auth`.
 * @returns A fully-initialised {@link OnePlatformClient}.
 * @throws {@link ConfigurationError} when required options are missing or invalid.
 *
 * @example Node.js with API key
 * ```ts
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   auth: { apiKey: 'op_live_...' },
 * });
 * ```
 *
 * @example Browser with PKCE
 * ```ts
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   auth: { browser: { clientId: 'my-app' } },
 * });
 * ```
 */
export function createClient(options: ClientOptions): OnePlatformClient {
  // --- Validate and normalise baseUrl ---
  if (!options.baseUrl || options.baseUrl.trim() === '') {
    throw new ConfigurationError('ClientOptions.baseUrl is required and must not be empty.');
  }
  // Silently strip trailing slashes so callers don't have to be careful about
  // whether they include one. All internal path concatenation assumes no trailing slash.
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  const isBrowser = isBrowserEnvironment();

  // --- Select auth mode ---
  let authHandler: AuthHandler;
  let authMode: ResolvedClientConfig['authMode'];

  const auth = options.auth;

  if (auth !== undefined) {
    if ('apiKey' in auth) {
      // API key is rejected in browser environments — permanent security invariant
      if (isBrowser) {
        throw new ConfigurationError(
          'API keys are not permitted in browser environments. Use browser PKCE auth instead.',
        );
      }
      authHandler = createApiKeyHandler(auth.apiKey);
      authMode = 'api-key';
    } else if ('accessToken' in auth) {
      authHandler = createAccessTokenHandler(auth);
      authMode = 'access-token';
    } else if ('browser' in auth) {
      if (!isBrowser) {
        throw new ConfigurationError(
          'BrowserAuthConfig (PKCE) can only be used in browser environments.',
        );
      }
      authHandler = createPkceHandler(auth.browser, baseUrl);
      authMode = 'browser';
    } else {
      throw new ConfigurationError(
        'ClientOptions.auth must specify one of: apiKey, accessToken, or browser.',
      );
    }
  } else {
    // Auto-detect environment
    if (isBrowser) {
      throw new ConfigurationError(
        'auth is required when using browser auto-detection. ' +
          'Provide auth: { browser: { clientId: "..." } } explicitly.',
      );
    } else {
      throw new ConfigurationError(
        'auth is required in non-browser environments. ' +
          'Provide auth: { apiKey: "op_live_..." } or auth: { accessToken: "..." }.',
      );
    }
  }

  const timeout = options.timeout ?? 30_000;
  const logLevel = options.logLevel ?? 'warn';
  const retry = options.retry ?? {};
  const customHeaders = options.headers ?? {};
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (fetchImpl === undefined) {
    throw new ConfigurationError(
      'fetch is not available in this environment. ' +
        'Provide a fetch implementation via ClientOptions.fetch, or upgrade to Node.js 18+.',
    );
  }

  const transport = new Transport({
    baseUrl,
    authHandler,
    retry,
    timeout,
    customHeaders,
    logLevel,
    fetch: fetchImpl,
    isBrowser,
  });

  const resolvedConfig: ResolvedClientConfig = {
    baseUrl,
    timeout,
    logLevel,
    retry,
    authMode,
  };

  // Track active SSE subscriptions for cleanup on destroy()
  const activeSubscriptions = new Set<Subscription>();

  // Wrap the event namespace to track subscriptions
  const rawEventNamespace = createEventNamespace(
    transport,
    authHandler,
    fetchImpl,
    isBrowser,
  );

  const eventsNamespace: EventNamespace = {
    subscribe: (...args) => {
      const sub = rawEventNamespace.subscribe(...args);
      activeSubscriptions.add(sub);
      // Remove from tracking when the subscription closes itself
      const originalUnsubscribe = sub.unsubscribe.bind(sub);
      const wrapped = sub as { unsubscribe: () => void };
      wrapped.unsubscribe = () => {
        activeSubscriptions.delete(sub);
        originalUnsubscribe();
      };
      // Also monitor for auto-close (e.g. max reconnects exhausted) so the
      // subscription is removed from the set even if the user never calls
      // unsubscribe(). Listen for the 'closed' status transition.
      sub.on('status', (status) => {
        if (status === 'closed') {
          activeSubscriptions.delete(sub);
        }
      });
      return sub;
    },
  };

  const client: OnePlatformClient = {
    data: createDataNamespace(transport),
    pipelines: createPipelineNamespace(transport),
    connectors: createConnectorNamespace(transport),
    ontologies: createOntologyNamespace(transport),
    events: eventsNamespace,
    apps: createAppNamespace(transport),
    plugins: createPluginNamespace(transport),
    apiKeys: createApiKeyNamespace(transport),
    users: createUserNamespace(transport),
    logs: createLogNamespace(transport),

    getConfig(): Readonly<ResolvedClientConfig> {
      return resolvedConfig;
    },

    async ping(): Promise<WhoAmIResponse> {
      return transport.request<WhoAmIResponse>({
        method: 'GET',
        path: '/api/v1/auth/whoami',
      });
    },

    destroy(): void {
      for (const sub of activeSubscriptions) {
        try {
          sub.unsubscribe();
        } catch {
          // Ensure all subscriptions are cleaned up even if one throws
        }
      }
      activeSubscriptions.clear();
      // Abort all in-flight HTTP requests tracked by the transport
      transport.destroy();
    },
  };

  return client;
}
