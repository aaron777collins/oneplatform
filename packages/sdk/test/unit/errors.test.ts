/**
 * Unit tests for the error hierarchy.
 * Covers HTTP status → error class mapping, retryable flags, and ValidationError.fieldErrors.
 */

import { describe, it, expect } from 'vitest';
import {
  OnePlatformError,
  ClientError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  CursorExpiredError,
  ConfigurationError,
  PaginationLimitError,
  RateLimitError,
  ServerError,
  NetworkError,
} from '../../src/errors/index.js';

describe('OnePlatformError base class', () => {
  it('preserves prototype chain for instanceof checks', () => {
    const err = new ServerError({ code: 'ERR', message: 'test', retryable: true });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OnePlatformError);
    expect(err).toBeInstanceOf(ServerError);
  });

  it('toJSON excludes the response object', () => {
    const err = new AuthError({
      code: 'UNAUTHORIZED',
      message: 'Not allowed',
      statusCode: 401,
      retryable: false,
    });
    const json = err.toJSON();
    expect(json).not.toHaveProperty('response');
    expect(json.code).toBe('UNAUTHORIZED');
    expect(json.statusCode).toBe(401);
  });
});

describe('Error retryable flags', () => {
  it.each([
    [new ClientError({ code: 'E', message: 'm', retryable: false }), false],
    [new AuthError({ code: 'UNAUTHORIZED', message: 'm', retryable: false }), false],
    [new ForbiddenError({ code: 'FORBIDDEN', message: 'm', retryable: false }), false],
    [new NotFoundError({ code: 'NOT_FOUND', message: 'm', retryable: false }), false],
    [new ConflictError({ code: 'CONFLICT', message: 'm', retryable: false }), false],
    [new ValidationError({ code: 'VALIDATION_ERROR', message: 'm', retryable: false }), false],
    [new CursorExpiredError({ code: 'CURSOR_EXPIRED', message: 'm', retryable: false }), false],
    [new ConfigurationError('bad config'), false],
    [new RateLimitError({ code: 'RATE_LIMIT', message: 'm', retryable: true, retryAfterSeconds: null }), true],
    [new ServerError({ code: 'INTERNAL_ERROR', message: 'm', retryable: true }), true],
    [new NetworkError({ message: 'timeout', reason: 'timeout', timeoutMs: 5000 }), true],
  ])('%s.retryable is %s', (err, expected) => {
    expect(err.retryable).toBe(expected);
  });
});

describe('ValidationError.fieldErrors', () => {
  it('returns per-field errors from details.fields', () => {
    const err = new ValidationError({
      code: 'VALIDATION_ERROR',
      message: 'Invalid',
      retryable: false,
      details: {
        fields: {
          email: ['Must be a valid email'],
          name: ['Required', 'Too short'],
        },
      },
    });
    expect(err.fieldErrors).toEqual({
      email: ['Must be a valid email'],
      name: ['Required', 'Too short'],
    });
  });

  it('returns empty object when no details', () => {
    const err = new ValidationError({ code: 'V', message: 'm', retryable: false });
    expect(err.fieldErrors).toEqual({});
  });
});

describe('RateLimitError', () => {
  it('stores retryAfterSeconds', () => {
    const err = new RateLimitError({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too fast',
      retryable: true,
      statusCode: 429,
      retryAfterSeconds: 30,
    });
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.statusCode).toBe(429);
  });

  it('allows null retryAfterSeconds', () => {
    const err = new RateLimitError({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too fast',
      retryable: true,
      retryAfterSeconds: null,
    });
    expect(err.retryAfterSeconds).toBeNull();
  });
});

describe('NetworkError', () => {
  it('stores timeout details', () => {
    const err = new NetworkError({ message: 'timed out', reason: 'timeout', timeoutMs: 30000 });
    expect(err.reason).toBe('timeout');
    expect(err.timeoutMs).toBe(30000);
    expect(err.code).toBe('SDK_NETWORK_ERROR');
  });
});

describe('ConfigurationError', () => {
  it('has SDK_CONFIGURATION_ERROR code', () => {
    const err = new ConfigurationError('bad config');
    expect(err.code).toBe('SDK_CONFIGURATION_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBeUndefined();
  });
});

describe('PaginationLimitError', () => {
  it('stores the limit', () => {
    const err = new PaginationLimitError('too many', 10000);
    expect(err.limit).toBe(10000);
    expect(err.code).toBe('PAGINATION_LIMIT_EXCEEDED');
  });
});
