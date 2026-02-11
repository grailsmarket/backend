/**
 * Authentication Error Classes
 */

import { GrailsError } from './api-error.js';

/**
 * Base authentication error
 */
export class AuthError extends GrailsError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Nonce expired error - thrown when SIWE nonce has expired
 */
export class NonceExpiredError extends AuthError {
  constructor(message = 'Nonce has expired') {
    super(message);
    this.name = 'NonceExpiredError';
  }
}

/**
 * Invalid nonce error - thrown when SIWE nonce is invalid or already used
 */
export class InvalidNonceError extends AuthError {
  constructor(message = 'Invalid or already used nonce') {
    super(message);
    this.name = 'InvalidNonceError';
  }
}

/**
 * Invalid signature error - thrown when SIWE signature verification fails
 */
export class InvalidSignatureError extends AuthError {
  constructor(message = 'Invalid signature') {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

/**
 * Token expired error - thrown when JWT token has expired
 */
export class TokenExpiredError extends AuthError {
  constructor(message = 'Token has expired') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

/**
 * Not authenticated error - thrown when action requires authentication
 */
export class NotAuthenticatedError extends AuthError {
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}
