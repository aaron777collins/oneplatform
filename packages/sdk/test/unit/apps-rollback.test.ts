/**
 * Unit tests for AppNamespace.rollback().
 *
 * Tests are isolated from HTTP by injecting a mock Transport. This lets us
 * verify the correct route, method, and request body without a running server.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAppNamespace } from '../../src/resources/apps.js';
import type { RollbackResult } from '../../src/resources/apps.js';
import type { Transport } from '../../src/transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransport(impl: Partial<Transport> = {}): Transport {
  return {
    request: vi.fn(),
    requestMultipart: vi.fn(),
    ...impl,
  } as unknown as Transport;
}

const ROLLBACK_RESULT: RollbackResult = {
  appId: 'app-123',
  fromBuildId: 'build-current-abc',
  toBuildId: 'build-target-xyz',
  rolledBackAt: '2026-06-17T10:00:00.000Z',
};

// ---------------------------------------------------------------------------
// rollback()
// ---------------------------------------------------------------------------

describe('AppNamespace.rollback()', () => {
  it('POSTs to /api/v1/apps/:appId/rollback with the buildId in the body', async () => {
    const transport = makeTransport({
      request: vi.fn().mockResolvedValue(ROLLBACK_RESULT),
    });
    const apps = createAppNamespace(transport);

    const result = await apps.rollback('app-123', { buildId: 'build-target-xyz' });

    expect(transport.request).toHaveBeenCalledOnce();
    expect(transport.request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/v1/apps/app-123/rollback',
      body: { buildId: 'build-target-xyz' },
    });
    expect(result).toEqual(ROLLBACK_RESULT);
  });

  it('URL-encodes an appId that contains special characters', async () => {
    const transport = makeTransport({
      request: vi.fn().mockResolvedValue(ROLLBACK_RESULT),
    });
    const apps = createAppNamespace(transport);

    await apps.rollback('app/with spaces', { buildId: 'build-target-xyz' });

    const [call] = (transport.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(call[0].path).toBe('/api/v1/apps/app%2Fwith%20spaces/rollback');
  });

  it('returns the RollbackResult shape from the server response', async () => {
    const transport = makeTransport({
      request: vi.fn().mockResolvedValue(ROLLBACK_RESULT),
    });
    const apps = createAppNamespace(transport);

    const result = await apps.rollback('app-123', { buildId: 'build-target-xyz' });

    // Verify every field of RollbackResult is passed through as-is.
    expect(result.appId).toBe('app-123');
    expect(result.fromBuildId).toBe('build-current-abc');
    expect(result.toBuildId).toBe('build-target-xyz');
    expect(result.rolledBackAt).toBe('2026-06-17T10:00:00.000Z');
  });

  it('propagates transport errors to the caller', async () => {
    const networkFailure = new Error('Network timeout');
    const transport = makeTransport({
      request: vi.fn().mockRejectedValue(networkFailure),
    });
    const apps = createAppNamespace(transport);

    await expect(apps.rollback('app-123', { buildId: 'build-target-xyz' })).rejects.toThrow(
      'Network timeout',
    );
  });

  it('does not call requestMultipart (rollback is JSON, not multipart)', async () => {
    const transport = makeTransport({
      request: vi.fn().mockResolvedValue(ROLLBACK_RESULT),
    });
    const apps = createAppNamespace(transport);

    await apps.rollback('app-123', { buildId: 'build-target-xyz' });

    expect(transport.requestMultipart).not.toHaveBeenCalled();
  });
});
