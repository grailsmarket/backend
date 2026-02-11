/**
 * Error exports
 */

export {
  GrailsError,
  GrailsAPIError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  RateLimitError,
  NetworkError,
  TimeoutError,
  createAPIError,
  type APIErrorDetails,
} from './api-error.js';

export {
  AuthError,
  NonceExpiredError,
  InvalidNonceError,
  InvalidSignatureError,
  TokenExpiredError,
  NotAuthenticatedError,
} from './auth-error.js';
