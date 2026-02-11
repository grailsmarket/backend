/**
 * API Error Classes
 */

/**
 * Base error class for all Grails SDK errors
 */
export class GrailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrailsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error details from API response
 */
export interface APIErrorDetails {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * API error - thrown when the API returns an error response
 */
export class GrailsAPIError extends GrailsError {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    statusCode: number,
    error: APIErrorDetails,
    requestId?: string
  ) {
    super(error.message);
    this.name = 'GrailsAPIError';
    this.statusCode = statusCode;
    this.code = error.code;
    this.details = error.details;
    this.requestId = requestId;
  }
}

/**
 * Resource not found error (404)
 */
export class NotFoundError extends GrailsAPIError {
  constructor(message: string, code = 'NOT_FOUND', requestId?: string) {
    super(404, { code, message }, requestId);
    this.name = 'NotFoundError';
  }
}

/**
 * Unauthorized error (401)
 */
export class UnauthorizedError extends GrailsAPIError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED', requestId?: string) {
    super(401, { code, message }, requestId);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Forbidden error (403)
 */
export class ForbiddenError extends GrailsAPIError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN', requestId?: string) {
    super(403, { code, message }, requestId);
    this.name = 'ForbiddenError';
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends GrailsAPIError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super(400, { code: 'VALIDATION_ERROR', message, details }, requestId);
    this.name = 'ValidationError';
  }
}

/**
 * Rate limit exceeded error (429)
 */
export class RateLimitError extends GrailsAPIError {
  readonly retryAfter?: number;

  constructor(message = 'Rate limit exceeded', retryAfter?: number, requestId?: string) {
    super(429, { code: 'RATE_LIMIT_EXCEEDED', message }, requestId);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Network error - thrown when unable to reach the API
 */
export class NetworkError extends GrailsError {
  readonly cause?: Error;

  constructor(message = 'Network error', cause?: Error) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Timeout error - thrown when request times out
 */
export class TimeoutError extends GrailsError {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Create appropriate error from API response
 */
export function createAPIError(
  statusCode: number,
  error: APIErrorDetails,
  requestId?: string,
  retryAfter?: number
): GrailsAPIError {
  switch (statusCode) {
    case 400:
      return new ValidationError(error.message, error.details, requestId);
    case 401:
      return new UnauthorizedError(error.message, error.code, requestId);
    case 403:
      return new ForbiddenError(error.message, error.code, requestId);
    case 404:
      return new NotFoundError(error.message, error.code, requestId);
    case 429:
      return new RateLimitError(error.message, retryAfter, requestId);
    default:
      return new GrailsAPIError(statusCode, error, requestId);
  }
}
