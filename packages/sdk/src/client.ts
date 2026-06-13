/**
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

export interface OnePlatformClient {
  /** Ontology-typed entity CRUD. Access as client.data.entity('Product') or client.data.Product */
  readonly data: DataNamespace;

  /** Pipeline management — create, trigger, monitor runs. */
  readonly pipelines: PipelineNamespace;

  /** Connector lifecycle management. */
  readonly connectors: ConnectorNamespace;

  /** Ontology schema management. */
  readonly ontologies: OntologyNamespace;

  /** Real-time event subscriptions via SSE. */
  readonly events: EventNamespace;

  /** Application management. */
  readonly apps: AppNamespace;

  /** Plugin lifecycle management. */
  readonly plugins: PluginNamespace;

  /** API key management. */
  readonly apiKeys: ApiKeyNamespace;

  /** User management (admin-only operations). */
  readonly users: UserNamespace;

  /** Log and audit trail queries. */
  readonly logs: LogNamespace;

  /**
   * Returns the resolved options this client was constructed with.
   * Auth tokens are redacted.
   */
  getConfig(): Readonly<ResolvedClientConfig>;

  /**
   * Verifies connectivity and authentication by calling GET /api/v1/auth/whoami.
   * Resolves with the current user identity or throws an error.
   */
  ping(): Promise<WhoAmIResponse>;

  /**
   * Terminates all active SSE subscriptions and in-flight requests.
   * The client must not be reused after calling destroy().
   */
  destroy(): void;
}

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
        sub.unsubscribe();
      }
      activeSubscriptions.clear();
    },
  };

  return client;
}
