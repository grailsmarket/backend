import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Mutelist Service
 *
 * Manages a list of Ethereum addresses to filter from WebSocket activity broadcasts.
 * Keeps addresses in memory for fast lookups without hitting the database on every event.
 */
class MutelistService {
  private mutedAddresses: Set<string> = new Set();
  private initialized: boolean = false;

  /**
   * Initialize the mutelist by loading all addresses from the database
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('MutelistService already initialized');
      return;
    }

    try {
      const pool = getPostgresPool();
      const result = await pool.query('SELECT address FROM mutelist');

      this.mutedAddresses.clear();

      for (const row of result.rows) {
        // Normalize to lowercase for consistent matching
        this.mutedAddresses.add(row.address.toLowerCase());
      }

      this.initialized = true;
      logger.info({ count: this.mutedAddresses.size }, 'MutelistService initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize MutelistService');
      throw error;
    }
  }

  /**
   * Check if an address is on the mutelist
   */
  isMuted(address: string | null | undefined): boolean {
    if (!address) return false;
    return this.mutedAddresses.has(address.toLowerCase());
  }

  /**
   * Check if any address in an array is muted
   */
  isAnyMuted(...addresses: (string | null | undefined)[]): boolean {
    return addresses.some(addr => this.isMuted(addr));
  }

  /**
   * Reload the mutelist from the database
   * Can be called manually if the list is updated externally
   */
  async reload(): Promise<void> {
    try {
      const pool = getPostgresPool();
      const result = await pool.query('SELECT address FROM mutelist');

      const oldCount = this.mutedAddresses.size;
      this.mutedAddresses.clear();

      for (const row of result.rows) {
        this.mutedAddresses.add(row.address.toLowerCase());
      }

      logger.info(
        { oldCount, newCount: this.mutedAddresses.size },
        'MutelistService reloaded'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to reload MutelistService');
      throw error;
    }
  }

  /**
   * Get the count of muted addresses
   */
  getCount(): number {
    return this.mutedAddresses.size;
  }

  /**
   * Check if the service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Export singleton instance
export const mutelistService = new MutelistService();
