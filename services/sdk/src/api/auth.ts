/**
 * Authentication API
 */

import type { HttpClient } from '../utils/http.js';
import type { ResolvedConfig } from '../config.js';
import type { NonceResponse, AuthVerifyResponse, User } from '../types/models.js';
import {
  createSiweMessageString,
  type CreateSiweMessageParams,
  SessionManager,
  type MessageSigner,
} from '../auth/index.js';
import { normalizeAddress } from '../utils/validation.js';

/**
 * Authentication API client
 */
export class AuthAPI {
  private readonly session: SessionManager;

  constructor(
    private readonly http: HttpClient,
    config: ResolvedConfig
  ) {
    this.session = new SessionManager(config.tokenStorage);
  }

  /**
   * Get a nonce for SIWE authentication
   *
   * @param address - Ethereum address
   * @returns Nonce and expiration time
   */
  async getNonce(address: string): Promise<NonceResponse> {
    const normalizedAddress = normalizeAddress(address);
    return this.http.get<NonceResponse>('/auth/nonce', { address: normalizedAddress });
  }

  /**
   * Verify SIWE signature and get JWT token
   *
   * @param message - The SIWE message that was signed
   * @param signature - The signature from the wallet
   * @returns JWT token and user info
   */
  async verify(message: string, signature: string): Promise<AuthVerifyResponse> {
    const result = await this.http.post<AuthVerifyResponse>('/auth/verify', {
      message,
      signature,
    });

    // Store session
    this.session.setSession(result.token, result.user.address);

    return result;
  }

  /**
   * High-level sign-in method that handles the full SIWE flow
   *
   * @param address - Ethereum address to sign in with
   * @param signer - Message signer (use createViemSigner or createWagmiSigner)
   * @param options - Optional SIWE message parameters
   * @returns JWT token and user info
   *
   * @example
   * ```ts
   * import { createViemSigner } from '@grails/sdk';
   *
   * const signer = createViemSigner(walletClient);
   * const { token, user } = await grails.auth.signIn(address, signer);
   * ```
   */
  async signIn(
    address: string,
    signer: MessageSigner,
    options?: Partial<Omit<CreateSiweMessageParams, 'address' | 'nonce'>>
  ): Promise<AuthVerifyResponse> {
    const normalizedAddress = normalizeAddress(address);

    // Step 1: Get nonce from server
    const { nonce, expiresAt } = await this.getNonce(normalizedAddress);

    // Step 2: Create SIWE message
    const message = createSiweMessageString({
      address: normalizedAddress,
      nonce,
      expirationTime: expiresAt,
      ...options,
    });

    // Step 3: Sign message with wallet
    const signature = await signer.signMessage(message);

    // Step 4: Verify signature with server
    return this.verify(message, signature);
  }

  /**
   * Get current authenticated user
   *
   * @returns Current user info
   * @throws {UnauthorizedError} if not authenticated
   */
  async me(): Promise<User> {
    return this.http.get<User>('/auth/me');
  }

  /**
   * Logout and clear session
   */
  async logout(): Promise<void> {
    try {
      await this.http.post('/auth/logout');
    } finally {
      // Always clear local session, even if API call fails
      this.session.clearSession();
    }
  }

  /**
   * Check if user is currently authenticated
   */
  isAuthenticated(): boolean {
    return this.session.isAuthenticated() && !this.session.isTokenExpired();
  }

  /**
   * Get the current user's address
   */
  getAddress(): string | null {
    return this.session.getAddress();
  }

  /**
   * Get the current auth token
   */
  getToken(): string | null {
    return this.session.getToken();
  }
}
