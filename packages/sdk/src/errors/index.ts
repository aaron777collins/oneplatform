export { OnePlatformError } from './base.js';
export type { OnePlatformErrorOptions } from './base.js';

export {
  ClientError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  CursorExpiredError,
  ConfigurationError,
  PaginationLimitError,
} from './client-errors.js';
export type {
  ValidationFieldError,
  ValidationConstraintViolation,
  ValidationErrorOptions,
} from './client-errors.js';

export { RateLimitError } from './rate-limit-error.js';
export type { RateLimitErrorOptions } from './rate-limit-error.js';

export { ServerError } from './server-error.js';

export { NetworkError } from './network-error.js';
export type { NetworkErrorReason, NetworkErrorOptions } from './network-error.js';
