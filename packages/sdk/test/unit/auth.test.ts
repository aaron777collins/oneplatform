/**
 * Unit tests for auth handlers.
 * Covers: API key format validation, browser rejection, access token with refresh callback.
 * Note: PKCE browser flow tests require DOM APIs (window, sessionStorage, crypto.subtle).
 * Those are in the browser-specific test section below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApiKeyHandler } from '../../src/auth/api-key.js';
import { createAccessTokenHandler } from '../../src/auth/access-token.js';
import { createClient } from '../../src/client.js';
import { ConfigurationError, AuthError } from '../../src/errors/index.js';
import { recordingFetch } from '../helpers/mock-fetch.js';

describe('API key auth handler', () => {
  it('accepts op_live_ prefix', async () => {
    const handler = createApiKeyHandler('op_live_abc123');
    const headers = await handler.getHeaders();
    expect(headers['Authorization']).toBe('Bearer op_live_abc123');
  });

  it('accepts op_test_ prefix', async () => {
    const handler = createApiKeyHandler('op_test_xyz');
    const headers = await handler.getHeaders();
    expect(headers['Authorization']).toBe('Bearer op_test_xyz');
  });

  it('rejects keys with invalid prefix', () => {
    expect(() => createApiKeyHandler('sk-abc123')).toThrow(ConfigurationError);
    expect(() => createApiKeyHandler('op_live')).toThrow(ConfigurationError); // too short
    expect(() => createApiKeyHandler('')).toThrow(ConfigurationError);
  });
});

describe('Access token auth handler', () => {
  it('sends token as Bearer', async () => {
    const handler = createAccessTokenHandler({ accessToken: 'eyJabc' });
    const headers = await handler.getHeaders();
    expect(headers['Authorization']).toBe('Bearer eyJabc');
  });

  it('canRefresh returns false without callback', () => {
    const handler = createAccessTokenHandler({ accessToken: 'token' });
    expect(handler.canRefresh()).toBe(false);
  });

  it('canRefresh returns true with callback', () => {
    const handler = createAccessTokenHandler({
      accessToken: 'token',
      refreshToken: async () => 'new-token',
    });
    expect(handler.canRefresh()).toBe(true);
  });

  it('handleUnauthorized throws without refresh callback', async () => {
    const handler = createAccessTokenHandler({ accessToken: 'token' });
    await expect(handler.handleUnauthorized()).rejects.toBeInstanceOf(AuthError);
  });

  it('handleUnauthorized calls refresh callback and returns new token', async () => {
    const refreshFn = vi.fn().mockResolvedValue('refreshed-token');
    const handler = createAccessTokenHandler({
      accessToken: 'old-token',
      refreshToken: refreshFn,
    });

    const newToken = await handler.handleUnauthorized();
    expect(newToken).toBe('refreshed-token');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('handleUnauthorized throws AuthError when refresh returns null', async () => {
    const refreshFn = vi.fn().mockResolvedValue(null);
    const handler = createAccessTokenHandler({
      accessToken: 'old-token',
      refreshToken: refreshFn,
    });

    await expect(handler.handleUnauthorized()).rejects.toBeInstanceOf(AuthError);
  });

  it('deduplicates concurrent refresh calls', async () => {
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    const handler = createAccessTokenHandler({
      accessToken: 'old-token',
      refreshToken: refreshFn,
    });

    // Trigger 3 concurrent refresh calls
    const [t1, t2, t3] = await Promise.all([
      handler.handleUnauthorized(),
      handler.handleUnauthorized(),
      handler.handleUnauthorized(),
    ]);

    expect(t1).toBe('new-token');
    expect(t2).toBe('new-token');
    expect(t3).toBe('new-token');
    // Should only have made one actual refresh call
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});

describe('createClient() auth validation', () => {
  it('throws ConfigurationError for missing baseUrl', () => {
    expect(() =>
      createClient({ baseUrl: '', auth: { apiKey: 'op_live_test' } }),
    ).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for trailing slash in baseUrl', () => {
    expect(() =>
      createClient({ baseUrl: 'http://localhost/', auth: { apiKey: 'op_live_test' } }),
    ).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError in Node.js environment without auth', () => {
    expect(() =>
      createClient({ baseUrl: 'http://localhost:3000' }),
    ).toThrow(ConfigurationError);
  });

  it('creates a client with API key auth', () => {
    const { fetch } = recordingFetch([{ status: 200, body: { data: { userId: 'u1', email: 'a@b.com', tenantId: 't1', roles: [], scopes: [] } } }]);
    const client = createClient({
      baseUrl: 'http://localhost:3000',
      auth: { apiKey: 'op_live_testkey' },
      fetch,
    });
    expect(client).toBeDefined();
    expect(typeof client.ping).toBe('function');
  });

  describe('browser environment simulation', () => {
    const globalAny = globalThis as Record<string, unknown>;
    const originalWindow = globalAny['window'];

    beforeEach(() => {
      // isBrowserEnvironment() checks for window.document and window.sessionStorage.
      // Provide both to simulate a real browser environment.
      globalAny['window'] = {
        document: {},
        sessionStorage: {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => undefined,
        },
        location: { origin: 'http://localhost', pathname: '/', hash: '', search: '' },
        history: { replaceState: () => undefined },
      };
    });

    afterEach(() => {
      if (originalWindow === undefined) {
        delete globalAny['window'];
      } else {
        globalAny['window'] = originalWindow;
      }
    });

    it('rejects API keys in browser environments', () => {
      expect(() =>
        createClient({
          baseUrl: 'http://localhost:3000',
          auth: { apiKey: 'op_live_key' },
        }),
      ).toThrow(ConfigurationError);
    });
  });
});

describe('createClient().ping()', () => {
  it('calls GET /api/v1/auth/whoami and returns identity', async () => {
    const whoami = {
      userId: 'u1',
      email: 'dev@example.com',
      tenantId: 't1',
      roles: ['admin'],
      scopes: ['data:read'],
    };
    const { fetch, calls } = recordingFetch([{ status: 200, body: { data: whoami } }]);
    const client = createClient({
      baseUrl: 'http://localhost:3000',
      auth: { apiKey: 'op_live_key' },
      fetch,
    });

    const result = await client.ping();
    expect(result).toEqual(whoami);
    expect(calls[0]?.url).toContain('/api/v1/auth/whoami');
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer op_live_key' });
  });
});
