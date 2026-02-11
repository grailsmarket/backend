/**
 * Session management
 */

import type { TokenStorage } from '../config.js';

/**
 * Session manager for handling authentication state
 */
export class SessionManager {
  constructor(private readonly storage: TokenStorage) {}

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.storage.getToken() !== null;
  }

  /**
   * Get the current auth token
   */
  getToken(): string | null {
    return this.storage.getToken();
  }

  /**
   * Set the auth token
   */
  setToken(token: string): void {
    this.storage.setToken(token);
  }

  /**
   * Clear the auth token
   */
  clearToken(): void {
    this.storage.clearToken();
  }

  /**
   * Get the current user address
   */
  getAddress(): string | null {
    return this.storage.getAddress();
  }

  /**
   * Set the user address
   */
  setAddress(address: string): void {
    this.storage.setAddress(address.toLowerCase());
  }

  /**
   * Clear the user address
   */
  clearAddress(): void {
    this.storage.clearAddress();
  }

  /**
   * Store session data after successful authentication
   */
  setSession(token: string, address: string): void {
    this.setToken(token);
    this.setAddress(address);
  }

  /**
   * Clear all session data
   */
  clearSession(): void {
    this.clearToken();
    this.clearAddress();
  }

  /**
   * Check if token is expired (basic JWT check)
   * Note: This only checks expiry, not signature validity
   */
  isTokenExpired(): boolean {
    const token = this.getToken();
    if (!token) {
      return true;
    }

    try {
      // JWT format: header.payload.signature
      const parts = token.split('.');
      if (parts.length !== 3) {
        return true;
      }

      // Decode payload (base64url)
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf-8')
      );

      // Check exp claim
      if (payload.exp) {
        const expiryTime = payload.exp * 1000; // Convert to milliseconds
        return Date.now() >= expiryTime;
      }

      // No exp claim, assume not expired
      return false;
    } catch {
      // If we can't parse the token, assume expired
      return true;
    }
  }
}
