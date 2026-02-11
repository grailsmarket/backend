/**
 * Grails SDK Client
 */

import { type GrailsClientOptions, resolveConfig, type ResolvedConfig } from './config.js';
import { HttpClient } from './utils/http.js';
import { AuthAPI } from './api/auth.js';
import { ListingsAPI } from './api/listings.js';
import { OffersAPI } from './api/offers.js';
import { OrdersAPI } from './api/orders.js';
import { NamesAPI } from './api/names.js';
import { SearchAPI } from './api/search.js';

/**
 * Grails ENS Marketplace SDK Client
 *
 * @example
 * ```ts
 * import { GrailsClient, createViemSigner } from '@grails/sdk';
 *
 * // Create client
 * const grails = new GrailsClient();
 *
 * // Search for names
 * const results = await grails.search.search({
 *   q: 'vitalik',
 *   showListings: true,
 * });
 *
 * // Sign in with wallet
 * const signer = createViemSigner(walletClient);
 * await grails.auth.signIn(address, signer);
 *
 * // Get current user
 * const user = await grails.auth.me();
 * ```
 */
export class GrailsClient {
  private readonly config: ResolvedConfig;
  private readonly http: HttpClient;

  /** Authentication API */
  readonly auth: AuthAPI;

  /** Listings API */
  readonly listings: ListingsAPI;

  /** Offers API */
  readonly offers: OffersAPI;

  /** Orders API */
  readonly orders: OrdersAPI;

  /** Names API */
  readonly names: NamesAPI;

  /** Search API */
  readonly search: SearchAPI;

  /**
   * Create a new Grails SDK client
   *
   * @param options - Client configuration options
   */
  constructor(options?: GrailsClientOptions) {
    this.config = resolveConfig(options);
    this.http = new HttpClient(this.config);

    // Initialize API modules
    this.auth = new AuthAPI(this.http, this.config);
    this.listings = new ListingsAPI(this.http);
    this.offers = new OffersAPI(this.http);
    this.orders = new OrdersAPI(this.http);
    this.names = new NamesAPI(this.http);
    this.search = new SearchAPI(this.http);
  }

  /**
   * Check if user is currently authenticated
   */
  get isAuthenticated(): boolean {
    return this.auth.isAuthenticated();
  }

  /**
   * Get the current user's address
   */
  get userAddress(): string | null {
    return this.auth.getAddress();
  }

  /**
   * Logout and clear session
   */
  async logout(): Promise<void> {
    await this.auth.logout();
  }
}
